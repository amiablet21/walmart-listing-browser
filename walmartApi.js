// Walmart Marketplace API client (main process).
//
// Authenticates with the seller's Client ID / Client Secret (OAuth
// client-credentials grant, 15-minute tokens) and reads Buy Box data through
// the Pricing Insights endpoint — the only official way to pull Buy Box
// pricing on demand for specific SKUs.
//
//   POST /v3/token                      → access token (cached until expiry)
//   POST /v3/price/getPricingInsights   → per-SKU buy box / competitor / repricer data
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
  async call(method, path, payload) {
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
      if (res.status === 429 && attempt < MAX_RETRIES_429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      throw new WalmartApiError(describeError(res.status, body), res.status, body);
    }
  }

  // Confirms the credentials work by minting a token.
  async testConnection() {
    await this.getToken(true);
    return { ok: true, host: this.host };
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

module.exports = { WalmartClient, WalmartApiError, normalizeInsight, HOSTS };
