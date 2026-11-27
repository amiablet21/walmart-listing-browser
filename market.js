// Market tab — Walmart buy box and Amazon buy box side by side, per SKU.
//
// The scan is a full buy box check of the price list's rows: every listing's
// whole seller list with shipping, a screenshot of it, and after the scan a
// results file for other apps. It repeats every few hours. Min / max price
// and inventory come from the Walmart API when keys are saved.
//
//   it.amz = [{ asin, title, price, prime, seller, offers, at, manual, failed, robot }]
//   manual: the price was typed by hand and is never overwritten by a scan.

// ---- tab switching -----------------------------------------------------------
let appTab = ["market", "repricer"].includes(localStorage.getItem("appTab")) ? localStorage.getItem("appTab") : "sheet";
const inMarket = () => appTab === "market";

// The sheet's own docking must stay quiet while the Market tab is up: the
// native Walmart pane would otherwise paint over the market table.
const baseDockListing = dockListing;
dockListing = function () {
  if (appTab !== "sheet") { window.api.hideListing(); return; }
  baseDockListing();
};
const baseRender = render;
render = function () {
  baseRender();
  if (inMarket()) renderMarket();
};

function setTab(t) {
  appTab = ["market", "repricer"].includes(t) ? t : "sheet";
  localStorage.setItem("appTab", appTab);
  document.body.classList.toggle("market-mode", inMarket());
  document.body.classList.toggle("repricer-mode", appTab === "repricer");
  document.querySelectorAll(".app-tabs .app-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === appTab));
  if (inMarket()) {
    window.api.hideListing();
    renderMarket();
  } else if (appTab === "repricer") {
    window.api.hideListing();
    hideAmazonPage();
    if (typeof renderRepricerTab === "function") renderRepricerTab(); // (its script loads after this one)
  } else {
    hideAmazonPage();
    dockListing();
    render();
  }
}
document.querySelectorAll(".app-tabs .app-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

// ---- state -------------------------------------------------------------------
let mSelected = -1;      // index into items
let mFilter = "all";      // all | lost | won | oos | missed (the chips beside the search box)
let mSearch = "";
let mEditing = null;      // { i, k } — Amazon listing whose price is being typed
let mStoreEditing = false; // the store-name line is a field
let mScan = { running: false, done: 0, total: 0, current: "", stop: false, startedAt: 0 };
let mResume = null;       // a stopped full scan: { ids: [still to read], total, scanId, usedApi, startedAt }
let mNotice = "";         // why the last scan paused (robot check), shown where the last-scan line is
let mLastScan = Number(localStorage.getItem("marketLastScan")) || 0;
let mLastScanMs = Number(localStorage.getItem("marketLastScanMs")) || 0;
const AMZ_PAUSE_MS = [2000, 3500]; // breathing room between Amazon pages (random in this range)
const WM_PAUSE_MS = 400;

// Walmart Marketplace API (Pricing Insights). When keys are saved, the scan
// first pulls every SKU's buy box, win rate and suggested price in one batched
// call. Every listing's page is still read, since only the page names who
// holds the buy box.
let apiSettings = { clientId: "", env: "production", hasSecret: false, lastScan: null };
// The Walmart API is switched off: the buy box check reads everything it needs
// from the listings, and the keys dialog is no longer reachable. Keys saved
// earlier stay on disk, unused; API numbers kept from older scans are not shown.
const apiReady = () => false;
// Keys are saved (they are used for one thing: which listings have a Walmart-funded incentive).
const keysReady = () => !!(apiSettings.clientId && apiSettings.hasSecret);

// ---- Walmart-funded incentives -----------------------------------------------------
// From Walmart's price-incentives API (main process). A row is matched by its
// SKU; an incentive that names no SKU is matched by item ID. "enrolled" is an
// incentive in effect (the Funded label); "eligible" is one the item could get.
let wf = { at: 0, bySku: new Map(), byId: new Map(), error: null, errorAt: null, running: false, note: "" };
function setIncentives(d) {
  const bySku = new Map(), byId = new Map();
  for (const x of Array.isArray(d?.items) ? d.items : []) {
    const k = String(x.sku ?? "").trim().toLowerCase();
    const map = k ? bySku : byId, key = k || String(x.itemId ?? "").trim();
    if (!key) continue;
    const have = map.get(key);
    if (!have || (have.status !== "enrolled" && x.status === "enrolled")) map.set(key, x); // an incentive in effect wins
  }
  wf = { ...wf, at: d?.at || 0, bySku, byId, error: d?.error || null, errorAt: d?.errorAt || null };
}
const wfOf = (it) => wf.bySku.get(String(it?.sku ?? "").trim().toLowerCase()) || wf.byId.get(String(it?.itemId ?? "").trim()) || null;
const wfLoaded = () => wf.at > 0;
// The price after the incentive, when Walmart gives one below the offer price.
const wfAfter = (x) => (x && x.incentivePrice > 0 && (!(x.price > 0) || x.incentivePrice < x.price - 0.005) ? x.incentivePrice : null);
const shortDate = (t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
function wfCell(x) {
  if (!x) return `<span class="m-muted">—</span>`;
  if (x.status !== "enrolled") return `<span class="m-pill wf dim" title="Eligible for a Walmart-funded incentive, not in effect">Eligible</span>`;
  const after = wfAfter(x);
  const tip = `Walmart-funded incentive${x.start ? ` · since ${shortDate(x.start)}` : ""}${x.end ? ` · until ${shortDate(x.end)}` : ""}`;
  return `<span class="m-pill wf" title="${esc(tip)}">Funded</span>${after ? `<b>${fmt(after)}</b>${x.price > 0 ? `<s>${fmt(x.price)}</s>` : ""}` : x.end ? `<span class="m-muted">until ${shortDate(x.end)}</span>` : ""}`;
}
let wfRefreshing = null;
function refreshIncentives() {
  if (wfRefreshing) return wfRefreshing;
  if (!keysReady()) return Promise.resolve({ ok: false, error: "Add your Walmart API keys first." });
  wf.running = true; wf.note = "Reading Walmart-funded items…";
  renderIncState();
  wfRefreshing = window.api.incentivesRefresh().catch((e) => ({ ok: false, error: String(e?.message || e) })).then((d) => {
    wfRefreshing = null;
    wf.running = false; wf.note = "";
    if (d && Array.isArray(d.items)) setIncentives(d); else wf.error = d?.error || "The list couldn't be read.";
    renderIncState();
    renderMarket();
    return d;
  });
  return wfRefreshing;
}
window.api.onIncentivesProgress?.((text) => { wf.note = text; renderIncState(); });
function renderIncState() {
  const el = $("incState");
  if (!el) return;
  const funded = [...wf.bySku.values(), ...wf.byId.values()].filter((x) => x.status === "enrolled").length;
  const onList = items.filter((it) => idOf(it) && wfOf(it)?.status === "enrolled").length;
  el.textContent = wf.running ? (wf.note || "Reading…")
    : !keysReady() ? "Marks the listings that have a Walmart-funded incentive. Needs your Walmart API keys."
    : wf.error ? `Couldn't read the list${wfLoaded() ? ` (showing the one from ${when(wf.at)})` : ""}: ${wf.error}`
    : wfLoaded() ? `${funded} item${funded === 1 ? "" : "s"} with an incentive in effect, ${onList} on your price list · read ${when(wf.at)}`
    : "Not read yet.";
  el.classList.toggle("m-warn", !wf.running && !!wf.error);
  $("incRefresh").disabled = wf.running || !keysReady();
}

// ---- buy box check: settings ------------------------------------------------------
// Settings live in the main process (userData); this is the renderer's copy.
let bbx = { settings: { scheduleOn: false, everyHours: 3, shots: true, keepScans: 24 } };
let bbxLoaded = false;
// The repricer's numbers for a row, from the Walmart API's answer for the SKU
// (the scan asks for it when keys are saved): price, min, max, inventory, status.
function rpOf(it) {
  const a = apiOf(it);
  if (!a || (a.repricerMin == null && a.repricerMax == null && a.inventory == null && a.currentPrice == null)) return null;
  return { price: a.currentPrice, min: a.repricerMin, max: a.repricerMax, inventory: a.inventory, status: a.repricerStatus || null, strategy: a.repricerStrategy || null };
}
// The rows a scan visits: every row with an Item ID.
const inScope = (i) => !!String(items[i]?.itemId ?? "").trim();
const round2m = (n) => Math.round(n * 100) / 100;
const fileUrl = (f) => { let u = String(f).replace(/\\/g, "/"); if (!u.startsWith("/")) u = "/" + u; return "file://" + encodeURI(u).replace(/#/g, "%23").replace(/\?/g, "%3F"); };

const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const idOf = (it) => String(it?.itemId ?? "").trim();
const fmt = (n) => (Number.isFinite(n) && n > 0 ? "$" + money(n) : "—");
const when = (t) => {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
};

// ---- Linnworks mapping -----------------------------------------------------------
// Several Walmart SKUs can be one product in Linnworks (one inventory SKU,
// many channel SKUs). With the mapping imported, those rows form a group:
// one set of Amazon links shared by every row in it (mirrored onto each row
// so nothing is lost if a row is deleted), and one parent line in the table.
let lwMap = {};   // walmart channel SKU (lower-case) → Linnworks inventory SKU
let lwMeta = null; // { file, at, pairs, inv }
try { lwMap = JSON.parse(localStorage.getItem("lwMap") || "{}") || {}; } catch { lwMap = {}; }
try { lwMeta = JSON.parse(localStorage.getItem("lwMeta") || "null"); } catch { lwMeta = null; }
const lwOf = (it) => lwMap[String(it?.sku ?? "").trim().toLowerCase()] || null;
const groupKey = (i) => lwOf(items[i]) || String(items[i].sku ?? "").trim() || idOf(items[i]);
const groupMembers = (i) => { const k = groupKey(i); return items.map((_, j) => j).filter((j) => idOf(items[j]) && groupKey(j) === k); };
// copy row i's Amazon links onto every other row of its group
function syncAmz(i) {
  const src = Array.isArray(items[i]?.amz) ? items[i].amz : [];
  for (const j of groupMembers(i)) if (j !== i) items[j].amz = src.map((a) => ({ ...a }));
}
// after a mapping import: every group shares the union of its rows' links
function mergeGroupAmz() {
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    if (!idOf(items[i])) continue;
    const k = groupKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    const members = groupMembers(i);
    if (members.length < 2) continue;
    const union = [];
    for (const j of members) for (const a of amzList(items[j])) {
      const dup = union.find((u) => (a.asin && u.asin === a.asin) || (!a.asin && !u.asin && a.manual && u.manual && u.price === a.price));
      if (!dup) union.push({ ...a });
      else if ((a.at || 0) > (dup.at || 0)) Object.assign(dup, a); // keep the freshest read
    }
    for (const j of members) items[j].amz = union.map((a) => ({ ...a }));
  }
}

// ---- per-row facts -------------------------------------------------------------
function amzList(it) { return Array.isArray(it.amz) ? it.amz : []; }
function amzLow(it) {
  const ps = amzList(it).map((a) => a.price).filter((p) => Number.isFinite(p) && p > 0);
  return ps.length ? Math.min(...ps) : null;
}
// Every seller on the listing, cheapest total (price + shipping) first, with
// its rank. Shipping is null when the listing didn't state it (counted as 0).
function wmSellers(it) {
  const bb = it.buyBox;
  if (!bb?.price) return [];
  const list = Array.isArray(bb.offers) ? bb.offers.map((o) => ({ seller: o.seller, price: o.price, shipping: o.shipping ?? null, shipNote: o.shipNote ?? null })) : [];
  if (bb.seller && !list.some((o) => Math.abs(o.price - bb.price) < 0.005 && String(o.seller).toLowerCase() === String(bb.seller).toLowerCase())) {
    list.unshift({ seller: bb.seller, price: bb.price, shipping: null, shipNote: null });
  }
  for (const o of list) {
    o.total = round2m(o.price + (o.shipping || 0));
    o.isBB = bb.seller ? String(o.seller).toLowerCase() === String(bb.seller).toLowerCase() && Math.abs(o.price - bb.price) < 0.005 : false;
    o.mine = isMyStore(o.seller);
  }
  list.sort((a, b) => a.total - b.total || (b.isBB - a.isBB) || a.price - b.price);
  return list.map((o, k) => ({ ...o, rank: k + 1 }));
}
// Rows sharing one SKU (the API is keyed by SKU, the page by item ID).
function rowsWithSku(sku) {
  const k = String(sku ?? "").trim().toLowerCase();
  return k ? items.map((_, i) => i).filter((i) => String(items[i].sku ?? "").trim().toLowerCase() === k) : [];
}
// Keep an API result on every row with that SKU. Seller names from an older
// page read are dropped (they'd be stale next to a fresh price); the other
// sellers' list is kept but dated so the panel can say where it came from.
function rememberApi(sku, ins, at) {
  for (const i of rowsWithSku(sku)) {
    const prev = items[i].buyBox;
    const offers = Array.isArray(prev?.offers) && prev.offers.length ? prev.offers : [];
    const offersAt = offers.length ? (prev.offersAt ?? prev.at ?? null) : null;
    items[i].buyBox = ins.buyBoxPrice > 0
      ? { price: ins.buyBoxPrice, seller: null, others: prev?.others ?? null, offers, offersAt, offersWhy: null, at, api: ins, apiAt: at, source: "api" }
      : { noBuyBox: true, offers, offersAt, at, api: ins, apiAt: at, source: "api" };
  }
}
function markNotInCatalog(sku, at) {
  for (const i of rowsWithSku(sku)) {
    if (!(items[i].buyBox?.price > 0)) items[i].buyBox = { failed: true, notInCatalog: true, at };
    else items[i].buyBox.notInCatalog = true;
  }
}
const apiOf = (it) => (apiReady() ? it?.buyBox?.api || null : null);

function rowFacts(i) {
  const it = items[i];
  // our price: the sheet's During Incentive, or the repricer list's price for a row that has none
  const rpRow = rpOf(it);
  const during = safe(i, "during") > 0 ? safe(i, "during") : (rpRow?.price > 0 ? rpRow.price : safe(i, "during"));
  const bb = it.buyBox?.price > 0 ? it.buyBox : null;
  const api = bb ? apiOf(it) : null;
  // who holds the buy box: the page names the seller; the API only tells us
  // our own listed price, so "you" means our price is at (or under) the buy box
  const mine = !!(bb && (bb.seller ? isMyStore(bb.seller) : api && api.currentPrice != null && api.currentPrice <= bb.price + 0.005));
  const known = !!(bb && (bb.seller || (api && api.currentPrice != null)));
  const lost = known && !mine;
  const low = amzLow(it);
  const cheaper = low != null && during > 0 && low < during - 0.005;
  const sellers = wmSellers(it);
  const wmLow = sellers.length ? Math.min(...sellers.map((s) => s.price)) : (bb ? bb.price : null);
  const me = sellers.find((s) => s.mine) || null;
  const edge = cheaper ? "red" : lost ? "amber" : bb && mine ? "green" : "none";
  const wmMissed = !!(it.buyBox?.failed && !bb);
  const amzMissed = amzList(it).some((a) => !a.manual && a.asin && (a.failed || a.robot));
  return { it, during, bb, api, mine, lost, known, low, cheaper, sellers, wmLow, edge, linked: amzList(it).length, missed: wmMissed || amzMissed,
    rp: rpRow, me, rank: me ? me.rank : null, oos: !!it.buyBox?.oos, wf: wfOf(it) };
}
// ---- room to raise ---------------------------------------------------------------
// Walmart's repricer lowers a price to win the buy box but never raises it
// back: when the seller you were matching sells out, you keep your low price
// with the next seller far above. A row has room to raise when you hold the
// buy box and the cheapest other seller is at least minGap ($) and minGapPct
// (%) above you (a blank rule is skipped). The suggestion sits `under` ($ or %)
// below that seller, optionally rounded down to .99 and capped at maxRaise.
// All of it is set in the Raise rules dialog.
const RAISE_DEFAULTS = { minGap: 2, minGapPct: 2, under: 0.01, underUnit: "$", round99: false, maxRaise: null };
let raiseRules = { ...RAISE_DEFAULTS };
try { raiseRules = { ...RAISE_DEFAULTS, ...(JSON.parse(localStorage.getItem("raiseRules") || "{}") || {}) }; } catch { /* defaults */ }
const cents = (n) => Math.round(n * 100);
// Suggested price for `current` with the next seller at `next`, under `rules`.
function raiseTarget(current, next, rules = raiseRules) {
  let t = rules.underUnit === "%" ? cents(next * (1 - (Number(rules.under) || 0) / 100)) : cents(next) - cents(Number(rules.under) || 0);
  if (rules.maxRaise > 0) t = Math.min(t, cents(current) + cents(rules.maxRaise));
  if (rules.round99) t = Math.floor((t + 1) / 100) * 100 - 1; // the highest x.99 at or below
  t = Math.min(t, cents(next) - 1); // always stay under the next seller
  return t / 100;
}
// { current, next, nextSeller, gap, gapPct, target, ok } when you hold the buy
// box and another seller is known; { only: true } when Walmart says no one
// else sells it; null otherwise.
function raiseFor(f, rules = raiseRules) {
  if (!f.bb || !f.mine) return null;
  const current = f.bb.price;
  const others = f.sellers.filter((s) => !s.mine);
  if (!others.length) return f.bb.others === 0 ? { only: true, current } : null;
  const nextOne = others.reduce((a, b) => (b.price < a.price ? b : a));
  const gap = (cents(nextOne.price) - cents(current)) / 100;
  const gapPct = current > 0 ? (gap / current) * 100 : 0;
  const target = raiseTarget(current, nextOne.price, rules);
  const ok = gap > 0
    && (!(rules.minGap > 0) || gap >= rules.minGap - 0.0001)
    && (!(rules.minGapPct > 0) || gapPct >= rules.minGapPct - 0.0001)
    && target >= current + 0.01;
  return { current, next: nextOne.price, nextSeller: nextOne.seller, gap, gapPct, target, ok };
}
const raiseRows = () => items.map((_, i) => i).filter((i) => idOf(items[i]))
  .map((i) => ({ i, f: rowFacts(i) })).map((x) => ({ ...x, r: raiseFor(x.f) })).filter((x) => x.r?.ok)
  .sort((a, b) => b.r.gap - a.r.gap);

function rowMatches(i) {
  const f = rowFacts(i);
  if (mFilter === "lost" && !f.lost) return false;
  if (mFilter === "won" && !f.mine) return false;
  if (mFilter === "wf" && f.wf?.status !== "enrolled") return false;
  if (mFilter === "oos" && !f.it.buyBox?.oos) return false;
  if (mFilter === "raise" && !raiseFor(f)?.ok) return false;
  if (mFilter === "amz" && !f.cheaper) return false;
  if (mFilter === "noamz" && f.linked) return false;
  if (mFilter === "missed" && !f.missed) return false;
  if (mSearch) {
    const q = mSearch.toLowerCase();
    const hay = [f.it.sku, f.it.itemId, lwOf(f.it), f.bb?.seller, ...f.sellers.map((s) => s.seller), ...amzList(f.it).map((a) => a.asin + " " + (a.title || ""))].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// ---- rendering: the table ---------------------------------------------------------
function renderMarket() {
  if (!inMarket()) return;
  const tb = $("mTbody");
  tb.innerHTML = "";
  const rows = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowMatches(i));
  if (mSelected < 0 || !items[mSelected]) mSelected = rows[0] ?? -1;
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="m-empty">${items.some(idOf) ? "No rows match this filter." : "Add rows with an Item ID on the Incentive price list tab first."}</td>`;
    tb.appendChild(tr);
  }
  // rows in first-appearance order, grouped under their Linnworks SKU
  const groups = new Map();
  for (const i of rows) { const k = groupKey(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); }
  const ordered = [];
  for (const [, members] of groups) {
    const lw = lwOf(items[members[0]]);
    const all = groupMembers(members[0]);
    if (lw && all.length > 1) ordered.push({ parent: true, lw, members, all });
    for (const i of members) ordered.push({ i, grouped: !!(lw && all.length > 1) });
  }
  for (const g of ordered) {
    if (g.parent) {
      const facts = g.all.map(rowFacts);
      const you = facts.filter((x) => x.mine).length, lost = facts.filter((x) => x.lost).length;
      const host = facts[0];
      const tr = document.createElement("tr");
      tr.className = "m-row m-parent edge-" + (facts.some((x) => x.cheaper) ? "red" : facts.some((x) => x.lost) ? "amber" : you ? "green" : "none") + (g.all.includes(mSelected) ? " in-sel" : "");
      tr.innerHTML = `<td><div class="m-grp"><span class="m-pill lw" title="Linnworks inventory SKU">LW</span><b>${esc(g.lw)}</b><span class="m-muted">${g.all.length} Walmart SKUs${you ? ` · ${you} winning` : ""}${lost ? ` · ${lost} losing` : ""}</span></div></td>`;
      tr.addEventListener("click", (e) => {
        if (!g.all.includes(mSelected)) mSelected = g.members[0];
        mEditing = null;
        renderMarket();
        if (e.target.closest(".m-link-chip")) { e.preventDefault(); $("mLinkInput")?.focus(); }
      });
      tb.appendChild(tr);
      continue;
    }
    const i = g.i;
    const f = rowFacts(i);
    const tr = document.createElement("tr");
    tr.className = "m-row edge-" + f.edge + (i === mSelected ? " sel" : "") + (g.grouped ? " m-child" : "");
    const reading = mScan.running && mScan.current && mScan.currentId === idOf(f.it);
    // one list item: SKU (+ Funded badge) and who holds the buy box on the left, the status and the gap on the right
    let st = "", sub, val = "";
    if (reading && (mScan.step === "walmart" || mScan.step === "amazon")) {
      sub = `<span class="m-reading"><span class="m-spin"></span>${mScan.step === "amazon" ? `Reading Amazon page ${mScan.stepN}…` : "Reading Walmart page…"}</span>`;
    } else if (f.bb) {
      const holder = f.sellers.find((s) => s.isBB) || null;
      const gap = f.lost && f.me && holder ? round2m(f.me.total - holder.total) : null;
      if (f.known) st = `<span class="m-st ${f.mine ? "w" : "l"}">${f.mine ? "Winning" : "Losing"}</span>`;
      val = gap != null && Math.abs(gap) >= 0.005
        ? `<b title="Your price with shipping, against the buy box seller's">${gap > 0 ? "+" : "−"}${fmt(Math.abs(gap))}</b>`
        : `<b title="Buy box price">${fmt(f.bb.price)}</b>`;
      const r = raiseFor(f);
      sub = f.mine ? `Buy Box: You${r?.ok ? ` · <span class="m-up" title="Next seller ${esc(r.nextSeller)} is at ${fmt(r.next)} — suggested ${fmt(r.target)}">${fmt(r.gap)} less than next price</span>` : ""}`
        : f.bb.seller ? `Buy Box: ${esc(f.bb.seller)}` : "Buy Box: not read";
      if (f.oos) st += `<span class="m-st n">Out of stock</span>`;
    } else if (f.it.buyBox?.oos) { st = `<span class="m-st n">Out of stock</span>`; sub = "No price on the listing"; }
    else if (f.it.buyBox?.robot) { st = `<span class="m-st n">Not read</span>`; sub = "Robot check — open the listing once to pass it"; }
    else if (f.it.buyBox?.noBuyBox) sub = "No buy box reported";
    else if (f.it.buyBox?.failed) { st = `<span class="m-st n">Not read</span>`; sub = "Couldn't read the page"; }
    else sub = "Not scanned yet";
    const fund = f.wf?.status === "enrolled" ? `<span class="m-fund" title="A Walmart-funded incentive is in effect">Funded</span>` : "";
    tr.innerHTML = `<td><div class="m-li"><div class="g"><div class="t"><b>${esc(f.it.sku || f.it.itemId)}</b>${fund}</div><div class="s">${sub}</div></div><div class="e">${st}${val}</div></div></td>`;
    tr.addEventListener("click", (e) => {
      mSelected = i;
      mEditing = null;
      renderMarket();
      if (e.target.closest(".m-link-chip")) { e.preventDefault(); $("mLinkInput")?.focus(); }
    });
    tb.appendChild(tr);
  }
  // the filter chips, each with how many listings it holds
  const allFacts = items.map((_, i) => i).filter((i) => idOf(items[i])).map(rowFacts);
  const filterCount = { all: allFacts.length, lost: allFacts.filter((f) => f.lost).length, won: allFacts.filter((f) => f.mine).length,
    oos: allFacts.filter((f) => f.it.buyBox?.oos).length, missed: allFacts.filter((f) => f.missed).length,
    wf: allFacts.filter((f) => f.wf?.status === "enrolled").length };
  // the Walmart-funded chip appears once the list has been read
  document.querySelector("#mFilters .m-wf-chip").classList.toggle("hidden", !wfLoaded());
  if (mFilter === "wf" && !wfLoaded()) mFilter = "all";
  document.querySelectorAll("#mFilters .m-chip").forEach((b) => {
    b.classList.toggle("active", mFilter === b.dataset.f);
    b.querySelector(".n").textContent = ` ${filterCount[b.dataset.f]}`;
  });
  $("mExportLabel").textContent = `Export ${mFilter === "all" && !mSearch ? "all" : FILTER_NAME[mFilter] || "shown"} · ${rows.length}`;
  const missedRows = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowFacts(i).missed);
  $("mMissedBtn").classList.toggle("active", mFilter === "missed");
  $("mMissedBtn").classList.toggle("has-missed", missedRows.length > 0);
  $("mMissedBtn").querySelector(".n").textContent = missedRows.length ? ` · ${missedRows.length}` : "";
  $("mRetryBtn").classList.toggle("hidden", !(mFilter === "missed" && missedRows.length && !mScan.running));
  const raiseN = raiseRows().length;
  $("mRaiseBtn").classList.toggle("active", mFilter === "raise");
  $("mRaiseBtn").classList.toggle("has-raise", raiseN > 0);
  $("mRaiseBtn").querySelector(".n").textContent = raiseN ? ` · ${raiseN}` : "";
  if (!mScan.running) {
    const next = nextScanAt();
    const nextText = next ? ` · next scan ${next <= Date.now() ? "due now" : when(next)}` : "";
    $("mLastScan").textContent = mNotice || (mResume ? `Scan stopped at ${mResume.total - mResume.ids.length} of ${mResume.total}${nextText}`
      : mLastScan ? `Last scan ${when(mLastScan)} · ${mLastScanN || items.filter(idOf).length} listings${mLastScanMs ? ` · ${mLastScanMs >= 90000 ? Math.round(mLastScanMs / 60000) + " min" : Math.round(mLastScanMs / 1000) + " s"}` : ""}${apiScanText()}${nextText}` : `No scan yet${nextText}`);
    $("mLastScan").classList.toggle("warn", !!mNotice);
    $("mLastScan").title = mNotice || "";
  }
  renderApiBtn();
  renderScanBar();
  renderPanel();
}

function renderScanBar() {
  const btn = $("mScanBtn");
  btn.classList.toggle("scanning", mScan.running);
  btn.querySelector("span").textContent = mScan.running ? (mScan.stop ? "Stopping…" : "Stop scan") : mResume ? `Resume scan · ${mResume.ids.length} left` : "Scan now";
  $("mScanOverBtn").classList.toggle("hidden", !(mResume && !mScan.running));
  $("mProgress").classList.toggle("hidden", !mScan.running);
  if (!mScan.running) return;
  $("mLastScan").classList.remove("warn");
  const el = Date.now() - mScan.startedAt;
  const read = mScan.done - (mScan.base || 0);
  const left = read > 0 ? Math.round((el / read) * (mScan.total - mScan.done) / 1000) : null;
  const leftText = left != null ? ` · about ${left >= 90 ? Math.round(left / 60) + " min" : left + " s"} left` : "";
  $("mLastScan").textContent = mScan.step === "api"
    ? mScan.current
    : `Reading ${Math.min(mScan.done + 1, mScan.total)} of ${mScan.total} · ${mScan.current}${leftText}`;
  $("mProgBar").style.width = `${Math.max(3, Math.round((mScan.done / Math.max(1, mScan.total)) * 100))}%`;
}

// ---- rendering: the right panel (design B: identity card + Walmart card + Amazon card) ----
function renderPanel() {
  const p = $("mPanel");
  const i = mSelected;
  if (i < 0 || !items[i]) { p.innerHTML = `<div class="m-panel-empty">Click a row to see its Walmart sellers and Amazon listings.</div>`; return; }
  const f = rowFacts(i);
  const it = f.it;
  const list = amzList(it);
  const viaApi = it.buyBox?.source === "api";
  const sellersHtml = f.sellers.length
    ? f.sellers.map((s) => `<div class="m-seller${s.isBB ? " bb" : ""}"><span class="rk">${s.rank}</span><span class="s${s.mine ? " me" : ""}" title="${esc(s.shipNote || "")}">${esc(s.seller)}</span>${s.isBB ? `<span class="m-pill bb">Buy box</span>` : ""}${s.mine ? `<span class="m-pill you">You</span>` : ""}<span class="sh">${s.shipping === 0 ? "free shipping" : s.shipping > 0 ? `+${fmt(s.shipping)} shipping` : ""}</span><span class="p" title="${s.shipping > 0 ? `${fmt(s.price)} + ${fmt(s.shipping)} shipping` : "Item price"}">${fmt(s.shipping > 0 ? s.total : s.price)}</span></div>`).join("")
      + (viaApi && it.buyBox.offersAt ? `<div class="m-seller m-muted m-note">Seller names come from the page read ${when(it.buyBox.offersAt)}; the buy box price above is from Walmart's API.</div>` : "")
    : viaApi
      ? `<div class="m-seller m-muted m-note">Walmart's API gives the buy box price, not seller names. <button class="mini" id="mReadPage" ${mScan.running ? "disabled" : ""}>Read the page for sellers</button></div>`
      : `<div class="m-seller m-muted">${f.bb ? "Only the buy box could be read" : it.buyBox?.oos ? "Out of stock — no price on the listing" : it.buyBox?.robot ? "Walmart showed a robot check — open the listing in the pane once to pass it" : it.buyBox?.notFound ? "Walmart says this listing page doesn't exist — check the Item ID" : it.buyBox?.notInCatalog ? "Walmart's API has no listing under this SKU — check the SKU, or read the page" : it.buyBox?.failed ? "The page couldn't be read — open it to check" : "Not scanned yet"}</div>`;
  // Walmart's own numbers for this SKU (Pricing Insights), when scanned via the API
  const api = apiOf(it);
  const DRIVER = { BUYBOX_PRICE: "from the buy box", COMPETITOR_PRICE: "from a competitor", WALMART_SUGGESTED_PRICE: "Walmart's pick", REFERENCE_PRICE: "from reference price", COMPARISON_PRICE: "from comparison price" };
  const apiStats = api ? `<div class="m-stats api">
        <div><span>Win rate</span><b>${api.winRate == null ? "—" : `${Math.round(api.winRate * 10) / 10}%`}</b></div>
        <div><span>Competitor</span><b>${fmt(api.competitorPrice)}</b></div>
        <div title="${api.suggestedDriver ? esc(DRIVER[api.suggestedDriver] || api.suggestedDriver) : ""}"><span>Suggested</span><b>${fmt(api.suggestedPrice)}</b>${api.suggestedDriver ? `<i>${esc(DRIVER[api.suggestedDriver] || "")}</i>` : ""}</div>
      </div>` : "";
  // one seller listed although Walmart says there are more: the scan skipped
  // them (it reads only the buy box), or say why they couldn't be read
  const sellersNote = f.bb && f.sellers.length <= 1 && f.bb.offersWhy === "skipped"
    ? `<div class="m-seller m-muted m-note">${f.bb.others > 0 ? `Walmart lists ${f.bb.others} more seller${f.bb.others === 1 ? "" : "s"}.` : ""} <button class="mini" id="mReadPage" ${mScan.running ? "disabled" : ""}>Read the page for sellers</button></div>`
    : f.bb && f.sellers.length <= 1 && (f.bb.others > 0 || f.bb.offersWhy)
    ? `<div class="m-seller m-muted m-note">${f.bb.others > 0 ? `Walmart lists ${f.bb.others} more seller${f.bb.others === 1 ? "" : "s"}, but ` : ""}${{
        "no-link": "the page showed no sellers link to open",
        "sellers-page": "neither the listing nor Walmart's all-sellers page could be read",
        "robot": "Walmart showed a robot check — open the listing in the pane once to pass it",
        "no-panel": "the sellers panel didn't open in time",
        "no-match": "the sellers panel couldn't be read",
        "error": "the sellers panel couldn't be read",
      }[f.bb.offersWhy] || "the other sellers couldn't be read"}. Re-check, or open the listing to compare.${f.bb.offersSnapshot ? ` <button class="mini" id="mSnapshot" title="Shows the saved copy of what Walmart's pages held — send it over so the reader can be fixed">Show page snapshot</button>` : ""}</div>`
    : "";
  // you hold the buy box: is there room to raise toward the next seller?
  const rz = raiseFor(f);
  const pct = (n) => `${Math.round(n * 10) / 10}%`;
  const raiseHtml = !rz ? ""
    : rz.only ? `<div class="m-raise quiet">You're the only seller on this listing, so there's no one to price against.</div>`
    : rz.ok ? `<div class="m-raise">
        <div class="m-raise-head"><b>Room to raise</b><button class="linkish" id="mRaiseRules" type="button">Raise rules</button></div>
        <div class="m-raise-line">The next seller, <b>${esc(rz.nextSeller)}</b>, is at ${fmt(rz.next)} — ${fmt(rz.gap)} (${pct(rz.gapPct)}) above your ${fmt(rz.current)}.</div>
        <div class="m-raise-go"><span>Suggested price</span><b>${fmt(rz.target)}</b><span class="m-muted">+${fmt((cents(rz.target) - cents(rz.current)) / 100)}</span><button class="mini" id="mRaiseCopy" data-price="${money(rz.target)}">Copy</button></div>
      </div>`
    : `<div class="m-raise quiet">You hold the buy box. The next seller is ${fmt(rz.gap)} (${pct(rz.gapPct)}) above you — inside your <button class="linkish" id="mRaiseRules" type="button">raise rules</button>, so nothing to raise.</div>`;
  const amzHtml = list.map((a, k) => {
    const editing = mEditing && mEditing.i === i && mEditing.k === k;
    if (editing) {
      return `<div class="m-amz editing">
        <div class="m-edit-grid">
          <label for="mLinkEdit">Link</label>
          <input id="mLinkEdit" type="text" value="${esc(a.asin || "")}" placeholder="Amazon URL or ASIN" />
          <label for="mPriceInput">Price</label>
          <div class="m-edit-price">
            <input id="mPriceInput" type="text" inputmode="decimal" value="${a.manual && a.price ? money(a.price) : ""}" placeholder="from Amazon" title="Leave blank to read the price from Amazon" />
            <span class="m-edit-actions"><button class="primary mini" data-save="${k}">Save</button><button class="mini" data-cancel="${k}">Cancel</button></span>
          </div>
        </div>
      </div>`;
    }
    const sub = a.manual ? `<span class="mono">${esc(a.asin || "typed")}</span> · typed by you${a.at ? " · " + when(a.at) : ""}`
      : a.robot ? `<span class="mono">${esc(a.asin)}</span> · <span class="m-warn">robot check — pass it below, then re-check</span>`
      : a.failed ? `<span class="mono">${esc(a.asin)}</span> · <span class="m-warn">couldn't read a price${a.at ? " · " + when(a.at) : ""}</span>`
      : `<span class="mono">${esc(a.asin)}</span>`;
    const lowest = f.low != null && a.price > 0 && Math.abs(a.price - f.low) < 0.005;
    return `<div class="m-amz${a.robot ? " robot" : ""}">
      <div class="m-amz-main">
        <div class="m-amz-text">
          <div class="t">${a.asin ? `<a href="#amz" data-open="${k}" title="Open on Amazon">${esc(a.title || a.asin)}</a>` : esc(a.title || "Typed price")}</div>
          <div class="m-muted sub">${sub}${a.sold ? ` <span class="m-pill sold">${esc(a.sold)} sold</span>` : ""}</div>
        </div>
        <b class="m-price${lowest ? " low" : ""}">${fmt(a.price)}</b>
        <span class="m-icons">
          <button class="m-icon" data-edit="${k}" title="Edit the link or type a price" aria-label="Edit the link or type a price"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
          <button class="m-icon" data-unlink="${k}" title="Unlink this listing" aria-label="Unlink this listing"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        </span>
      </div>
      ${a.robot && a.asin ? `<div class="m-amz-robot"><button class="mini" data-show="${k}">Show the Amazon page here</button><span class="m-muted">Pass the check once; later reads go through.</span></div>` : ""}
    </div>`;
  }).join("");
  // the repricer strategy's numbers for this SKU
  const rp = f.rp;
  const rpStats = rp ? `<div class="m-stats api rp" title="From the Walmart API${rp.strategy ? ` · strategy ${esc(rp.strategy)}` : ""}">
        <div><span>Repricer price</span><b>${fmt(rp.price)}</b></div>
        <div><span>Min – max</span><b>${rp.min > 0 ? "$" + money(rp.min) : "—"} – ${rp.max > 0 ? "$" + money(rp.max) : "—"}</b></div>
        <div><span>Inventory</span><b>${rp.inventory == null ? "—" : rp.inventory}</b>${rp.status ? `<i>${esc(rp.status)}</i>` : ""}</div>
      </div>` : "";
  // the scan's screenshot of the seller list (or of the buy box)
  const shot = it.buyBox?.shot?.file ? it.buyBox.shot : null;
  // The verdict, in words: winning or losing, by how much, to whom.
  const bbx0 = it.buyBox;
  const holder = f.sellers.find((s) => s.isBB) || null;
  const others = f.sellers.filter((s) => !s.mine);
  let verdict;
  if (f.bb && f.mine) {
    const next = others[0];
    verdict = { kind: "win", head: "You hold the buy box", sub: `At ${fmt(f.bb.price)}.${next ? ` Next is ${esc(next.seller)} at ${fmt(next.total)}.` : f.sellers.length <= 1 ? " No other seller on this listing." : ""}` };
  } else if (f.bb && f.lost) {
    const gap = f.me && holder ? round2m(f.me.total - holder.total) : null;
    verdict = { kind: "lose", head: gap > 0 ? `Losing the buy box by ${fmt(gap)}` : "Losing the buy box",
      sub: `${esc(f.bb.seller || "Another seller")} holds it at ${fmt(f.bb.price)}.${f.me ? ` You are #${f.me.rank} of ${f.sellers.length} at ${fmt(f.me.total)}.` : " Your offer isn't on this listing."}` };
  } else if (f.bb) verdict = { kind: "none", head: `Buy box ${fmt(f.bb.price)}`, sub: "Couldn't tell who holds it." };
  else if (bbx0?.oos) verdict = { kind: "none", head: "Out of stock", sub: "The listing shows no price." };
  else if (bbx0?.robot) verdict = { kind: "none", head: "Robot check", sub: "Open the listing in the pane once to pass it, then re-check." };
  else if (bbx0?.failed) verdict = { kind: "none", head: "Couldn't read this listing", sub: bbx0.notFound ? "Walmart says the page doesn't exist — check the Item ID." : "Re-check it, or open the listing to look." };
  else verdict = { kind: "none", head: "Not scanned yet", sub: "Run the buy box check, or re-check this listing." };
  const wfx = f.wf;
  const wfLine = !wfx ? "" : wfx.status === "enrolled"
    ? `<div class="m-wf-line"><span class="m-pill wf">Walmart-funded</span>${wfAfter(wfx) ? `Customer pays <b>${fmt(wfAfter(wfx))}</b>${wfx.price > 0 ? ` instead of ${fmt(wfx.price)}` : ""}.` : "An incentive is in effect on this item."}${wfx.start ? ` Since ${shortDate(wfx.start)}.` : ""}${wfx.end ? ` Until ${shortDate(wfx.end)}.` : ""}</div>`
    : `<div class="m-wf-line"><span class="m-pill wf dim">Eligible</span>This item can get a Walmart-funded incentive; none is in effect.</div>`;
  const verdictHtml = `<div class="m-verdict ${verdict.kind}"><b>${verdict.head}</b><span>${verdict.sub}</span></div>${wfLine}`;
  const lw = lwOf(it);
  const sibs = lw ? groupMembers(i).filter((j) => j !== i) : [];
  const groupLine = lw
    ? `<div class="m-group"><span class="m-pill lw">LW</span><b>${esc(lw)}</b>${sibs.length ? `<span class="m-muted">· also ${sibs.map((j) => `<a href="#sib" data-sib="${j}">${esc(items[j].sku || items[j].itemId)}</a>`).join(", ")}</span>` : `<span class="m-muted">· only this Walmart SKU</span>`}</div>`
    : "";
  // the strip of numbers across the top
  const skuKey = String(it.sku ?? "").trim();
  const rpOk = rpOn();
  const rs = rpOk && skuKey ? rState(skuKey) : null;
  const rb = rpOk && skuKey ? rBase(skuKey) : null;
  const myPrice = f.me ? f.me.price : rs && !rs.missing && rs.price > 0 ? rs.price : null;
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;
  const myNote = myPrice == null ? (f.bb ? "your offer isn't on this listing" : "")
    : rb?.strategy && near(myPrice, rb.min) ? "at your minimum" : rb?.strategy && near(myPrice, rb.max) ? "at your maximum"
    : f.rank && f.sellers.length > 1 ? `#${f.rank} of ${f.sellers.length} sellers` : "";
  const gapL = f.me && holder ? round2m(f.me.total - holder.total) : null;
  const stat = f.bb && f.mine ? { k: "win", h: "Winning", s: "You hold the buy box" }
    : f.bb && f.lost ? { k: "lose", h: gapL > 0 ? `Losing by ${fmt(gapL)}` : "Losing",
      s: !f.me ? "Your offer isn't on this listing" : gapL < 0 ? `You are ${fmt(-gapL)} cheaper, and still not in the buy box` : `You are #${f.me.rank} of ${f.sellers.length} sellers` }
    : { k: "none", h: verdict.head, s: verdict.sub };
  const amzNote = !f.linked ? "no listing linked" : f.low == null ? "not read yet"
    : f.cheaper ? `${fmt(round2m(f.during - f.low))} under your price` : f.linked > 1 ? `lowest of ${f.linked} linked` : "not cheaper than you";
  const fundBadge = wfx?.status === "enrolled" ? `<span class="m-fund">Funded</span>` : "";
  const sellBody = f.sellers.length
    ? `<table class="d-sellers"><thead><tr><th class="k">#</th><th>Seller</th><th class="r">Price</th><th class="r">Shipping</th><th class="r">Total</th></tr></thead><tbody>${f.sellers.map((s) =>
      `<tr class="${s.mine ? "me" : ""}"><td class="k">${s.rank}</td><td title="${esc(s.shipNote || "")}">${esc(s.seller)}${s.isBB ? `<span class="d-tag">Buy box</span>` : ""}${s.mine ? `<span class="d-tag">You</span>` : ""}</td><td class="r">${fmt(s.price)}</td><td class="r sh">${s.shipping === 0 ? "Free" : s.shipping > 0 ? fmt(s.shipping) : "—"}</td><td class="r">${fmt(s.total)}</td></tr>`).join("")}</tbody></table>`
    : sellersHtml;
  const incHtml = wfx?.status === "enrolled"
    ? `<h4>Walmart-funded incentive<span class="m-fund">Active</span></h4><p>${wfAfter(wfx) ? `Customers pay <b>${fmt(wfAfter(wfx))}</b>${wfx.price > 0 ? `, not ${fmt(wfx.price)}` : ""}.` : "Walmart pays part of the price."}${wfx.end ? ` Ends ${shortDate(wfx.end)}.` : ""}</p>`
    : wfx ? `<h4>Walmart-funded incentive<span class="m-fund dim">Eligible</span></h4><p>Can get one. None active.</p>`
    : `<h4>Walmart-funded incentive</h4><p class="m-muted">${wfLoaded() ? "None." : keysReady() ? "Not checked yet." : "Needs API keys."}</p>`;
  p.innerHTML = `
    <div class="d-head">
      <div class="d-title"><h2>${esc(it.sku || "(no SKU)")}${fundBadge}</h2><div class="m-muted">Item ID ${esc(it.itemId)}${it.buyBox?.at ? ` · read ${when(it.buyBox.at)}` : ""}</div></div>
      <button type="button" id="mShotEye" ${shot ? "" : "disabled"} title="${shot ? `See the screenshot of the ${shot.kind === "buybox" ? "buy box" : "seller list"} · ${when(shot.at)}` : "No screenshot yet"}">Screenshot</button>
      <button type="button" id="mOpenWm" title="Open the Walmart listing">Open on Walmart</button>
      <button type="button" id="mRecheck" ${mScan.running ? "disabled" : ""} title="Read this listing again now">Re-check</button>
    </div>
    ${groupLine}
    <div class="m-card d-hero">
      <div class="${stat.k}"><span>Status</span><b>${stat.h}</b><i>${stat.s}</i></div>
      <div><span>Buy box</span><b>${f.bb ? fmt(f.bb.price) : "—"}</b><i>${f.bb ? esc(f.bb.seller || "") : ""}</i></div>
      <div><span>Your price</span><b>${fmt(myPrice)}</b><i>${myNote}</i></div>
      <div><span>Incentive price</span><b>${fmt(f.during)}</b><i>from your Incentive list</i></div>
      <div class="${f.cheaper ? "amzlow" : ""}"><span>Amazon</span><b>${f.low != null ? fmt(f.low) : "—"}</b><i>${amzNote}</i></div>
    </div>
    <div class="d-two">
      <div class="d-col">
        <div class="m-card d-sell">
          <div class="d-card-head"><h4>Sellers on this listing</h4>${f.oos ? `<span class="m-st n">Out of stock</span>` : ""}<span class="m-muted">${f.sellers.length ? `${f.sellers.length} seller${f.sellers.length === 1 ? "" : "s"}` : ""}</span></div>
          ${sellBody}${sellersNote}${raiseHtml}
        </div>
        <div class="m-card d-amz">
          <div class="d-card-head"><h4>Amazon</h4><span class="m-muted">${list.length ? `${list.length} listing${list.length === 1 ? "" : "s"} linked` : "no listings linked"}${sibs.length ? ` · shared by ${sibs.length + 1} Walmart SKUs` : ""}</span></div>
          ${amzHtml}
          <div class="m-add">
            <input id="mLinkInput" type="text" placeholder="Paste an Amazon URL or ASIN to add a listing" aria-label="Add Amazon listing" />
            <button id="mLinkBtn">Add listing</button>
          </div>
        </div>
        <div class="m-card m-notes">
          <div class="d-card-head"><h4>Notes</h4><span class="m-muted" id="mNoteState"></span></div>
          <textarea id="mNote" rows="3" placeholder="Anything you want to remember about this SKU…" aria-label="Notes for this SKU">${esc(it.note || "")}</textarea>
        </div>
      </div>
      <div class="d-col">
        <div class="m-card d-rp" id="mRpCard"></div>
        <div class="m-card d-inc">${incHtml}</div>
        ${mStoreEditing
          ? `<div class="m-store editing"><span class="m-muted">Your store on Walmart:</span><input id="mStoreInput" type="text" value="${esc(myStore)}" placeholder="Exactly as Walmart shows it" aria-label="Your store name on Walmart" /><span class="m-edit-actions"><button id="mStoreSave" class="primary">Save</button><button id="mStoreCancel">Cancel</button></span></div>`
          : `<div class="m-store"><span class="m-muted">Your store on Walmart:</span> <b>${esc(myStore)}</b> <a href="#" id="mStoreEdit">change</a></div>`}
      </div>
    </div>`;
  renderRpCard();
  // wiring
  const note = p.querySelector("#mNote");
  let noteTimer = null;
  note?.addEventListener("keydown", (e) => e.stopPropagation());
  note?.addEventListener("input", () => {
    it.note = note.value;
    $("mNoteState").textContent = "Saving…";
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { saveQuiet(); $("mNoteState").textContent = "Saved"; setTimeout(() => { if ($("mNoteState")) $("mNoteState").textContent = ""; }, 1500); }, 400);
  });
  note?.addEventListener("blur", () => { if (it.note !== undefined) saveQuiet(); });
  p.querySelectorAll("[data-sib]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); mSelected = Number(a.dataset.sib); mEditing = null; renderMarket(); }));
  p.querySelector("#mRecheck")?.addEventListener("click", () => runMarketScan([i]));
  p.querySelector("#mReadPage")?.addEventListener("click", () => readPageFor(i));
  p.querySelector("#mSnapshot")?.addEventListener("click", async () => {
    if (!(await window.api.showPageSnapshot(it.itemId))) alert("No page snapshot is saved for this item. Re-check it to take one.");
  });
  p.querySelector("#mShotEye")?.addEventListener("click", () => { if (shot) openShotModal(it, shot); });
  p.querySelector("#mOpenWm")?.addEventListener("click", () => window.api.openExternal(it.itemId));
  p.querySelector("#mRaiseRules")?.addEventListener("click", openRaiseModal);
  p.querySelector("#mRaiseCopy")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    navigator.clipboard?.writeText(b.dataset.price).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1200); }).catch(() => {});
  });
  // window.prompt() does nothing in Electron, so the store name is edited in
  // place: the link turns the line into a field with Save / Cancel.
  p.querySelector("#mStoreEdit")?.addEventListener("click", (e) => { e.preventDefault(); mStoreEditing = true; renderPanel(); const f = $("mStoreInput"); f?.focus(); f?.select(); });
  const storeSave = () => {
    const name = ($("mStoreInput")?.value || "").trim();
    if (name) { myStore = name; localStorage.setItem("myStoreName", myStore); }
    mStoreEditing = false; renderMarket();
  };
  const storeCancel = () => { mStoreEditing = false; renderPanel(); };
  p.querySelector("#mStoreSave")?.addEventListener("click", storeSave);
  p.querySelector("#mStoreCancel")?.addEventListener("click", storeCancel);
  p.querySelector("#mStoreInput")?.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") storeSave(); if (e.key === "Escape") storeCancel(); });
  const linkIn = p.querySelector("#mLinkInput");
  const doLink = () => { if (linkAmazon(i, linkIn.value)) linkIn.value = ""; };
  p.querySelector("#mLinkBtn")?.addEventListener("click", doLink);
  linkIn?.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") doLink(); });
  p.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { mEditing = { i, k: Number(b.dataset.edit) }; renderPanel(); $("mPriceInput")?.focus(); }));
  p.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => { mEditing = null; renderPanel(); }));
  p.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => saveEdit(i, Number(b.dataset.save))));
  p.querySelectorAll("#mPriceInput, #mLinkEdit").forEach((inp) => inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") saveEdit(i, mEditing.k);
    if (e.key === "Escape") { mEditing = null; renderPanel(); }
  }));
  p.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); window.api.openAmazon(it.amz[Number(b.dataset.open)].asin); }));
  p.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", () => {
    const k = Number(b.dataset.unlink);
    const a = it.amz[k];
    if (!confirm(`Unlink ${a.asin || "this typed price"} from ${it.sku || it.itemId}?`)) return;
    it.amz.splice(k, 1); syncAmz(i); mEditing = null; saveQuiet(); renderMarket();
  }));
  p.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => showAmazonPage(it.amz[Number(b.dataset.show)].asin)));
}

function saveQuiet() { window.api.saveItems(items); }

// ---- the Repricer box in a listing's panel -----------------------------------------------
// The strategy, minimum and maximum of the selected SKU, editable in place. It
// works on the Repricer tab's own state (repricerTab.js: rEdits, rSent, rpr) and
// sends through that tab's dialog, so the one-item test, the backup and the
// 10-minute gap between uploads all apply here too.
const rpOn = () => typeof rState === "function"; // repricerTab.js loads after this file
const rpSku = () => String(items[mSelected]?.sku ?? "").trim();
function rpTyping() { const a = document.activeElement; return !!a && $("mPanel").contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA"); }
// The Repricer tab's state changed (an import, a send, an upload being followed).
function rpSync() { if (!inMarket()) return; if (rpTyping()) renderRpFoot(); else renderPanel(); }
function rpNoteHtml() {
  const unfinished = !rFlow && rpr.test && (rpr.test.result === "sent" || rpr.test.result === "unclear");
  const h = rFlow ? `<span class="m-spin"></span><span>${esc(rFlow.text)}</span>`
    : rResult ? `<span>${rResult.html}</span><button class="mini" id="rResultX" type="button">Dismiss</button>`
    : rMoved.length ? `<span>Test failed: ${rMoved.length} other item${rMoved.length === 1 ? "" : "s"} changed.</span><button class="mini" id="rRestore" type="button">Put back</button>`
    : unfinished ? `<span>Test sent. Download the strategy again and import it.</span><button class="mini" id="rImportGo" type="button">Import</button>`
    : "";
  return h ? `<div class="d-note ${rFlow ? "busy" : rResult ? rResult.kind : rMoved.length ? "bad" : "info"}">${h}</div>` : "";
}
function renderRpCard() {
  const box = $("mRpCard");
  if (!box) return;
  if (!rpOn()) { box.innerHTML = `<h4>Repricer</h4><p class="m-muted">Loading…</p>`; return; }
  const sku = rpSku(), s = sku ? rState(sku) : null;
  let body;
  if (!sku) body = `<p class="m-muted">No SKU on this row.</p>`;
  else if (!rpr.fileAt) body = `<p class="m-muted">Import your strategy to see min and max.</p><button type="button" class="primary wide" id="mRpImportGo">Import</button>`;
  else if (s?.missing) body = `<p class="m-muted">Walmart doesn't know this SKU.</p>`;
  else if (!rEditable(sku)) body = `<p class="m-muted">${rBusy ? "Reading from Walmart…" : "Not on a strategy."}</p><button type="button" class="wide" id="mRpAdd" ${rBusy || !keysReady() ? "disabled" : ""}>Add to a strategy</button>`;
  else {
    const v = rVal(sku);
    const names = [...new Set(Object.values(rpr.state).map((x) => x?.strategy).filter(Boolean))].sort();
    body = `<label class="d-f" for="mRpS">Strategy</label><input class="d-in" id="mRpS" list="mRpStrategies" value="${esc(v.strategy)}" placeholder="No strategy" />
      <datalist id="mRpStrategies">${names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
      <div class="d-row2"><div><label class="d-f" for="mRpMin">Minimum</label><input class="d-in num" id="mRpMin" inputmode="decimal" value="${esc(v.min)}" /></div>
      <div><label class="d-f" for="mRpMax">Maximum</label><input class="d-in num" id="mRpMax" inputmode="decimal" value="${esc(v.max)}" /></div></div>`;
  }
  box.innerHTML = `<h4>Repricer</h4>${body}<div id="mRpFoot"></div>`;
  box.querySelectorAll(".d-in").forEach((el) => {
    el.addEventListener("input", rpEdit);
    el.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") el.blur(); });
  });
  renderRpFoot();
}
function rpEdit() {
  const sku = rpSku(), k = rKey(sku), b = rBase(sku);
  const v = { strategy: $("mRpS").value, min: $("mRpMin").value, max: $("mRpMax").value };
  const untouched = v.strategy.trim().toLowerCase() === b.strategy.toLowerCase() && rNum(v.min) === b.min && rNum(v.max) === b.max;
  if (untouched) delete rEdits[k]; else rEdits[k] = v;
  delete rSent[k]; // typing over a sent change makes it a new one
  if (!rList.some((x) => rKey(x) === k)) rList.push(sku);
  rSave();
  renderRpFoot();
}
function renderRpFoot() {
  const el = $("mRpFoot");
  if (!el || !rpOn()) return;
  const sku = rpSku();
  let html;
  if (!sku || !rpr.fileAt || !rEditable(sku)) html = rpNoteHtml();
  else {
    const k = rKey(sku), b = rBase(sku), c = rChange(sku), sent = rSent[k], v = rVal(sku);
    const f = rowFacts(mSelected);
    const minNow = rNum(v.min), maxNow = rNum(v.max);
    $("mRpS")?.classList.toggle("c", String(v.strategy || "").trim().toLowerCase() !== b.strategy.toLowerCase());
    $("mRpMin")?.classList.toggle("c", !!rEdits[k] && minNow !== b.min);
    $("mRpMax")?.classList.toggle("c", !!rEdits[k] && maxNow !== b.max);
    let tip = "";
    if (f.bb && f.lost && String(v.strategy || "").trim() && minNow > 0) {
      if (f.bb.price < minNow - 0.005) tip = `Your min is above the buy box (${fmt(f.bb.price)}). <button type="button" class="linkish" id="mRpMatch">Match it</button>`;
    }
    const arrow = (name, was, now) => (was != null && now != null && Math.abs(was - now) >= 0.005 ? `${name} ${fmt(was)} → ${fmt(now)}` : "");
    const short = !c || c.invalid ? "" : !c.strategy ? "Take off strategy"
      : [b.strategy.toLowerCase() !== c.strategy.toLowerCase() ? `Strategy → ${esc(c.strategy)}` : "", arrow("Min", b.min, c.min) || (b.min == null ? `Min ${fmt(c.min)}` : ""), arrow("Max", b.max, c.max) || (b.max == null ? `Max ${fmt(c.max)}` : "")].filter(Boolean).join(" · ");
    const { out } = rPending();
    const wait = (rpr.lastSendAt || 0) + (rpr.gateMs || 600000) - Date.now();
    const why = !out.length ? "" : rpr.sendsOff ? "Import your strategy first."
      : !keysReady() ? "Add your API keys first."
      : rFlow ? "Checking the last push…"
      : wait > 0 ? `Next push in ${Math.floor(wait / 60000)}:${String(Math.floor((wait % 60000) / 1000)).padStart(2, "0")}`
      : !rTested() ? "First push is a 1-item test." : "";
    const off = !out.length || rpr.sendsOff || !keysReady() || !!rFlow || wait > 0;
    const label = rTested() && (out.length > 1 || (out.length && !c)) ? `Push ${out.length} change${out.length === 1 ? "" : "s"}` : "Push to Walmart";
    const line = c?.invalid ? `<span class="bad">${esc(c.invalid)}</span>`
      : sent ? "Sent · waiting for Walmart"
      : c ? `${short} · <button type="button" class="linkish" id="mRpUndo">Undo</button>`
      : "";
    const under = [line, why ? esc(why) : ""].filter(Boolean).join(" · ");
    html = `${tip ? `<div class="d-tip">${tip}</div>` : ""}<button type="button" class="primary wide" id="mRpPush" ${off ? "disabled" : ""}>${label}</button>${under ? `<div class="d-foot">${under}</div>` : ""}${rpNoteHtml()}`;
  }
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}
$("mPanel").addEventListener("click", (e) => {
  const id = e.target.id;
  if (!rpOn() || !id) return;
  const sku = rpSku();
  if (id === "mRpImportGo" || id === "rImportGo") openRImport();
  else if (id === "mRpAdd") rAddSkus([sku]);
  else if (id === "mRpMatch") { const f = rowFacts(mSelected); if (f.bb) { $("mRpMin").value = money(f.bb.price); rpEdit(); } }
  else if (id === "mRpUndo") { delete rEdits[rKey(sku)]; rSave(); renderRpCard(); }
  else if (id === "mRpPush") {
    openRSend();
    const pick = $("rSendPick"); // the one-item test sends one change: make it this listing's
    const opt = [...pick.options].find((o) => o.textContent.toLowerCase() === sku.toLowerCase());
    if (opt && pick.value !== opt.value) { pick.value = opt.value; pick.onchange?.(); }
  }
  else if (id === "rResultX") { rResult = null; rpSync(); }
  else if (id === "rRestore") rRestore();
});
$("mRpImport").addEventListener("click", () => { if (rpOn()) openRImport(); });
setInterval(() => { if (inMarket() && $("mRpFoot")) renderRpFoot(); }, 1000);

// ---- the screenshot pop-up (the eye in a row's panel) --------------------------------
let shotShown = null;
function openShotModal(it, shot) {
  shotShown = shot;
  $("shotTitle").textContent = it.sku || it.itemId;
  $("shotSub").textContent = `${shot.kind === "buybox" ? "Buy box" : "Seller list"} as Walmart showed it · ${when(shot.at)}`;
  $("shotImg").src = `${fileUrl(shot.file)}?t=${shot.at || 0}`;
  window.api.hideListing();
  hideAmazonPage();
  $("shotModal").classList.remove("hidden");
  $("shotClose").focus();
}
function closeShotModal() { $("shotModal").classList.add("hidden"); $("shotImg").removeAttribute("src"); shotShown = null; }
$("shotClose").addEventListener("click", closeShotModal);
$("shotModal").addEventListener("click", (e) => { if (e.target.id === "shotModal") closeShotModal(); });
$("shotModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeShotModal(); });
$("shotFile").addEventListener("click", () => { if (shotShown) window.api.bbxShowShot(shotShown.file); });
$("shotFull").addEventListener("click", () => { if (shotShown) window.api.bbxOpenShot(shotShown.file); });

// The pencil's Save: a new link replaces the ASIN (and its read data); a typed
// price is kept as yours; an empty price means "read it from Amazon again".
function saveEdit(i, k) {
  const it = items[i];
  const a = it?.amz?.[k];
  if (!a) return;
  const linkText = String($("mLinkEdit")?.value ?? "").trim();
  const priceText = String($("mPriceInput")?.value ?? "").trim();
  let asin = a.asin;
  if (linkText) {
    const parsed = parseAsin(linkText);
    if (!parsed) { alert("That doesn't look like an Amazon listing. Paste the product page's URL or its 10-character ASIN (starts with B0…)."); $("mLinkEdit")?.focus(); return; }
    if (it.amz.some((o, j) => j !== k && o.asin === parsed)) { alert(`${parsed} is already linked to this SKU.`); return; }
    asin = parsed;
  }
  const changedAsin = asin !== a.asin;
  if (changedAsin) { a.asin = asin; a.title = ""; a.price = null; a.sold = null; a.prime = false; a.seller = null; a.offers = null; a.failed = false; a.robot = false; a.at = null; }
  if (priceText) {
    const v = Number(priceText.replace(/[^0-9.]/g, ""));
    if (!(v > 0)) { alert("Enter a price, like 149.99, or leave it blank to read it from Amazon."); $("mPriceInput")?.focus(); return; }
    a.price = Math.round(v * 100) / 100; a.manual = true; a.failed = false; a.robot = false; a.at = Date.now();
  } else if (a.manual) {
    a.manual = false; a.price = null; a.at = null; // back to reading it from Amazon
  }
  if (!a.asin && !a.manual) { it.amz.splice(k, 1); } // nothing to read and nothing typed
  syncAmz(i);
  mEditing = null;
  saveQuiet();
  renderMarket();
  if (a.asin && !a.manual && !mScan.running) readAmazonInto(a).then(() => { syncAmz(i); saveQuiet(); renderMarket(); });
}

// "https://www.amazon.com/Samsung-…/dp/B0CT4KQ9NM?…", "amazon.com/gp/product/B0…", or a bare ASIN
function parseAsin(text) {
  const t = String(text ?? "").trim();
  const m = /\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/i.exec(t) || /^([A-Z0-9]{10})$/i.exec(t) || /\b(B0[A-Z0-9]{8})\b/i.exec(t);
  return m ? m[1].toUpperCase() : null;
}
function linkAmazon(i, text) {
  const it = items[i];
  const asin = parseAsin(text);
  if (!asin) { alert("That doesn't look like an Amazon listing. Paste the product page's URL or its 10-character ASIN (starts with B0…)."); return false; }
  if (!Array.isArray(it.amz)) it.amz = [];
  if (it.amz.some((a) => a.asin === asin)) { alert(`${asin} is already linked to this SKU.`); return false; }
  const entry = { asin, title: "", price: null, at: null };
  it.amz.push(entry);
  syncAmz(i);
  saveQuiet();
  renderMarket();
  // read it right away so the price shows without waiting for the next scan
  if (!mScan.running) readAmazonInto(entry).then(() => { syncAmz(i); saveQuiet(); renderMarket(); });
  return true;
}

async function readAmazonInto(entry) {
  if (entry.manual || !entry.asin) return;
  const r = await window.api.marketReadAmazon(entry.asin).catch(() => null);
  if (!r) { entry.failed = true; entry.at = Date.now(); return; }
  if (r.robot) { entry.robot = true; entry.at = Date.now(); return; }
  entry.robot = false;
  if (r.price > 0) {
    entry.price = r.price; entry.failed = false;
  } else {
    entry.failed = true; // keep the last known price
  }
  if (r.title) entry.title = r.title;
  entry.prime = !!r.prime;
  entry.seller = r.seller || null;
  entry.offers = Number.isInteger(r.offers) ? r.offers : null;
  entry.unavailable = !!r.unavailable;
  entry.sold = r.sold || null;
  entry.at = Date.now();
}

// ---- the scan ----------------------------------------------------------------------
// With API keys saved, one batched Pricing Insights call adds every SKU's win
// rate and suggested price up front. Then each listing's page is read for the
// buy box price and who holds it (the other sellers only where you hold it,
// for Room to raise), and each linked Amazon listing.
const rnd = (a, b) => a + Math.random() * (b - a);
// "matched/asked" SKU counts, "off" (no keys saved), "err" (the call failed),
// or from older builds "1" (API used) / "0" / "" (not used)
let mLastScanApi = localStorage.getItem("marketLastScanApi") || "";
let mLastScanN = Number(localStorage.getItem("marketLastScanN")) || 0; // listings the last full scan read
function apiScanText() {
  if (!apiReady() || mLastScanApi === "off") return "";
  if (mLastScanApi === "err") return " · Walmart API failed (see API)";
  const [got, asked] = mLastScanApi.split("/").map(Number);
  if (!mLastScanApi || mLastScanApi === "0") return "";
  if (!(asked > 0)) return " · with Walmart API";
  return got === asked ? " · Walmart API knew every SKU" : ` · Walmart API knew ${got} of ${asked} SKUs`;
}
window.api.onApiProgress?.(({ done, total }) => {
  if (mScan.running && mScan.step === "api") { mScan.current = `Walmart API: ${done} of ${total} SKUs`; renderScanBar(); }
});
// One row's full read (every seller, a fresh screenshot), outside a full scan.
function readPageFor(i) { return runMarketScan([i]); }

// A listing with no price to read: out of stock, a robot check, a dead page.
// A row that had a price keeps it (dated), marked with what happened this time.
function noteNoPrice(id, r) {
  for (const i of rowsWithItem(id)) {
    const bb = items[i].buyBox;
    const what = { oos: r?.oos ?? null, robot: !!r?.robot || undefined, notFound: !!r?.notFound || undefined };
    if (bb?.price > 0) items[i].buyBox = { ...bb, oos: what.oos, missedAt: Date.now(), shot: r?.shot ?? bb.shot ?? null };
    else items[i].buyBox = { failed: true, at: Date.now(), ...what, shot: r?.shot ?? null };
  }
  saveQuiet();
}

// opts.resume: carry on a stopped full scan. opts.auto: started by the
// schedule, so nothing pops up when it ends.
async function runMarketScan(onlyRows = null, opts = {}) {
  if (mScan.running) return;
  const full = !onlyRows;
  const resume = full && opts.resume && mResume ? mResume : null;
  hideAmazonPage();
  mNotice = "";
  mScan = { running: true, done: 0, total: 0, base: 0, current: "", currentId: "", step: "", stepN: "", stop: false, startedAt: Date.now(), auto: !!opts.auto };
  if (full && !resume) { mResume = null; localStorage.setItem("marketLastScanStart", String(Date.now())); }
  if (full && !resume && keysReady()) refreshIncentives(); // alongside the scan, not held up by it
  renderMarket();
  const rows = (onlyRows || items.map((_, i) => i).filter(inScope)).filter((i) => idOf(items[i]));
  let ids = [...new Set(rows.map((i) => idOf(items[i])))];
  if (resume) ids = resume.ids.filter((id) => rowsWithItem(id).length);
  if (!ids.length || mScan.stop) {
    mScan.running = false;
    renderMarket();
    if (!ids.length && !opts.auto) alert("No rows have an Item ID to look up. Add them on the Incentive price list tab.");
    return;
  }
  // where this scan's screenshots go: a new folder per full scan; a single
  // re-check replaces the row's picture in the scan it came from
  let scanId = resume ? resume.scanId : null;
  if (!scanId && !full) scanId = items[rows[0]]?.buyBox?.shot?.scanId || localStorage.getItem("marketLastScanId") || null;
  if (!scanId) { try { scanId = (await window.api.bbxNewScan()).scanId; } catch { scanId = null; } }
  if (full && scanId) localStorage.setItem("marketLastScanId", scanId);
  mScan.total = resume ? resume.total : ids.length;
  mScan.done = mScan.base = mScan.total - ids.length;
  mScan.startedAt = Date.now();
  renderMarket();
  // 1) Walmart API — every SKU in one go
  let usedApi = resume ? resume.usedApi : apiReady() ? "" : "off";
  if (apiReady() && !resume) {
    const skus = [...new Set(rows.map((i) => String(items[i].sku ?? "").trim()).filter(Boolean))];
    if (skus.length) {
      mScan.step = "api"; mScan.current = `Walmart API: 0 of ${skus.length} SKUs`;
      renderMarket();
      const res = await window.api.marketInsights(skus).catch(() => null);
      if (!mScan.stop) {
        if (res?.ok) {
          usedApi = `${Object.keys(res.bySku).length}/${skus.length}`;
          if (!Object.keys(res.bySku).length) mScan.apiNone = skus.length;
          for (const [sku, ins] of Object.entries(res.bySku)) {
            rememberApi(sku, ins, res.at);
          }
          for (const sku of res.missing || []) markNotInCatalog(sku, res.at);
          apiSettings.lastScan = res.at;
          saveQuiet();
          cacheBuyBoxes();
        } else {
          mScan.apiError = res?.error || "The Walmart API didn't answer.";
          usedApi = "err";
          localStorage.setItem("marketLastApiError", mScan.apiError);
        }
      }
      mScan.step = ""; mScan.current = "";
      renderMarket();
    }
  }
  const amzSeen = new Map(); // asin → read result, so a SKU listed twice reads each ASIN once per scan
  let at = 0; // ids before this index are done
  for (; at < ids.length; at++) {
    const id = ids[at];
    if (mScan.stop) break;
    const rowsFor = items.map((_, i) => i).filter((i) => idOf(items[i]) === id);
    const sku = items[rowsFor[0]]?.sku || id;
    mScan.currentId = id;
    // 2) page read: the buy box, every seller with shipping, and the screenshot
    mScan.current = `Walmart: ${sku}`; mScan.step = "walmart";
    renderMarket();
    const r = await window.api.marketReadWalmart(id, { full: true, scanId, store: myStore }).catch(() => null);
    if (r?.robot) { // every read after this would fail too: stop here, Resume picks this one up again
      noteNoPrice(id, r);
      mScan.stop = true; mScan.robot = true;
      break;
    }
    if (r && r.price) rememberPrice(r); else { markNoPrice(id); noteNoPrice(id, r); }
    if (mScan.stop) { at++; break; }
    // every Amazon listing linked to any row with this item ID
    const entries = [];
    for (const i of rowsFor) for (const a of amzList(items[i])) if (!a.manual && a.asin) entries.push(a);
    for (let n = 0; n < entries.length; n++) {
      if (mScan.stop) break;
      const a = entries[n];
      mScan.current = `Amazon: ${a.asin}`; mScan.step = "amazon"; mScan.stepN = `${n + 1} of ${entries.length}`;
      renderMarket();
      if (amzSeen.has(a.asin)) { Object.assign(a, amzSeen.get(a.asin)); continue; }
      await readAmazonInto(a);
      amzSeen.set(a.asin, { price: a.price, title: a.title, prime: a.prime, seller: a.seller, offers: a.offers, at: a.at, failed: a.failed, robot: a.robot, unavailable: a.unavailable, sold: a.sold });
      rowsFor.forEach(syncAmz);
      saveQuiet();
      if (n < entries.length - 1) await sleep(rnd(AMZ_PAUSE_MS[0], AMZ_PAUSE_MS[1]));
    }
    mScan.done++;
    saveQuiet();
    renderMarket();
    if (!mScan.stop && ids.length > 1) await sleep(WM_PAUSE_MS);
  }
  const stopped = at < ids.length;
  const robot = mScan.robot;
  mScan.running = false;
  mScan.currentId = "";
  if (full) {
    mResume = stopped ? { ids: ids.slice(at), total: mScan.total, scanId, usedApi, startedAt: resume?.startedAt || mScan.startedAt } : null;
    if (robot) mNotice = "Scan paused: Walmart asked for a robot check. Open any listing in the Incentive price list tab's pane, pass the check there, then press Resume scan.";
  }
  if (full && !stopped) {
    mLastScan = Date.now();
    mLastScanMs = mLastScan - mScan.startedAt;
    mLastScanApi = usedApi;
    mLastScanN = mScan.total;
    localStorage.setItem("marketLastScan", String(mLastScan));
    localStorage.setItem("marketLastScanMs", String(mLastScanMs));
    localStorage.setItem("marketLastScanN", String(mLastScanN));
    localStorage.setItem("marketLastScanApi", usedApi);
  }
  const apiError = mScan.apiError, apiNone = mScan.apiNone;
  renderMarket();
  // 3) the results file for other apps — after every scan, finished or not
  await writeBbxExport({ scanId, startedAt: resume?.startedAt || mScan.startedAt, complete: full && !stopped });
  if (opts.auto) return;
  if (apiError) openApiModal(`The Walmart API part of the scan failed, so win rates and suggested prices are missing (buy boxes were read from the pages as usual). ${apiError}`, true);
  else if (apiNone) openApiModal(`Walmart's API connected, but returned nothing for any of your ${apiNone} SKU${apiNone === 1 ? "" : "s"}, so there are no win rates or suggested prices (buy boxes were read from the pages as usual). Pricing Insights only covers published items in this seller account, looked up by the exact SKU in Seller Center — check the SKUs match, and that these keys belong to the same account.`, true);
  else if (full && !stopped) showSummary();
}

// ---- buy box check: the results file, the settings dialog -----------------------------------
// One row per SKU for other apps (the format is documented in the README).
function bbxExportRows() {
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const numOr = (n) => (Number.isFinite(n) ? n : null);
  const base = items.map((_, i) => i).filter((i) => idOf(items[i])).map((i) => ({ i, rp: rpOf(items[i]) }));
  const seen = new Set();
  const out = [];
  for (const { i, rp } of base) {
    const it = i >= 0 ? items[i] : null;
    const sku = String(rp?.sku ?? it?.sku ?? "").trim();
    const itemId = String(it ? idOf(it) : rp?.itemId ?? "").trim();
    const key = (sku || itemId).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const f = i >= 0 ? rowFacts(i) : null;
    const bb = it?.buyBox || null;
    const sellers = f ? f.sellers : [];
    const me = f?.me || null;
    const rival = sellers.find((s) => !s.mine) || null; // sellers are sorted by total, so this is the cheapest other seller
    const myPrice = numOr(rp?.price) ?? numOr(me?.price) ?? numOr(f?.api?.currentPrice) ?? (f && f.during > 0 ? f.during : null);
    const myTotal = me ? me.total : myPrice;
    const missed = !!(bb?.missedAt && bb.missedAt > (bb.at || 0));
    const readStatus = !itemId ? "no-item-id" : !bb ? "not-scanned" : bb.robot ? "robot-check" : bb.notFound ? "not-found"
      : bb.oos && (missed || !(bb.price > 0)) ? "out-of-stock" : bb.failed || missed ? "failed" : bb.price > 0 ? "ok" : "not-scanned";
    out.push({
      sku, itemId,
      strategy: rp?.strategy ?? null,
      myPrice, minPrice: numOr(rp?.min), maxPrice: numOr(rp?.max), inventory: numOr(rp?.inventory), status: rp?.status ?? null,
      buyBoxPrice: f?.bb ? f.bb.price : null,
      buyBoxSeller: f?.bb?.seller ?? null,
      buyBoxIsMine: f?.known ? f.mine : null,
      myRank: me ? me.rank : null,
      sellerCount: sellers.length,
      lowestCompetitorPrice: rival ? rival.price : null,
      lowestCompetitorShipping: rival ? rival.shipping : null,
      lowestCompetitorTotal: rival ? rival.total : null,
      lowestCompetitorSeller: rival ? rival.seller : null,
      gap: rival && myTotal != null ? round2m(myTotal - rival.total) : null,
      outOfStock: bb?.oos ?? null,
      sellers: sellers.map((s) => ({ rank: s.rank, seller: s.seller, price: s.price, shipping: s.shipping, shippingNote: s.shipNote, total: s.total, isMe: s.mine, hasBuyBox: s.isBB })),
      screenshot: bb?.shot?.file ?? null,
      screenshotKind: bb?.shot?.kind ?? null,
      walmartFunded: f?.wf ? { status: f.wf.status, priceAfterIncentive: wfAfter(f.wf), offerPrice: f.wf.price ?? null, start: iso(f.wf.start), end: iso(f.wf.end) } : null,
      scannedAt: iso(missed ? bb.missedAt : bb?.at),
      readStatus,
      listingUrl: itemId ? `https://www.walmart.com/ip/${itemId}` : null,
    });
  }
  return out;
}
let bbxLastExport = null; // { ok, path, rows } | { error }
async function writeBbxExport(scan = {}) {
  const payload = {
    scanId: scan.scanId || null,
    scanStartedAt: scan.startedAt ? new Date(scan.startedAt).toISOString() : null,
    scanFinishedAt: new Date().toISOString(),
    scanComplete: !!scan.complete,
    store: myStore,
    rows: bbxExportRows(),
  };
  bbxLastExport = await window.api.bbxWriteExport(payload).catch((e) => ({ error: String(e?.message || e) }));
  if (bbxLastExport?.error) console.error(bbxLastExport.error);
  return bbxLastExport;
}

function bbxStatus(text, kind) {
  const el = $("bbxStatus");
  if (!el || $("bbxModal").classList.contains("hidden")) return;
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}
function renderBbxModal() {
  // the path's last three parts fit the row; the whole path is the tooltip
  const full = bbx.settings.exportPath || "";
  const parts = full.split(/[\\/]/);
  $("bbxExportPath").textContent = parts.length > 4 ? "…" + (full.includes("\\") ? "\\" : "/") + parts.slice(-3).join(full.includes("\\") ? "\\" : "/") : full;
  $("bbxExportPath").title = full;
  renderIncState();
}
function fillBbxForm() {
  const st = bbx.settings;
  $("bbxSchedOn").checked = !!st.scheduleOn;
  $("bbxHours").value = String(st.everyHours ?? 3);
  $("bbxShots").checked = !!st.shots;
}
async function saveBbxForm() {
  const v = { scheduleOn: $("bbxSchedOn").checked, everyHours: Number($("bbxHours").value), shots: $("bbxShots").checked };
  if (!(v.everyHours >= 0.5 && v.everyHours <= 48)) { bbxStatus("Scan every 0.5 to 48 hours.", "error"); $("bbxHours").focus(); return false; }
  bbx.settings = await window.api.bbxSave(v);
  return true;
}
function openBbxModal() {
  fillBbxForm();
  window.api.hideListing();
  hideAmazonPage();
  $("bbxModal").classList.remove("hidden");
  renderBbxModal();
  bbxStatus(bbxLastExport?.error || "", bbxLastExport?.error ? "error" : "");
}
function closeBbxModal() { $("bbxModal").classList.add("hidden"); }
$("mBbxBtn").addEventListener("click", openBbxModal);
$("bbxCancel").addEventListener("click", closeBbxModal);
$("bbxModal").addEventListener("click", (e) => { if (e.target.id === "bbxModal") closeBbxModal(); });
$("bbxModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeBbxModal(); });
$("bbxSave").addEventListener("click", async () => { if (await saveBbxForm()) { closeBbxModal(); renderMarket(); } });
$("bbxFolder").addEventListener("click", async () => {
  const dir = await window.api.bbxPickFolder();
  if (!dir) return;
  bbx.settings = await window.api.bbxSave({ exportDir: dir });
  renderBbxModal();
});
$("bbxFolderOpen").addEventListener("click", () => window.api.bbxOpenExportFolder());
$("incKeys").addEventListener("click", () => { closeBbxModal(); openApiModal("", false); });
$("incRefresh").addEventListener("click", () => refreshIncentives());
$("bbxFolderReset").addEventListener("click", async () => { bbx.settings = await window.api.bbxSave({ exportDir: "" }); renderBbxModal(); });
(async () => {
  try {
    const got = await window.api.bbxGet();
    bbx = { settings: { ...bbx.settings, ...(got?.settings || {}) } };
    // the old once-a-day switch carries over as the new schedule's switch
    if (!localStorage.getItem("bbxSchedMigrated")) {
      localStorage.setItem("bbxSchedMigrated", "1");
      let old = null;
      try { old = JSON.parse(localStorage.getItem("marketSchedule") || "null"); } catch { /* none */ }
      if (old?.on && !bbx.settings.scheduleOn) bbx.settings = await window.api.bbxSave({ scheduleOn: true });
    }
  } catch { /* defaults */ }
  try { setIncentives(await window.api.incentivesGet()); } catch { /* none stored */ }
  bbxLoaded = true;
  renderMarket();
  // a list older than half an hour is read again shortly after launch
  setTimeout(async () => { await refreshApiSettings(); if (keysReady() && Date.now() - wf.at > 30 * 60000) refreshIncentives(); }, 6000);
})();

// ---- Walmart API keys (settings dialog) ---------------------------------------------------
function renderApiBtn() {
  const b = $("mApiBtn");
  if (!b) return;
  b.classList.toggle("attention", !apiReady());
  b.title = apiReady()
    ? `Walmart API connected (${apiSettings.env === "sandbox" ? "sandbox" : "production"}) — the scan adds win rates and suggested prices from Pricing Insights`
    : "Connect your Walmart seller API keys — the scan then adds win rates and suggested prices";
  const scan = $("mScanBtn");
  if (scan) scan.title = apiReady()
    ? "Pull win rates from the Walmart API, read each listing's buy box price and holder, then each linked Amazon listing"
    : "Read each listing's Walmart buy box price and who holds it, then each linked Amazon listing";
}
async function refreshApiSettings() {
  try { apiSettings = await window.api.getApiSettings(); } catch { /* keep defaults */ }
  renderApiBtn();
}
const setApiEnv = (env) => { $("apiSandbox").checked = env === "sandbox"; };
const apiEnvValue = () => ($("apiSandbox").checked ? "sandbox" : "production");
function openApiModal(message, isError) {
  const msg = $("apiMsg");
  msg.textContent = message || "";
  msg.className = "api-msg" + (isError ? " error" : "") + (message ? "" : " hidden");
  const state = $("apiState");
  state.textContent = keysReady() ? (apiSettings.env === "sandbox" ? "Keys saved · sandbox" : "Keys saved") : "Not connected";
  state.className = "api-state " + (keysReady() ? "on" : "off");
  $("apiClientId").value = apiSettings.clientId || "";
  $("apiSecret").value = "";
  $("apiSecret").type = "password";
  $("apiReveal").classList.remove("on");
  $("apiSecret").placeholder = apiSettings.hasSecret ? "Saved — leave blank to keep it" : "Client Secret";
  setApiEnv(apiSettings.env || "production");
  $("apiTestState").textContent = "";
  $("apiTestState").className = "api-test-state";
  $("apiRemove").classList.toggle("hidden", !(apiSettings.clientId || apiSettings.hasSecret));
  window.api.hideListing();
  hideAmazonPage();
  $("apiModal").classList.remove("hidden");
  setTimeout(() => $(apiSettings.clientId ? "apiSecret" : "apiClientId").focus(), 30);
}
function closeApiModal() { $("apiModal").classList.add("hidden"); }
const apiFormValues = () => ({ clientId: $("apiClientId").value.trim(), clientSecret: $("apiSecret").value.trim(), env: apiEnvValue() });

$("apiReveal").addEventListener("click", () => {
  const f = $("apiSecret");
  const show = f.type === "password";
  f.type = show ? "text" : "password";
  $("apiReveal").classList.toggle("on", show);
  $("apiReveal").title = show ? "Hide the secret" : "Show the secret";
  f.focus();
});
$("mApiBtn").addEventListener("click", () => {
  const err = mLastScanApi === "err" ? localStorage.getItem("marketLastApiError") : "";
  openApiModal(err ? `The last scan's Walmart API call failed: ${err}` : "", !!err);
});
$("apiCancel").addEventListener("click", closeApiModal);
$("apiModal").addEventListener("click", (e) => { if (e.target.id === "apiModal") closeApiModal(); });
$("apiModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeApiModal(); });
$("apiKeysLink").addEventListener("click", () => window.api.openApiKeys());
$("apiTest").addEventListener("click", async () => {
  const v = apiFormValues();
  if (!v.clientId || (!v.clientSecret && !apiSettings.hasSecret)) {
    $("apiTestState").textContent = "Enter the Client ID and Client Secret first.";
    $("apiTestState").className = "api-test-state error";
    return;
  }
  $("apiTestState").textContent = "Connecting to Walmart…";
  $("apiTestState").className = "api-test-state";
  $("apiTest").disabled = true;
  const res = await window.api.testApi(v);
  $("apiTest").disabled = false;
  $("apiTestState").textContent = res?.ok
    ? (res.items != null ? `Connected ✓ — Pricing Insights sees ${res.items} item${res.items === 1 ? "" : "s"} in this account.` : "Connected ✓ — Walmart accepted these keys.")
    : (res?.error || "Connection failed.");
  $("apiTestState").className = "api-test-state " + (res?.ok ? "ok" : "error");
});
$("apiSave").addEventListener("click", async () => {
  const v = apiFormValues();
  if (!v.clientId) { $("apiClientId").focus(); return; }
  if (!v.clientSecret && !apiSettings.hasSecret) { $("apiSecret").focus(); return; }
  apiSettings = await window.api.saveApiSettings(v);
  closeApiModal();
  renderMarket();
  refreshIncentives(); // new keys: read the Walmart-funded list right away
});
$("apiRemove").addEventListener("click", async () => {
  apiSettings = await window.api.saveApiSettings({ clear: true });
  closeApiModal();
  renderMarket();
});
[$("apiClientId"), $("apiSecret")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") $("apiSave").click(); }));
refreshApiSettings();
// Run → Stop → Resume: a stopped scan keeps its place (and its screenshot
// folder); Start over drops what's left and begins a new scan.
$("mScanBtn").addEventListener("click", () => {
  if (mScan.running) { mScan.stop = true; renderScanBar(); }
  else if (mResume) runMarketScan(null, { resume: true });
  else runMarketScan();
});
$("mScanOverBtn").addEventListener("click", () => { if (!mScan.running) { mResume = null; runMarketScan(); } });

// ---- schedule: every N hours ------------------------------------------------------------
// While the app is open, a full scan starts by itself N hours after the last
// one started (Buy box check → "Scan every N hours"). If the app was closed
// when one was due, it runs shortly after launch. A scheduled scan stays in
// the background: no tab switch, no pop-up at the end.
function nextScanAt() {
  if (!bbx.settings.scheduleOn) return null;
  const last = Number(localStorage.getItem("marketLastScanStart")) || 0;
  const hours = Math.min(48, Math.max(0.5, Number(bbx.settings.everyHours) || 3));
  return last ? last + hours * 3600000 : Date.now();
}
function scheduleTick() {
  if (!bbxLoaded || mScan.running) return;
  const next = nextScanAt();
  if (next == null || Date.now() < next) return;
  if (!items.some(idOf)) return;
  runMarketScan(null, { auto: true });
}
setInterval(scheduleTick, 30000);
setTimeout(scheduleTick, 20000);

// ---- the Amazon page, shown for a robot check -------------------------------------------
let amazonPageShown = false;
function amazonBounds() {
  const r = $("mPanel").getBoundingClientRect(); // over the listing's panel; the bar to close it is above the list
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
function showAmazonPage(asin) {
  $("mAmzBar").classList.remove("hidden");
  amazonPageShown = true;
  window.api.showAmazon(asin, amazonBounds());
}
function hideAmazonPage() {
  if (!amazonPageShown) return;
  amazonPageShown = false;
  $("mAmzBar").classList.add("hidden");
  window.api.hideAmazon();
}
$("mAmzHide").addEventListener("click", () => { hideAmazonPage(); if (mSelected >= 0) runMarketScan([mSelected]); });
window.addEventListener("resize", () => { if (amazonPageShown) window.api.showAmazon(null, amazonBounds()); });

// ---- Raise rules (settings dialog) -----------------------------------------------------------
let raiseUnit = "$";
const numIn = (id) => { const v = String($(id).value).replace(/[$,%\s]/g, ""); return v === "" ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : NaN); };
function raiseFormValues() {
  return { minGap: numIn("raiseMinGap"), minGapPct: numIn("raiseMinGapPct"), under: numIn("raiseUnder"), underUnit: raiseUnit, round99: $("raiseRound").checked, maxRaise: numIn("raiseMax") };
}
function fillRaiseForm(r) {
  const show = (v) => (v == null || v === "" ? "" : String(v));
  $("raiseMinGap").value = show(r.minGap);
  $("raiseMinGapPct").value = show(r.minGapPct);
  $("raiseUnder").value = show(r.under);
  $("raiseMax").value = show(r.maxRaise);
  $("raiseRound").checked = !!r.round99;
  raiseUnit = r.underUnit === "%" ? "%" : "$";
  renderRaiseForm();
}
// The unit toggle and a worked example that follows the form as you type.
function renderRaiseForm() {
  document.querySelectorAll("#raiseModal .raise-unit button").forEach((b) => b.classList.toggle("on", b.dataset.unit === raiseUnit));
  const v = raiseFormValues();
  const ex = $("raiseExample");
  if ([v.minGap, v.minGapPct, v.under, v.maxRaise].some(Number.isNaN)) { ex.textContent = "Use plain numbers, like 2 or 2.50."; ex.className = "raise-example error"; return; }
  const rules = { ...v, under: v.under ?? 0 };
  const cur = 134.27, next = 164.5;
  const r = raiseFor({ bb: { price: cur, others: 1 }, mine: true, sellers: [{ seller: "Next seller", price: next, mine: false }] }, rules);
  ex.className = "raise-example";
  ex.innerHTML = `Example: you hold the buy box at ${fmt(cur)}, the next seller is at ${fmt(next)} — ${r.ok
    ? `flagged, suggested <b>${fmt(r.target)}</b>.`
    : "not flagged with these rules."}`;
}
function openRaiseModal() {
  fillRaiseForm(raiseRules);
  window.api.hideListing();
  hideAmazonPage();
  $("raiseModal").classList.remove("hidden");
  setTimeout(() => $("raiseMinGap").focus(), 30);
}
function closeRaiseModal() { $("raiseModal").classList.add("hidden"); }
$("mRaiseRulesBtn").addEventListener("click", openRaiseModal);
$("mRaiseBtn").addEventListener("click", () => { mFilter = mFilter === "raise" ? "all" : "raise"; renderMarket(); });
document.querySelectorAll("#raiseModal .raise-unit button").forEach((b) => b.addEventListener("click", () => { raiseUnit = b.dataset.unit; renderRaiseForm(); }));
["raiseMinGap", "raiseMinGapPct", "raiseUnder", "raiseMax"].forEach((id) => $(id).addEventListener("input", renderRaiseForm));
$("raiseRound").addEventListener("change", renderRaiseForm);
$("raiseReset").addEventListener("click", () => fillRaiseForm(RAISE_DEFAULTS));
$("raiseCancel").addEventListener("click", closeRaiseModal);
$("raiseModal").addEventListener("click", (e) => { if (e.target.id === "raiseModal") closeRaiseModal(); });
$("raiseModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeRaiseModal(); if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type === "text") $("raiseSave").click(); });
$("raiseSave").addEventListener("click", () => {
  const v = raiseFormValues();
  const bad = ["raiseMinGap", "raiseMinGapPct", "raiseUnder", "raiseMax"].find((id) => Number.isNaN(numIn(id)));
  if (bad) { $(bad).focus(); return; }
  raiseRules = { ...v, under: v.under ?? 0 };
  localStorage.setItem("raiseRules", JSON.stringify(raiseRules));
  closeRaiseModal();
  renderMarket();
});

// ---- Linnworks mapping import ---------------------------------------------------------------
function renderLwModal(status, kind) {
  const el = $("lwStatus");
  if (status != null) { el.textContent = status; el.className = "status" + (kind ? " " + kind : ""); }
  const matched = items.filter((it) => idOf(it) && lwOf(it)).length;
  const groups = new Set(items.filter((it) => idOf(it) && lwOf(it)).map(lwOf)).size;
  $("lwCurrent").textContent = lwMeta
    ? `${lwMeta.file} · imported ${when(lwMeta.at)} · ${lwMeta.pairs} Walmart SKUs under ${lwMeta.inv} Linnworks SKUs · ${matched} rows here matched into ${groups} groups`
    : "No mapping imported yet — every row stands on its own.";
  $("lwClear").classList.toggle("hidden", !lwMeta);
}
function openLwModal() { renderLwModal("", ""); window.api.hideListing(); hideAmazonPage(); $("lwModal").classList.remove("hidden"); }
function closeLwModal() { $("lwModal").classList.add("hidden"); }
$("mLwBtn").addEventListener("click", openLwModal);
$("lwClose").addEventListener("click", closeLwModal);
$("lwModal").addEventListener("click", (e) => { if (e.target.id === "lwModal") closeLwModal(); });
$("lwModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeLwModal(); });
$("lwChoose").addEventListener("click", async () => {
  renderLwModal("Reading the file…");
  const res = await window.api.importLinnworks();
  if (res?.canceled) { renderLwModal("", ""); return; }
  if (!res || res.error) { renderLwModal(res?.error || "Couldn't read that file.", "error"); return; }
  const map = {};
  const inv = new Set();
  for (const { inv: lw, channel } of res.pairs) { map[String(channel).trim().toLowerCase()] = String(lw).trim(); inv.add(String(lw).trim()); }
  lwMap = map;
  lwMeta = { file: res.file, at: Date.now(), pairs: res.pairs.length, inv: inv.size };
  localStorage.setItem("lwMap", JSON.stringify(lwMap));
  localStorage.setItem("lwMeta", JSON.stringify(lwMeta));
  mergeGroupAmz();
  saveQuiet();
  renderMarket();
  const matched = items.filter((it) => idOf(it) && lwOf(it)).length;
  renderLwModal(`Imported. ${matched} of ${items.filter(idOf).length} rows matched a Linnworks SKU; their Amazon links are now shared within each group.`, "ok");
});
$("lwClear").addEventListener("click", () => {
  if (!confirm("Remove the Linnworks mapping? Rows keep their Amazon links; they just stop being shared.")) return;
  lwMap = {}; lwMeta = null;
  localStorage.removeItem("lwMap"); localStorage.removeItem("lwMeta");
  renderMarket();
  renderLwModal("Mapping removed.", "");
});

// The filter chips beside the search box: All / Losing / Winning / Out of stock / Not read.
function setMarketFilter(f) {
  mFilter = f;
  const shown = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowMatches(i));
  if (!shown.includes(mSelected)) mSelected = shown[0] ?? -1; // the panel follows the filter
  mEditing = null;
  renderMarket();
}
document.querySelectorAll("#mFilters .m-chip").forEach((b) => b.addEventListener("click", () => setMarketFilter(b.dataset.f)));

// ---- filters, search, export ---------------------------------------------------------------
$("mSearch").addEventListener("input", () => { mSearch = $("mSearch").value.trim(); renderMarket(); });
$("mMissedBtn").addEventListener("click", () => { mFilter = mFilter === "missed" ? "all" : "missed"; renderMarket(); });
$("mRetryBtn").addEventListener("click", () => {
  const rows = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowFacts(i).missed);
  if (rows.length) runMarketScan(rows);
});
$("mSearch").addEventListener("keydown", (e) => e.stopPropagation());

// The rows shown (the filter chip and the search in effect), as a sheet.
const FILTER_NAME = { all: "all", lost: "losing", won: "winning", wf: "walmart-funded", oos: "out-of-stock", missed: "not-read" };
function marketRows(indices) {
  return indices.map((i) => {
    const f = rowFacts(i);
    const rival = f.sellers.find((s) => !s.mine) || null;
    const gap = f.me && f.bb && !f.mine ? Math.round((f.me.total - (f.sellers.find((s) => s.isBB)?.total ?? f.bb.price)) * 100) / 100 : "";
    return [f.it.sku, f.it.itemId, f.during > 0 ? f.during : "",
      f.bb ? (f.mine ? "Winning" : f.lost ? "Losing" : "") : f.it.buyBox?.oos ? "Out of stock" : "",
      f.bb ? f.bb.price : "", f.bb ? (f.mine ? myStore : f.bb.seller || "") : "",
      f.me ? f.me.total : "", f.rank ?? "", f.sellers.length || "", gap,
      rival ? rival.seller : "", rival ? rival.total : "",
      f.wf?.status === "enrolled" ? "Funded" : f.wf ? "Eligible" : "",
      f.low ?? "", f.bb?.at ? new Date(f.bb.at).toLocaleString() : "", f.it.note || ""];
  });
}
$("mExportBtn").addEventListener("click", async () => {
  const shown = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowMatches(i));
  if (!shown.length) { alert("No rows are shown to export."); return; }
  const head = ["SKU", "Item ID", "Our Price", "Buy Box", "Buy Box Price", "Buy Box Seller", "My Listed Price", "My Rank", "Sellers", "Above Buy Box By",
    "Lowest Other Seller", "Lowest Other Price", "Walmart-funded", "Amazon Buy Box", "Checked", "Notes"];
  const name = `market-${mFilter === "all" && !mSearch ? "all" : FILTER_NAME[mFilter] || "shown"}`;
  const res = await window.api.exportSheet({ head, rows: marketRows(shown), name, widths: [30, 14, 12, 12, 14, 24, 14, 9, 9, 16, 24, 16, 15, 14, 20, 30] });
  finishExport(res, shown.length);
});

// ---- end-of-scan pop-up ------------------------------------------------------------------------
function summaryRows() {
  return items.map((_, i) => i).filter((i) => idOf(items[i])).map((i) => rowFacts(i)).filter((f) => f.cheaper)
    .sort((a, b) => (b.during - b.low) - (a.during - a.low));
}
// Ticked rows of one pop-up section, exported as CSV or Excel.
function wireSumExport(box, rows, head, toRow, name, widths, csvBtn, xlsxBtn) {
  const go = async (ext) => {
    const picked = [...box.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => rows[Number(c.dataset.k)]);
    if (!picked.length) { alert("Tick at least one row."); return; }
    const out = picked.map(toRow);
    const res = await window.api.exportSheet({ head, rows: out, name, ext, widths });
    finishExport(res, out.length);
  };
  csvBtn.disabled = xlsxBtn.disabled = !rows.length;
  csvBtn.onclick = () => go("csv");
  xlsxBtn.onclick = () => go("xlsx");
}
function showSummary() {
  const all = items.map((_, i) => i).filter(inScope).map(rowFacts); // the listings the scan covers
  const won = all.filter((f) => f.mine).length, lost = all.filter((f) => f.lost).length;
  const unread = all.filter((f) => !f.known).length;
  $("mSumBox").textContent = `You hold the buy box on ${won} of ${all.length} listing${all.length === 1 ? "" : "s"}${lost ? `, and lost it on ${lost}` : ""}${unread ? ` · ${unread} couldn't be told` : ""}.`;

  // Walmart: you hold the buy box with the next seller far above
  const raise = raiseRows();
  const rbox = $("mRaiseRows");
  $("mRaiseText").textContent = raise.length
    ? `On ${raise.length} listing${raise.length === 1 ? "" : "s"} you hold the buy box and the next seller is well above you. Tick the ones to export.`
    : "No listing has room to raise under your raise rules.";
  $("mRaiseTable").classList.toggle("hidden", !raise.length);
  rbox.innerHTML = raise.map(({ f, r }, k) =>
    `<label class="m-sum-row"><input type="checkbox" checked data-k="${k}" /><span class="sku">${esc(f.it.sku || f.it.itemId)}</span><span class="num">${fmt(r.current)}</span><span class="num nx">${fmt(r.next)}<small>${esc(r.nextSeller)}</small></span><span class="num match">${fmt(r.target)}</span></label>`).join("");
  wireSumExport(rbox, raise, ["SKU", "Item ID", "Your Price", "Next Seller", "Next Seller Price", "Gap", "Gap %", "Suggested Price"],
    ({ f, r }) => [f.it.sku, f.it.itemId, r.current, r.nextSeller, r.next, r.gap, Math.round(r.gapPct * 10) / 10, r.target],
    "raise-prices", [26, 14, 12, 24, 16, 10, 10, 16], $("mRaiseCsv"), $("mRaiseXlsx"));

  // Amazon: cheaper than you
  const rows = summaryRows();
  const box = $("mSumRows");
  $("mSumText").textContent = rows.length
    ? `Amazon is cheaper than you on ${rows.length} listing${rows.length === 1 ? "" : "s"}. Tick the ones to export.`
    : "Amazon isn't undercutting any of your listings. Nothing to match today.";
  $("mSumTable").classList.toggle("hidden", !rows.length);
  box.innerHTML = rows.map((f, k) =>
    `<label class="m-sum-row"><input type="checkbox" checked data-k="${k}" /><span class="sku">${esc(f.it.sku || f.it.itemId)}</span><span class="num">${fmt(f.during)}</span><span class="num amz">${fmt(f.low)}</span><span class="num match">${fmt(f.low)}</span></label>`).join("");
  wireSumExport(box, rows, ["SKU", "Item ID", "Our Price", "Amazon Buy Box", "Match Price", "Walmart Buy Box", "Buy Box Seller"],
    (f) => [f.it.sku, f.it.itemId, f.during, f.low, f.low, f.bb ? f.bb.price : "", f.bb ? (f.mine ? myStore : f.bb.seller || "") : ""],
    "amazon-match", [26, 14, 12, 16, 14, 16, 22], $("mSumCsv"), $("mSumXlsx"));

  window.api.hideListing();
  $("mSummary").classList.remove("hidden");
}
function closeSummary() { $("mSummary").classList.add("hidden"); }
$("mSumClose").addEventListener("click", closeSummary);
$("mSumLost").addEventListener("click", () => { closeSummary(); setMarketFilter("lost"); });
$("mRaiseRulesSum").addEventListener("click", () => { closeSummary(); openRaiseModal(); });
$("mSummary").addEventListener("click", (e) => { if (e.target.id === "mSummary") closeSummary(); });
$("mSummary").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeSummary(); });

// ---- keyboard: the sheet's shortcuts stay out of the Market tab ---------------------------------
window.addEventListener("keydown", (e) => {
  if (!inMarket()) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const shown = [...document.querySelectorAll("#mTbody .m-row")];
    const rows = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowMatches(i));
    const at = rows.indexOf(mSelected);
    const ni = Math.min(rows.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    if (rows[ni] != null) { mSelected = rows[ni]; mEditing = null; renderMarket(); shown[ni]?.scrollIntoView({ block: "nearest" }); }
  }
  e.stopImmediatePropagation();
}, true);

// ---- start ---------------------------------------------------------------------------------------
setTab(appTab);
