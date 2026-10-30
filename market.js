// Market tab — Walmart buy box and Amazon buy box side by side, per SKU.
//
// Runs after renderer.js and shares its globals (items, $, safe, money,
// rememberPrice, markNoPrice, isMyStore, render, dockListing …). All scraping
// lives here: the daily scan walks every row with an Item ID through the
// hidden Walmart worker (buy box, seller, every other seller's price), then
// every Amazon listing linked to that row through the hidden Amazon worker.
// Results are kept on the row: it.buyBox (Walmart) and it.amz (Amazon).
//
//   it.amz = [{ asin, title, price, prime, seller, offers, at, manual, failed, robot }]
//   manual: the price was typed by hand and is never overwritten by a scan.

// ---- tab switching -----------------------------------------------------------
let appTab = localStorage.getItem("appTab") === "market" ? "market" : "sheet";
const inMarket = () => appTab === "market";

// The sheet's own docking must stay quiet while the Market tab is up: the
// native Walmart pane would otherwise paint over the market table.
const baseDockListing = dockListing;
dockListing = function () {
  if (inMarket()) { window.api.hideListing(); return; }
  baseDockListing();
};
const baseRender = render;
render = function () {
  baseRender();
  if (inMarket()) renderMarket();
};

function setTab(t) {
  appTab = t === "market" ? "market" : "sheet";
  localStorage.setItem("appTab", appTab);
  document.body.classList.toggle("market-mode", inMarket());
  document.querySelectorAll(".app-tabs .app-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === appTab));
  if (inMarket()) {
    window.api.hideListing();
    renderMarket();
  } else {
    hideAmazonPage();
    dockListing();
    render();
  }
}
document.querySelectorAll(".app-tabs .app-tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

// ---- state -------------------------------------------------------------------
let mSelected = -1;      // index into items
let mFilter = "all";      // filter chips were removed; the search box is the only filter
let mSearch = "";
let mEditing = null;      // { i, k } — Amazon listing whose price is being typed
let mStoreEditing = false; // the store-name line is a field
let mScan = { running: false, done: 0, total: 0, current: "", stop: false, startedAt: 0 };
let mLastScan = Number(localStorage.getItem("marketLastScan")) || 0;
let mLastScanMs = Number(localStorage.getItem("marketLastScanMs")) || 0;
const AMZ_PAUSE_MS = [2000, 3500]; // breathing room between Amazon pages (random in this range)
const WM_PAUSE_MS = 400;

// Walmart Marketplace API (Pricing Insights). When keys are saved, the scan
// first pulls every SKU's buy box, win rate and suggested price in one batched
// call. Every listing's page is still read, since only the page names who
// holds the buy box.
let apiSettings = { clientId: "", env: "production", hasSecret: false, lastScan: null };
const apiReady = () => !!(apiSettings.clientId && apiSettings.hasSecret);

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
function wmSellers(it) {
  const bb = it.buyBox;
  if (!bb?.price) return [];
  const list = Array.isArray(bb.offers) ? bb.offers.map((o) => ({ seller: o.seller, price: o.price })) : [];
  if (bb.seller && !list.some((o) => Math.abs(o.price - bb.price) < 0.005 && String(o.seller).toLowerCase() === String(bb.seller).toLowerCase())) {
    list.unshift({ seller: bb.seller, price: bb.price });
  }
  list.sort((a, b) => a.price - b.price);
  return list.map((o) => ({ ...o, isBB: bb.seller ? String(o.seller).toLowerCase() === String(bb.seller).toLowerCase() && Math.abs(o.price - bb.price) < 0.005 : false, mine: isMyStore(o.seller) }));
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
const apiOf = (it) => it?.buyBox?.api || null;

function rowFacts(i) {
  const it = items[i];
  const during = safe(i, "during");
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
  const wmLow = sellers.length ? sellers[0].price : (bb ? bb.price : null);
  const edge = cheaper ? "red" : lost ? "amber" : bb && mine ? "green" : "none";
  const wmMissed = !!(it.buyBox?.failed && !bb);
  const amzMissed = amzList(it).some((a) => !a.manual && a.asin && (a.failed || a.robot));
  return { it, during, bb, api, mine, lost, known, low, cheaper, sellers, wmLow, edge, linked: amzList(it).length, missed: wmMissed || amzMissed };
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
    tr.innerHTML = `<td colspan="5" class="m-empty">${items.some(idOf) ? "No rows match this filter." : "Add rows with an Item ID on the Incentive price list tab first."}</td>`;
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
      let amz;
      if (!host.linked) amz = `<button type="button" class="m-link-chip" data-link="${g.members[0]}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Link listing</button>`;
      else if (host.low != null) amz = `<b>${fmt(host.low)}</b>` + (host.linked > 1 ? `<span class="m-muted">lowest of ${host.linked} linked</span>` : "") + (amzList(host.it).some((a) => a.robot) ? `<span class="m-pill warn">needs a look</span>` : "");
      else amz = `<span class="m-muted">${amzList(host.it).some((a) => a.robot) ? "Robot check" : "Not read yet"}</span>`;
      tr.innerHTML =
        `<td class="sku"><span class="m-pill lw" title="Linnworks inventory SKU">LW</span>${esc(g.lw)}</td>` +
        `<td class="m-muted">${g.all.length} Walmart SKUs</td>` +
        `<td class="num"></td>` +
        `<td class="sep">${you ? `<span class="m-pill you">You</span><b>${you}</b>` : ""}${lost ? `${you ? " " : ""}<span class="m-pill lost">Lost</span><b>${lost}</b>` : ""}${!you && !lost ? `<span class="m-muted">Not scanned yet</span>` : ""}</td>` +
        `<td class="sep">${amz}</td>`;
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
    let wm;
    if (reading && mScan.step === "walmart") wm = `<span class="m-reading"><span class="m-spin"></span>Reading Walmart page…</span>`;
    else if (f.bb) {
      const pill = f.known ? `<span class="m-pill ${f.mine ? "you" : "lost"}">${f.mine ? "You" : "Lost"}</span>` : "";
      const note = !f.mine && f.bb.seller ? esc(f.bb.seller)
        : f.api?.winRate != null ? `win rate ${Math.round(f.api.winRate * 10) / 10}%` : "";
      const r = raiseFor(f);
      const raise = r?.ok ? `<span class="m-pill raise" title="Next seller ${esc(r.nextSeller)} is at ${fmt(r.next)} — suggested ${fmt(r.target)}">↑ ${fmt(r.gap)} room</span>` : "";
      wm = `${pill}<b>${fmt(f.bb.price)}</b>${note ? `<span class="m-muted">${note}</span>` : ""}${raise}`;
    } else if (f.it.buyBox?.notInCatalog) wm = `<span class="m-muted">Not in your Walmart catalog under this SKU</span>`;
    else if (f.it.buyBox?.noBuyBox) wm = `<span class="m-muted">No buy box reported</span>`;
    else if (f.it.buyBox?.failed) wm = `<span class="m-muted">Couldn't read the page</span>`;
    else wm = `<span class="m-muted">Not scanned yet</span>`;
    let amz;
    if (reading && mScan.step === "amazon") amz = `<span class="m-reading"><span class="m-spin"></span>Reading Amazon page ${mScan.stepN}…</span>`;
    else if (!f.linked) amz = `<button type="button" class="m-link-chip" data-link="${i}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>Link listing</button>`;
    else if (f.low != null) amz = `<b>${fmt(f.low)}</b>` + (f.linked > 1 ? `<span class="m-muted">lowest of ${f.linked} linked</span>` : "") + (amzList(f.it).some((a) => a.robot) ? `<span class="m-pill warn" title="Amazon asked for a robot check — open the row to pass it">needs a look</span>` : "");
    else amz = `<span class="m-muted">${amzList(f.it).some((a) => a.robot) ? "Robot check" : f.linked ? "Not read yet" : ""}</span>`;
    if (g.grouped) amz = `<span class="m-muted m-shared" title="Amazon links are shared across the Linnworks group">${f.linked ? `shared · ${f.cheaper ? "cheaper than this SKU" : "not cheaper"}` : "shared"}</span>`;
    tr.innerHTML =
      `<td class="sku">${esc(f.it.sku)}</td>` +
      `<td class="mono">${esc(f.it.itemId)}</td>` +
      `<td class="num"><b>${fmt(f.during)}</b></td>` +
      `<td class="sep">${wm}</td>` +
      `<td class="sep">${amz}</td>`;
    tr.addEventListener("click", (e) => {
      mSelected = i;
      mEditing = null;
      renderMarket();
      if (e.target.closest(".m-link-chip")) { e.preventDefault(); $("mLinkInput")?.focus(); }
    });
    tb.appendChild(tr);
  }
  const missedRows = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowFacts(i).missed);
  $("mMissedBtn").classList.toggle("active", mFilter === "missed");
  $("mMissedBtn").classList.toggle("has-missed", missedRows.length > 0);
  $("mMissedBtn").querySelector(".n").textContent = missedRows.length ? ` · ${missedRows.length}` : "";
  $("mRetryBtn").classList.toggle("hidden", !(mFilter === "missed" && missedRows.length && !mScan.running));
  const raiseN = raiseRows().length;
  $("mRaiseBtn").classList.toggle("active", mFilter === "raise");
  $("mRaiseBtn").classList.toggle("has-raise", raiseN > 0);
  $("mRaiseBtn").querySelector(".n").textContent = raiseN ? ` · ${raiseN}` : "";
  if (!mScan.running) $("mLastScan").textContent = mLastScan ? `Last scan ${when(mLastScan)} · ${items.filter(idOf).length} listings${mLastScanMs ? ` · ${Math.round(mLastScanMs / 1000)} s` : ""}${apiScanText()}` : "No scan yet";
  renderApiBtn();
  renderScanBar();
  renderPanel();
}

function renderScanBar() {
  const btn = $("mScanBtn");
  btn.classList.toggle("scanning", mScan.running);
  btn.querySelector("span").textContent = mScan.running ? "Stop scan" : "Run market scan";
  $("mProgress").classList.toggle("hidden", !mScan.running);
  if (!mScan.running) return;
  const el = Date.now() - mScan.startedAt;
  const left = mScan.done ? Math.round((el / mScan.done) * (mScan.total - mScan.done) / 1000) : null;
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
    ? f.sellers.map((s) => `<div class="m-seller${s.isBB ? " bb" : ""}"><span class="s${s.mine ? " me" : ""}">${esc(s.seller)}</span>${s.isBB ? `<span class="m-pill bb">Buy box</span>` : ""}${s.mine ? `<span class="m-pill you">You</span>` : ""}<span class="p">${fmt(s.price)}</span></div>`).join("")
      + (viaApi && it.buyBox.offersAt ? `<div class="m-seller m-muted m-note">Seller names come from the page read ${when(it.buyBox.offersAt)}; the buy box price above is from Walmart's API.</div>` : "")
    : viaApi
      ? `<div class="m-seller m-muted m-note">Walmart's API gives the buy box price, not seller names. <button class="mini" id="mReadPage" ${mScan.running ? "disabled" : ""}>Read the page for sellers</button></div>`
      : `<div class="m-seller m-muted">${f.bb ? "Only the buy box could be read" : it.buyBox?.notInCatalog ? "Walmart's API has no listing under this SKU — check the SKU, or read the page" : it.buyBox?.failed ? "The page couldn't be read — open it to check" : "Not scanned yet"}</div>`;
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
  const lw = lwOf(it);
  const sibs = lw ? groupMembers(i).filter((j) => j !== i) : [];
  const groupLine = lw
    ? `<div class="m-group"><span class="m-pill lw">LW</span><b>${esc(lw)}</b>${sibs.length ? `<span class="m-muted">· also ${sibs.map((j) => `<a href="#sib" data-sib="${j}">${esc(items[j].sku || items[j].itemId)}</a>`).join(", ")}</span>` : `<span class="m-muted">· only this Walmart SKU</span>`}</div>`
    : "";
  p.innerHTML = `
    <div class="m-card m-id">
      <div class="m-id-head">
        <div class="m-id-title"><div class="sku">${esc(it.sku || "(no SKU)")}</div><div class="m-muted">Item ID ${esc(it.itemId)}${it.buyBox?.at ? ` · ${viaApi ? "Walmart API" : "page"} read ${when(it.buyBox.at)}` : ""}${!viaApi && apiReady() && it.buyBox?.notInCatalog ? ` · <span class="m-warn" title="Walmart's Pricing Insights API returned nothing for this SKU, so the scan read the listing page instead. The SKU must match your Seller Center SKU exactly, and the item must be published.">not found in Walmart's API</span>` : ""}</div></div>
        <button class="m-icon" id="mOpenWm" title="Open Walmart listing" aria-label="Open Walmart listing"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></button>
        <button class="m-icon" id="mRecheck" ${mScan.running ? "disabled" : ""} title="Re-check this listing now" aria-label="Re-check this listing now"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg></button>
      </div>
      ${groupLine}
      <div class="m-stats">
        <div><span>Our price</span><b>${fmt(f.during)}</b></div>
        <div><span>Walmart</span><b class="wm">${fmt(f.wmLow)}</b></div>
        <div><span>Amazon</span><b class="amz">${fmt(f.low)}</b></div>
      </div>
      ${apiStats}
    </div>
    <div class="m-card">
      <div class="m-card-head wm"><span class="mark wm">W</span><b>Walmart</b><span class="m-muted">${f.sellers.length ? `${f.sellers.length} seller${f.sellers.length === 1 ? "" : "s"}` : viaApi ? "via API" : ""}</span></div>
      ${sellersHtml}${sellersNote}${raiseHtml}
    </div>
    <div class="m-card">
      <div class="m-card-head amz"><span class="mark amz">a</span><b>Amazon</b><span class="m-muted">${list.length ? `${list.length} listing${list.length === 1 ? "" : "s"} linked` : "no listings linked"}${sibs.length ? ` · shared by ${sibs.length + 1} Walmart SKUs` : ""}</span></div>
      ${amzHtml}
      <div class="m-add">
        <input id="mLinkInput" type="text" placeholder="Paste Amazon URL or ASIN" aria-label="Add Amazon listing" />
        <button id="mLinkBtn">Link</button>
      </div>
    </div>
    <div class="m-card m-notes">
      <div class="m-card-head"><b>Notes</b><span class="m-muted" id="mNoteState"></span></div>
      <textarea id="mNote" rows="3" placeholder="Anything you want to remember about this SKU…" aria-label="Notes for this SKU">${esc(it.note || "")}</textarea>
    </div>
    ${mStoreEditing
      ? `<div class="m-store editing"><span class="m-muted">Your store on Walmart:</span><input id="mStoreInput" type="text" value="${esc(myStore)}" placeholder="Exactly as Walmart shows it" aria-label="Your store name on Walmart" /><span class="m-edit-actions"><button id="mStoreSave" class="primary">Save</button><button id="mStoreCancel">Cancel</button></span></div>`
      : `<div class="m-store"><span class="m-muted">Your store on Walmart:</span> <b>${esc(myStore)}</b> <a href="#" id="mStoreEdit">change</a></div>`}`;
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
function apiScanText() {
  if (mLastScanApi === "off") return " · Walmart API not connected";
  if (mLastScanApi === "err") return " · Walmart API failed (see API)";
  const [got, asked] = mLastScanApi.split("/").map(Number);
  if (!mLastScanApi || mLastScanApi === "0") return "";
  if (!(asked > 0)) return " · with Walmart API";
  return got === asked ? " · Walmart API knew every SKU" : ` · Walmart API knew ${got} of ${asked} SKUs`;
}
window.api.onApiProgress?.(({ done, total }) => {
  if (mScan.running && mScan.step === "api") { mScan.current = `Walmart API: ${done} of ${total} SKUs`; renderScanBar(); }
});
// One page read for a single row (seller names), outside a full scan.
async function readPageFor(i) {
  if (mScan.running) return;
  const id = idOf(items[i]);
  if (!id) return;
  mScan = { running: true, done: 0, total: 1, current: `Walmart: ${items[i].sku || id}`, currentId: id, step: "walmart", stepN: "", stop: false, startedAt: Date.now(), pageOnly: true };
  renderMarket();
  const r = await window.api.marketReadWalmart(id, { allSellers: true }).catch(() => null);
  if (r && r.price) rememberPrice(r); else markNoPrice(id);
  mScan.running = false; mScan.currentId = "";
  renderMarket();
}
async function runMarketScan(onlyRows = null) {
  if (mScan.running) return;
  const rows = (onlyRows || items.map((_, i) => i)).filter((i) => idOf(items[i]));
  const ids = [...new Set(rows.map((i) => idOf(items[i])))];
  if (!ids.length) { alert("No rows have an Item ID to look up. Add them on the Incentive price list tab."); return; }
  hideAmazonPage();
  mScan = { running: true, done: 0, total: ids.length, current: "", currentId: "", step: "", stepN: "", stop: false, startedAt: Date.now() };
  const full = !onlyRows;
  renderMarket();
  // 1) Walmart API — every SKU in one go
  let usedApi = apiReady() ? "" : "off";
  if (apiReady()) {
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
  for (const id of ids) {
    if (mScan.stop) break;
    const rowsFor = items.map((_, i) => i).filter((i) => idOf(items[i]) === id);
    const sku = items[rowsFor[0]]?.sku || id;
    mScan.currentId = id;
    // 2) page read: the buy box price and who holds it
    mScan.current = `Walmart: ${sku}`; mScan.step = "walmart";
    renderMarket();
    const r = await window.api.marketReadWalmart(id, { store: myStore }).catch(() => null);
    if (mScan.stop) break;
    if (r && r.price) rememberPrice(r); else markNoPrice(id);
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
  const stopped = mScan.stop;
  mScan.running = false;
  mScan.currentId = "";
  if (full && !stopped) {
    mLastScan = Date.now();
    mLastScanMs = mLastScan - mScan.startedAt;
    mLastScanApi = usedApi;
    localStorage.setItem("marketLastScan", String(mLastScan));
    localStorage.setItem("marketLastScanMs", String(mLastScanMs));
    localStorage.setItem("marketLastScanDay", new Date().toDateString());
    localStorage.setItem("marketLastScanApi", usedApi);
  }
  const apiError = mScan.apiError, apiNone = mScan.apiNone;
  renderMarket();
  if (apiError) openApiModal(`The Walmart API part of the scan failed, so win rates and suggested prices are missing (buy boxes were read from the pages as usual). ${apiError}`, true);
  else if (apiNone) openApiModal(`Walmart's API connected, but returned nothing for any of your ${apiNone} SKU${apiNone === 1 ? "" : "s"}, so there are no win rates or suggested prices (buy boxes were read from the pages as usual). Pricing Insights only covers published items in this seller account, looked up by the exact SKU in Seller Center — check the SKUs match, and that these keys belong to the same account.`, true);
  else if (full && !stopped) showSummary();
}

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
  state.textContent = apiReady() ? (apiSettings.env === "sandbox" ? "Connected · sandbox" : "Connected") : "Not connected";
  state.className = "api-state " + (apiReady() ? "on" : "off");
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
});
$("apiRemove").addEventListener("click", async () => {
  apiSettings = await window.api.saveApiSettings({ clear: true });
  closeApiModal();
  renderMarket();
});
[$("apiClientId"), $("apiSecret")].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") $("apiSave").click(); }));
refreshApiSettings();
$("mScanBtn").addEventListener("click", () => { if (mScan.running) { mScan.stop = true; $("mScanBtn").querySelector("span").textContent = "Stopping…"; } else runMarketScan(); });

// ---- daily schedule -------------------------------------------------------------------
// While the app is open, the scan starts by itself at the chosen time, once a
// day. If the app was opened after that time and today's scan hasn't run, it
// runs shortly after launch.
let mSched = { on: false, time: "09:00" };
try { mSched = { ...mSched, ...(JSON.parse(localStorage.getItem("marketSchedule") || "{}") || {}) }; } catch { /* default */ }
$("mSchedOn").checked = !!mSched.on;
$("mSchedTime").value = /^\d{2}:\d{2}$/.test(mSched.time) ? mSched.time : "09:00";
function renderSched() {
  document.querySelector(".m-sched").classList.toggle("on", !!mSched.on);
}
function saveSched() {
  mSched = { on: $("mSchedOn").checked, time: $("mSchedTime").value || "09:00" };
  localStorage.setItem("marketSchedule", JSON.stringify(mSched));
  renderSched();
}
renderSched();
$("mSchedOn").addEventListener("change", saveSched);
$("mSchedTime").addEventListener("change", saveSched);
function scheduleTick(atLaunch = false) {
  if (!mSched.on || mScan.running) return;
  const today = new Date().toDateString();
  if (localStorage.getItem("marketLastScanDay") === today) return;
  const [h, m] = mSched.time.split(":").map(Number);
  const now = new Date();
  const due = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  if (!due) return;
  if (!atLaunch && (now.getHours() !== h || now.getMinutes() !== m)) return; // only at the minute itself while running; the launch check catches the rest
  if (!items.some(idOf)) return;
  setTab("market");
  runMarketScan();
}
setInterval(() => scheduleTick(false), 30000);
setTimeout(() => scheduleTick(true), 20000);

// ---- the Amazon page, shown for a robot check -------------------------------------------
let amazonPageShown = false;
function amazonBounds() {
  const r = $("mTableWrap").getBoundingClientRect();
  const bar = $("mAmzBar").getBoundingClientRect();
  return { x: r.left, y: bar.bottom, width: r.width, height: r.bottom - bar.bottom };
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

// ---- filters, search, export ---------------------------------------------------------------
$("mSearch").addEventListener("input", () => { mSearch = $("mSearch").value.trim(); renderMarket(); });
$("mMissedBtn").addEventListener("click", () => { mFilter = mFilter === "missed" ? "all" : "missed"; renderMarket(); });
$("mRetryBtn").addEventListener("click", () => {
  const rows = items.map((_, i) => i).filter((i) => idOf(items[i]) && rowFacts(i).missed);
  if (rows.length) runMarketScan(rows);
});
$("mSearch").addEventListener("keydown", (e) => e.stopPropagation());

function marketRows() {
  return items.map((_, i) => i).filter((i) => idOf(items[i])).map((i) => {
    const f = rowFacts(i);
    const gap = f.low != null && f.during > 0 ? Math.round((f.low - f.during) * 100) / 100 : "";
    const a = apiOf(f.it) || {};
    const r = raiseFor(f);
    return [f.it.sku, f.it.itemId, f.during > 0 ? f.during : "", f.bb ? f.bb.price : "", f.bb ? (f.mine ? myStore : f.bb.seller || (f.lost ? "another seller" : "")) : "",
      f.wmLow ?? "", f.sellers.length || "", f.low ?? "", amzList(f.it).map((a) => a.asin || "typed").join(" "), gap, f.bb?.at ? new Date(f.bb.at).toLocaleString() : "",
      a.winRate ?? "", a.competitorPrice ?? "", a.suggestedPrice ?? "", lwOf(f.it) || "",
      r?.nextSeller ?? "", r?.next ?? "", r?.ok ? r.target : ""];
  });
}
$("mExportBtn").addEventListener("click", async () => {
  const rows = marketRows();
  if (!rows.length) { alert("Nothing to export yet."); return; }
  const head = ["SKU", "Item ID", "Our Price", "Walmart Buy Box", "Buy Box Seller", "Walmart Lowest", "Walmart Sellers", "Amazon Buy Box", "Amazon Listings", "Gap vs Amazon", "Checked",
    "Win Rate %", "Competitor Price", "Suggested Price", "Linnworks SKU", "Next Seller", "Next Seller Price", "Raise To"];
  const res = await window.api.exportSheet({ head, rows, name: "market", widths: [26, 14, 12, 16, 22, 14, 14, 16, 30, 14, 20, 12, 14, 14, 26, 24, 16, 12] });
  finishExport(res, rows.length);
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
  const all = items.map((_, i) => i).filter((i) => idOf(items[i])).map(rowFacts);
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
