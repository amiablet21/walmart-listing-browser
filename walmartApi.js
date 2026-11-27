// Walmart Marketplace API client (main process).
//
// Authenticates with the seller's Client ID / Client Secret (OAuth
// client-credentials grant, 15-minute tokens) and reads Buy Box data through
// the Pricing Insights endpoint — the only official way to pull Buy Box
// pricing on demand for specific SKUs.
//
//   POST /v3/token                      → access token (cached until expiry)
//   POST /v3/price/getPricingInsights   → per-SKU buy box / competitor / repricer data
//   GET  /v3/price/incentives           → items with a price incentive (Walmart-funded, reduced referral fee)
//   POST /v3/repricerFeeds              → put items on / take them off a repricer strategy, with min and max
//   GET  /v3/feeds/{feedId}             → what became of such an upload
//
// Every call carries the Basic auth header plus WM_SEC.ACCESS_TOKEN, a fresh
// WM_QOS.CORRELATION_ID GUID, and WM_SVC.NAME, as the API reference requires.

const crypto = require("crypto");

const HOSTS = {
  production: "https://marketplace.walmartapis.com",
  sandbox: "https://sandbox.walmartapis.com",
};
const SVC_NAME = "Walmart Marketplace";
const TOKEN_SKEW_MS = 60_000;      // refresh a minute before Walmart expires it
const SKUS_PER_REQUEST = 20;       // searchCriteria batch size (kept modest)
const MAX_RETRIES_429 = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WalmartApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "WalmartApiError";
    this.status = status;
    this.body = body;
  }
}

// Pull a human-readable message out of Walmart's error envelope, which comes
// in a few shapes: { errors: [{ code, description, info }] },
// { error: [{ code, description }] }, or { error, error_description }.
function describeError(status, body) {
  const list = Array.isArray(body?.errors) ? body.errors
    : Array.isArray(body?.error) ? body.error
    : Array.isArray(body?.errors?.error) ? body.errors.error : null;
  const first = list?.[0];
  const detail = first?.description || first?.info || first?.code
    || body?.error_description || body?.error || body?.message || "";
  if (status === 401) return "Walmart rejected the Client ID / Client Secret (401)." + (detail ? ` ${detail}` : "");
  if (status === 403) return "This API isn't enabled for your key (403). In the Developer Portal, make sure the key has Price / Insights permissions." + (detail ? ` ${detail}` : "");
  if (status === 429) return "Walmart rate limit hit (429). Wait a minute and try again.";
  return `Walmart API error ${status}${detail ? `: ${detail}` : ""}`;
}

class WalmartClient {
  constructor({ clientId, clientSecret, env } = {}) {
    this.clientId = String(clientId ?? "").trim();
    this.clientSecret = String(clientSecret ?? "").trim();
    this.host = HOSTS[env === "sandbox" ? "sandbox" : "production"];
    this.token = null;
    this.tokenExpires = 0;
    this.incentivePaceMs = 21_000;   // 3 requests a minute, with a little room
    this.incentiveRetryMs = 30_000;  // after a 429
    this.insightsPaceMs = 31_000;    // Pricing Insights, once Walmart has asked to slow down
    if (!this.clientId || !this.clientSecret) {
      throw new WalmartApiError("Add your Walmart Client ID and Client Secret first.", 0);
    }
  }

  baseHeaders() {
    return {
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
      "WM_SVC.NAME": SVC_NAME,
      "WM_QOS.CORRELATION_ID": crypto.randomUUID(),
    };
  }

  async fetchJson(url, init) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new WalmartApiError(`Couldn't reach Walmart (${e.message || e}). Check your internet connection.`, 0);
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
    return { res, body };
  }

  async getToken(force = false) {
    if (!force && this.token && Date.now() < this.tokenExpires - TOKEN_SKEW_MS) return this.token;
    const { res, body } = await this.fetchJson(`${this.host}/v3/token`, {
      method: "POST",
      headers: { ...this.baseHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok || !body?.access_token) throw new WalmartApiError(describeError(res.status, body), res.status, body);
    this.token = body.access_token;
    const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 900_000;
    this.tokenExpires = Date.now() + ttl;
    return this.token;
  }

  // Authenticated call. Refreshes the token once on a 401 and backs off on 429.
  // opts.retry429 false leaves a rate-limit answer to the caller (an endpoint
  // limited to a few requests a minute needs a long wait, not quick retries).
  async call(method, path, payload, opts = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const { res, body } = await this.fetchJson(`${this.host}${path}`, {
        method,
        headers: {
          ...this.baseHeaders(),
          "WM_SEC.ACCESS_TOKEN": token,
          ...(payload != null ? { "Content-Type": "application/json" } : {}),
        },
        body: payload != null ? JSON.stringify(payload) : undefined,
      });
      if (res.ok) return body;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if (res.status === 429 && opts.retry429 !== false && attempt < MAX_RETRIES_429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      throw new WalmartApiError(describeError(res.status, body), res.status, body);
    }
  }

  // Confirms the credentials work by minting a token, then that the key can
  // call Pricing Insights (a key without that permission still gets a token).
  // `items` is how many items Walmart has insights for in this account.
  async testConnection() {
    await this.getToken(true);
    const body = await this.call("POST", "/v3/price/getPricingInsights", { pageNumber: 0 });
    return { ok: true, host: this.host, items: num(body?.pageContext?.totalCount) };
  }

  // Pricing Insights for the given SKUs → { bySku: { SKU: insight }, missing: [SKU] }.
  // Walmart only knows the SKUs in this seller's catalog; anything else lands
  // in `missing`. onProgress(done, total) fires after each batch.
  async pricingInsights(skus, onProgress) {
    const wanted = [...new Set((skus || []).map((s) => String(s ?? "").trim()).filter(Boolean))];
    const bySku = {};
    let done = 0;
    for (let i = 0; i < wanted.length; i += SKUS_PER_REQUEST) {
      const batch = wanted.slice(i, i + SKUS_PER_REQUEST);
      for (let page = 0, pages = 1; page < pages && page < 50; page++) {
        const body = await this.call("POST", "/v3/price/getPricingInsights", {
          pageNumber: page,
          searchCriteria: { searchField: "SKU", searchValue: batch },
        });
        const list = Array.isArray(body?.pricingInsightsResponseList) ? body.pricingInsightsResponseList : [];
        for (const row of list) {
          const sku = String(row?.sku ?? "").trim();
          if (sku) bySku[sku] = normalizeInsight(row);
        }
        pages = Number(body?.pageContext?.totalPages) || 1;
      }
      done += batch.length;
      if (typeof onProgress === "function") onProgress(done, wanted.length);
    }
    const missing = wanted.filter((s) => !bySku[s]);
    return { bySku, missing };
  }

  // Each SKU's repricer settings as Walmart has them now → { bySku, missing }.
  // Same Pricing Insights call as above, but paced for its rate limit: it
  // starts without waiting and, the first time Walmart answers 429, switches
  // to one request every half minute for the rest of the read.
  async repricerState(skus, onProgress) {
    const wanted = [...new Set((skus || []).map((s) => String(s ?? "").trim()).filter(Boolean))];
    const bySku = {};
    let done = 0, pace = 0, requests = 0;
    for (let i = 0; i < wanted.length; i += SKUS_PER_REQUEST) {
      const batch = wanted.slice(i, i + SKUS_PER_REQUEST);
      for (let page = 0, pages = 1; page < pages && page < 50; page++) {
        if (pace && requests > 0) await sleep(pace);
        let body = null;
        for (let attempt = 0; ; attempt++) {
          try { requests++; body = await this.call("POST", "/v3/price/getPricingInsights", { pageNumber: page, searchCriteria: { searchField: "SKU", searchValue: batch } }, { retry429: false }); break; }
          catch (e) {
            if (e.status !== 429 || attempt >= 5) throw e;
            pace = this.insightsPaceMs;
            if (typeof onProgress === "function") onProgress(done, wanted.length, true);
            await sleep(this.insightsPaceMs);
          }
        }
        const list = Array.isArray(body?.pricingInsightsResponseList) ? body.pricingInsightsResponseList : [];
        for (const row of list) {
          const sku = String(row?.sku ?? "").trim();
          if (!sku) continue;
          const n = normalizeInsight(row);
          bySku[sku] = { sku, strategy: n.repricerStrategy ? String(n.repricerStrategy).trim() : "", min: n.repricerMin, max: n.repricerMax, price: n.currentPrice,
            status: n.repricerStatus ?? null, buyBoxPrice: n.buyBoxPrice, inventory: n.inventory, name: n.itemName };
        }
        pages = Number(body?.pageContext?.totalPages) || 1;
      }
      done += batch.length;
      if (typeof onProgress === "function") onProgress(done, wanted.length, false);
    }
    return { bySku, missing: wanted.filter((s) => !bySku[s]) };
  }

  // Put items on a strategy (with min and max), or take them off one.
  //   items: [{ sku, strategy, min, max }] — an empty strategy takes the item off
  // Walmart takes this as an upload ("feed") it works through afterwards, and
  // answers with a feed ID to ask about later. At most one a 10 minutes.
  async sendRepricerFeed(items) {
    const body = repricerFeedBody(items);
    const res = await this.call("POST", "/v3/repricerFeeds", body, { retry429: false });
    const feedId = res?.feedId ?? res?.feedID ?? res?.payload?.feedId ?? null;
    if (!feedId) throw new WalmartApiError("Walmart accepted the upload but gave no feed ID to follow it with.", 200, res);
    return { feedId: String(feedId), sent: body.Item.length };
  }

  // What became of an upload → { status, received, succeeded, failed, processing, items: [{ sku, ok, error }] }.
  async feedStatus(feedId) {
    const body = await this.call("GET", `/v3/feeds/${encodeURIComponent(feedId)}?includeDetails=true&limit=1000&offset=0`, null, { retry429: false });
    return normalizeFeedStatus(body);
  }

  // Items with a Walmart-funded incentive → { items: [incentive], raw: [first page of each status] }.
  //
  //   GET /v3/price/incentives?incentiveType=WALMART_FUNDED&incentiveStatus=ENROLLED|ELIGIBLE&limit=200&offset=N
  //
  // Both statuses are read: ENROLLED is the incentive in effect, ELIGIBLE one
  // the item could get. Walmart allows 3 requests a minute on this endpoint
  // (since Oct 27, 2026), so requests are spaced out and a 429 waits and tries
  // the same page again. onProgress(text) reports where it is.
  async priceIncentives(onProgress) {
    const say = (t) => { if (typeof onProgress === "function") onProgress(t); };
    const items = [], raw = [];
    let requests = 0;
    for (const status of ["ENROLLED", "ELIGIBLE"]) {
      for (let offset = 0, page = 0; page < INCENTIVE_MAX_PAGES; page++) {
        if (requests++ > 0) await sleep(this.incentivePaceMs);
        say(`Reading ${status === "ENROLLED" ? "enrolled" : "eligible"} Walmart-funded items${page ? ` (page ${page + 1})` : ""}…`);
        const query = `incentiveType=WALMART_FUNDED&incentiveStatus=${status}&limit=${INCENTIVE_PAGE}&offset=${offset}`;
        let body = null;
        for (let attempt = 0; ; attempt++) {
          try { body = await this.call("GET", `/v3/price/incentives?${query}`, null, { retry429: false }); break; }
          catch (e) {
            if (e.status !== 429 || attempt >= 4) throw e;
            say("Walmart asked to slow down — waiting half a minute…");
            await sleep(this.incentiveRetryMs);
          }
        }
        const list = incentiveList(body);
        if (page === 0) raw.push({ status, body: trimBody(body) });
        for (const row of list) {
          const it = normalizeIncentive(row, status);
          // the type filter is trusted only as far as the rows agree with it
          if (it && it.type !== "REDUCED_REFERRAL") items.push(it);
        }
        offset += list.length;
        const total = num(body?.pageContext?.totalCount ?? body?.totalCount);
        if (!list.length || list.length < INCENTIVE_PAGE || (total != null && offset >= total)) break;
      }
    }
    return { items, raw };
  }
}

// ---- repricer feed ---------------------------------------------------------------
// The upload's body, exactly as Walmart's reference gives it. An item with a
// strategy carries its min and max; an item being taken off a strategy carries
// only its SKU ("To unassign, omit this field", says the reference of
// repricerStrategy).
function repricerFeedBody(items) {
  const Item = [];
  for (const it of items || []) {
    const sku = String(it?.sku ?? "").trim();
    if (!sku) continue;
    const strategy = String(it?.strategy ?? "").trim();
    if (!strategy) { Item.push({ Strategy: { sku } }); continue; }
    Item.push({ Strategy: { sku, repricerStrategy: strategy, minimumSellerAllowedPrice: Number(it.min), maximumSellerAllowedPrice: Number(it.max) } });
  }
  return {
    ItemFeedHeader: { processMode: "REPLACE", subset: "EXTERNAL", mart: "WALMART_US", sellingChannel: "repricerstrategy", version: "1.1", locale: "en" },
    Item,
  };
}
function normalizeFeedStatus(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.itemDetails?.itemIngestionStatus ?? b.itemDetails ?? b.items ?? [];
  const items = (Array.isArray(raw) ? raw : []).map((r) => {
    const errs = r?.ingestionErrors?.ingestionError ?? r?.ingestionErrors ?? r?.errors ?? [];
    const first = (Array.isArray(errs) ? errs : [errs]).filter(Boolean)[0];
    const state = String(r?.ingestionStatus ?? r?.status ?? "").toUpperCase();
    return { sku: String(r?.sku ?? r?.skuId ?? "").trim(), state, ok: state === "SUCCESS",
      error: first ? String(first.description ?? first.info ?? first.code ?? first).slice(0, 300) : null };
  }).filter((x) => x.sku);
  return {
    status: String(b.feedStatus ?? b.status ?? "").toUpperCase() || "UNKNOWN",
    received: num(b.itemsReceived), succeeded: num(b.itemsSucceeded), failed: num(b.itemsFailed), processing: num(b.itemsProcessing),
    items,
  };
}

// ---- price incentives ----------------------------------------------------------
// Walmart's two pages on this endpoint show two response shapes: the API
// reference has { pageContext, items: [{ skuId, currentPrice, targetPrice,
// incentiveStatus, startDate, expirationDate … }] }, the guide's Walmart-funded
// sample has { incentives: [{ sku, price, incentivePrice, status,
// incentiveStartDate, incentiveEndDate, fundingSource … }], totalCount }. Both
// are read, field by field, so whichever Walmart sends ends up the same here.
const INCENTIVE_PAGE = 200;       // the endpoint's maximum page size
const INCENTIVE_MAX_PAGES = 25;   // 5,000 items per status is more than any catalog here
function incentiveList(body) {
  for (const k of ["items", "incentives", "incentiveItems", "payload", "data"]) {
    const v = body?.[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const inner = incentiveList(v); if (inner.length) return inner; }
  }
  return Array.isArray(body) ? body : [];
}
// A date as Walmart sends it (epoch milliseconds as a string or number, or an
// ISO date) → epoch milliseconds, or null.
function incentiveDate(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n; // seconds → ms
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}
function normalizeIncentive(r, asked) {
  if (!r || typeof r !== "object") return null;
  const sku = String(r.skuId ?? r.sku ?? r.sellerSku ?? "").trim();
  const itemId = String(r.itemId ?? r.wmItemId ?? "").trim();
  if (!sku && !itemId) return null;
  const typeRaw = String(r.incentiveType ?? (/walmart/i.test(String(r.fundingSource ?? "")) ? "WALMART_FUNDED" : "")).toUpperCase();
  const statusRaw = String(r.incentiveStatus ?? r.status ?? "").toUpperCase();
  const price = num(r.currentPrice ?? r.price);
  const incentivePrice = num(r.incentivePrice ?? r.targetPrice ?? r.priceAfterIncentive);
  return {
    sku, itemId,
    type: typeRaw || "WALMART_FUNDED",
    // what was asked for decides the label; Walmart's own word for it is kept alongside
    status: asked === "ENROLLED" ? "enrolled" : "eligible",
    statusRaw: statusRaw || null,
    price,                                                            // the offer price Walmart reports
    incentivePrice: incentivePrice != null && incentivePrice > 0 ? incentivePrice : null, // the price after the incentive, when given
    shippingPrice: num(r.shippingPrice),
    start: incentiveDate(r.startDate ?? r.incentiveStartDate),
    end: incentiveDate(r.expirationDate ?? r.incentiveEndDate ?? r.endDate),
    enrolledAt: incentiveDate(r.enrollmentDate),
    incentiveId: r.incentiveId ?? null,
    name: r.productName ?? null,
  };
}
// The first few rows of a response, kept for checking what Walmart really sent.
function trimBody(body) {
  try {
    const copy = JSON.parse(JSON.stringify(body ?? null));
    for (const k of ["items", "incentives", "incentiveItems"]) if (Array.isArray(copy?.[k])) copy[k] = copy[k].slice(0, 5);
    return copy;
  } catch { return null; }
}

// Keep just the fields the sheet uses, as plain numbers/strings.
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
function normalizeInsight(r) {
  return {
    itemName: r.itemName ?? null,
    currentPrice: num(r.currentPrice),
    buyBoxPrice: num(r.buyBoxBasePrice),
    buyBoxTotal: num(r.buyBoxTotalPrice),
    winRate: num(r.buyBoxWinRate),
    competitorPrice: num(r.competitorPrice),
    comparisonPrice: num(r.comparisonPrice),
    suggestedPrice: num(r.suggestedPrice),
    suggestedDriver: r.suggestedPriceDriver ?? null,
    priceCompetitive: typeof r.priceCompetitive === "boolean" ? r.priceCompetitive : null,
    fulfillment: r.fulfillment ?? null,
    inventory: num(r.inventoryCount),
    repricerStrategy: r.repricerStrategyName ?? null,
    repricerStatus: r.repricerStatus ?? null,
    repricerMin: num(r.repricerMinPrice),
    repricerMax: num(r.repricerMaxPrice),
    promoStatus: r.promoStatus ?? null,
    at: Date.now(),
  };
}

module.exports = { WalmartClient, WalmartApiError, normalizeInsight, normalizeIncentive, incentiveList, repricerFeedBody, normalizeFeedStatus, HOSTS };
