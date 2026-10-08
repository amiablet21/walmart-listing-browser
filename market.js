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
let mFilter = "all";      // all | lost | amz | noamz
let mSearch = "";
let mEditing = null;      // { i, k } — Amazon listing whose price is being typed
let mScan = { running: false, done: 0, total: 0, current: "", stop: false, startedAt: 0 };
let mLastScan = Number(localStorage.getItem("marketLastScan")) || 0;
let mLastScanMs = Number(localStorage.getItem("marketLastScanMs")) || 0;
const AMZ_PAUSE_MS = [2000, 3500]; // breathing room between Amazon pages (random in this range)
const WM_PAUSE_MS = 400;

const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const idOf = (it) => String(it?.itemId ?? "").trim();
const fmt = (n) => (Number.isFinite(n) && n > 0 ? "$" + money(n) : "—");
const when = (t) => {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
};

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
function rowFacts(i) {
  const it = items[i];
  const during = safe(i, "during");
  const bb = it.buyBox?.price > 0 ? it.buyBox : null;
  const mine = !!(bb && bb.seller && isMyStore(bb.seller));
  const lost = !!(bb && bb.seller && !mine);
  const low = amzLow(it);
  const cheaper = low != null && during > 0 && low < during - 0.005;
  const sellers = wmSellers(it);
  const wmLow = sellers.length ? sellers[0].price : (bb ? bb.price : null);
  const edge = cheaper ? "red" : lost ? "amber" : bb && mine ? "green" : "none";
  return { it, during, bb, mine, lost, low, cheaper, sellers, wmLow, edge, linked: amzList(it).length };
}
function rowMatches(i) {
  const f = rowFacts(i);
  if (mFilter === "lost" && !f.lost) return false;
  if (mFilter === "amz" && !f.cheaper) return false;
  if (mFilter === "noamz" && f.linked) return false;
  if (mSearch) {
    const q = mSearch.toLowerCase();
    const hay = [f.it.sku, f.it.itemId, f.bb?.seller, ...f.sellers.map((s) => s.seller), ...amzList(f.it).map((a) => a.asin + " " + (a.title || ""))].join(" ").toLowerCase();
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
  for (const i of rows) {
    const f = rowFacts(i);
    const tr = document.createElement("tr");
    tr.className = "m-row edge-" + f.edge + (i === mSelected ? " sel" : "");
    const reading = mScan.running && mScan.current && mScan.currentId === idOf(f.it);
    let wm;
    if (reading && mScan.step === "walmart") wm = `<span class="m-reading"><span class="m-spin"></span>Reading Walmart page…</span>`;
    else if (f.bb) {
      wm = `<span class="m-pill ${f.mine ? "you" : "lost"}">${f.mine ? "You" : "Lost"}</span><b>${fmt(f.bb.price)}</b>${f.mine ? "" : `<span class="m-muted">${esc(f.bb.seller || "")}</span>`}`;
    } else if (f.it.buyBox?.failed) wm = `<span class="m-muted">Couldn't read the page</span>`;
    else wm = `<span class="m-muted">Not scanned yet</span>`;
    let amz;
    if (reading && mScan.step === "amazon") amz = `<span class="m-reading"><span class="m-spin"></span>Reading Amazon page ${mScan.stepN}…</span>`;
    else if (!f.linked) amz = `<span class="m-muted">No listing linked</span><a href="#" class="m-link" data-link="${i}">Link…</a>`;
    else if (f.low != null) amz = `<b>${fmt(f.low)}</b>` + (f.linked > 1 ? `<span class="m-muted">lowest of ${f.linked} linked</span>` : "") + (amzList(f.it).some((a) => a.robot) ? `<span class="m-pill warn" title="Amazon asked for a robot check — open the row to pass it">needs a look</span>` : "");
    else amz = `<span class="m-muted">${amzList(f.it).some((a) => a.robot) ? "Robot check" : f.linked ? "Not read yet" : ""}</span>`;
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
      if (e.target.closest(".m-link")) { e.preventDefault(); $("mLinkInput")?.focus(); }
    });
    tb.appendChild(tr);
  }
  const all = items.map((_, i) => i).filter((i) => idOf(items[i]));
  const counts = { all: all.length, lost: 0, amz: 0, noamz: 0 };
  for (const i of all) { const f = rowFacts(i); if (f.lost) counts.lost++; if (f.cheaper) counts.amz++; if (!f.linked) counts.noamz++; }
  document.querySelectorAll("#mFilters .m-chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.f === mFilter);
    b.querySelector(".n").textContent = counts[b.dataset.f] ? ` · ${counts[b.dataset.f]}` : "";
  });
  $("mLastScan").textContent = mScan.running ? "" : mLastScan ? `Last scan ${when(mLastScan)} · ${items.filter(idOf).length} listings${mLastScanMs ? ` · ${Math.round(mLastScanMs / 1000)} s` : ""}` : "No scan yet";
  renderScanBar();
  renderPanel();
}

function renderScanBar() {
  const btn = $("mScanBtn");
  btn.classList.toggle("scanning", mScan.running);
  btn.querySelector("span").textContent = mScan.running ? "Stop scan" : "Run market scan";
  const prog = $("mProgress");
  prog.classList.toggle("hidden", !mScan.running);
  if (!mScan.running) return;
  $("mProgText").innerHTML = `<b>Reading ${mScan.done + 1} of ${mScan.total}</b> · ${esc(mScan.current)}`;
  const el = Date.now() - mScan.startedAt;
  const left = mScan.done ? Math.round((el / mScan.done) * (mScan.total - mScan.done) / 1000) : null;
  $("mProgLeft").textContent = left != null ? `about ${left >= 90 ? Math.round(left / 60) + " min" : left + " s"} left` : "";
  $("mProgBar").style.width = `${Math.round((mScan.done / Math.max(1, mScan.total)) * 100)}%`;
}

// ---- rendering: the right panel ----------------------------------------------------
function renderPanel() {
  const p = $("mPanel");
  const i = mSelected;
  if (i < 0 || !items[i]) { p.innerHTML = `<div class="m-panel-empty">Click a row to see its Walmart sellers and Amazon listings.</div>`; return; }
  const f = rowFacts(i);
  const it = f.it;
  const list = amzList(it);
  const sellersHtml = f.sellers.length
    ? f.sellers.map((s) => `<div class="m-seller${s.isBB ? " bb" : ""}"><span class="s${s.mine ? " me" : ""}">${esc(s.seller)}${s.mine ? " (you)" : ""}</span>${s.isBB ? `<span class="m-pill bb">Buy box</span>` : ""}<span class="p">${fmt(s.price)}</span></div>`).join("")
    : `<div class="m-seller m-muted">${f.bb ? "Only the buy box could be read" : it.buyBox?.failed ? "The page couldn't be read — open it to check" : "Not scanned yet"}</div>`;
  const amzHtml = list.map((a, k) => {
    const editing = mEditing && mEditing.i === i && mEditing.k === k;
    const meta = a.manual ? `Typed by you${a.at ? " · " + when(a.at) : ""}`
      : a.robot ? `<span class="m-warn">Robot check — pass it below, then re-check</span>`
      : a.failed ? `<span class="m-warn">Couldn't read a price${a.at ? " · " + when(a.at) : ""}</span>`
      : [a.prime ? "Prime" : null, a.seller ? "Sold by " + esc(a.seller) : null, Number.isInteger(a.offers) ? a.offers + " offers" : null, a.at ? when(a.at) : null].filter(Boolean).join(" · ") || "Not read yet";
    const body = editing
      ? `<label class="m-edit"><span>Price</span><input id="mPriceInput" type="text" inputmode="decimal" value="${a.price ? money(a.price) : ""}" /></label>
         <button class="primary mini" data-save="${k}">Save</button><button class="mini" data-cancel="${k}">Cancel</button>`
      : `<b class="m-price">${fmt(a.price)}</b><span class="m-muted">${meta}</span>
         <span class="m-icons">
           <button class="m-icon" data-edit="${k}" title="Type this price by hand" aria-label="Type this price by hand"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
           ${a.asin ? `<button class="m-icon" data-open="${k}" title="Open on Amazon" aria-label="Open on Amazon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></button>` : ""}
           <button class="m-icon" data-unlink="${k}" title="Unlink this listing" aria-label="Unlink this listing"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
         </span>`;
    return `<div class="m-amz${a.robot ? " robot" : ""}">
      <div class="m-amz-top"><span class="mono">${esc(a.asin || "typed")}</span><span class="t">${esc(a.title || (a.manual ? "Typed price" : ""))}</span><span class="m-pill ${a.manual ? "typed" : "auto"}">${a.manual ? "typed" : "auto"}</span></div>
      <div class="m-amz-bot">${body}</div>
      ${a.robot && a.asin ? `<div class="m-amz-robot"><button class="mini" data-show="${k}">Show the Amazon page here</button><span class="m-muted">Pass the check once; later reads go through.</span></div>` : ""}
    </div>`;
  }).join("");
  p.innerHTML = `
    <div class="m-panel-head">
      <div class="m-panel-title"><div class="sku">${esc(it.sku || "(no SKU)")}</div><div class="m-muted">Item ID ${esc(it.itemId)}${f.bb?.at ? " · read " + when(f.bb.at) : ""}</div></div>
      <button id="mRecheck" ${mScan.running ? "disabled" : ""} title="Read this listing's Walmart page and its Amazon listings again now">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg> Re-check
      </button>
    </div>
    <div class="m-stats">
      <div><span>Our price</span><b>${fmt(f.during)}</b></div>
      <div><span>Walmart low</span><b class="wm">${fmt(f.wmLow)}</b></div>
      <div><span>Amazon low</span><b class="amz">${fmt(f.low)}</b></div>
    </div>
    <section>
      <div class="m-sec-head"><span class="dot wm"></span><h3>Walmart sellers</h3><span class="m-muted">${f.sellers.length ? `${f.sellers.length} seller${f.sellers.length === 1 ? "" : "s"}` : ""}</span><a href="#" id="mOpenWm">Open listing</a></div>
      <div class="m-list">${sellersHtml}</div>
      <div class="m-store"><span class="m-muted">Your store on Walmart:</span> <b>${esc(myStore)}</b> <a href="#" id="mStoreEdit">change</a></div>
    </section>
    <section>
      <div class="m-sec-head"><span class="dot amz"></span><h3>Amazon listings</h3><span class="m-muted">${list.length ? `${list.length} linked` : "none linked yet"}</span></div>
      <div class="m-list">
        ${amzHtml}
        <div class="m-add">
          <label for="mLinkInput">Add listing</label>
          <input id="mLinkInput" type="text" placeholder="Paste Amazon URL or ASIN" />
          <button id="mLinkBtn">Link</button>
          <button id="mTypeBtn" title="Add a price you looked up yourself"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg> Type a price</button>
        </div>
      </div>
      <p class="m-muted m-note">Link as many listings as you like (new, international, renewed…). Every one is read on each scan; a typed price stays until you change it or re-check.</p>
    </section>`;
  // wiring
  p.querySelector("#mRecheck")?.addEventListener("click", () => runMarketScan([i]));
  p.querySelector("#mOpenWm")?.addEventListener("click", (e) => { e.preventDefault(); window.api.openExternal(it.itemId); });
  p.querySelector("#mStoreEdit")?.addEventListener("click", (e) => {
    e.preventDefault();
    const name = prompt("Your store name exactly as it appears on Walmart:", myStore);
    if (name != null && name.trim()) { myStore = name.trim(); localStorage.setItem("myStoreName", myStore); renderMarket(); }
  });
  const linkIn = p.querySelector("#mLinkInput");
  const doLink = () => { if (linkAmazon(i, linkIn.value)) linkIn.value = ""; };
  p.querySelector("#mLinkBtn")?.addEventListener("click", doLink);
  linkIn?.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") doLink(); });
  p.querySelector("#mTypeBtn")?.addEventListener("click", () => {
    if (!Array.isArray(it.amz)) it.amz = [];
    it.amz.push({ asin: "", title: "Typed price", price: null, manual: true, at: null });
    mEditing = { i, k: it.amz.length - 1 };
    renderPanel();
    $("mPriceInput")?.focus();
  });
  p.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => { mEditing = { i, k: Number(b.dataset.edit) }; renderPanel(); $("mPriceInput")?.select(); }));
  p.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => {
    const k = Number(b.dataset.cancel);
    if (it.amz[k] && it.amz[k].manual && !it.amz[k].asin && !(it.amz[k].price > 0)) it.amz.splice(k, 1); // abandoned "type a price"
    mEditing = null; saveQuiet(); renderMarket();
  }));
  p.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => savePrice(i, Number(b.dataset.save))));
  p.querySelector("#mPriceInput")?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") savePrice(i, mEditing.k);
    if (e.key === "Escape") { mEditing = null; renderPanel(); }
  });
  p.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => window.api.openAmazon(it.amz[Number(b.dataset.open)].asin)));
  p.querySelectorAll("[data-unlink]").forEach((b) => b.addEventListener("click", () => {
    const k = Number(b.dataset.unlink);
    const a = it.amz[k];
    if (!confirm(`Unlink ${a.asin || "this typed price"} from ${it.sku || it.itemId}?`)) return;
    it.amz.splice(k, 1); mEditing = null; saveQuiet(); renderMarket();
  }));
  p.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => showAmazonPage(it.amz[Number(b.dataset.show)].asin)));
}

function saveQuiet() { window.api.saveItems(items); }

function savePrice(i, k) {
  const it = items[i];
  const a = it?.amz?.[k];
  if (!a) return;
  const v = Number(String($("mPriceInput")?.value ?? "").replace(/[^0-9.]/g, ""));
  if (!(v > 0)) { alert("Enter a price, like 149.99."); $("mPriceInput")?.focus(); return; }
  a.price = Math.round(v * 100) / 100;
  a.manual = true;
  a.failed = false;
  a.robot = false;
  a.at = Date.now();
  mEditing = null;
  saveQuiet();
  renderMarket();
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
  saveQuiet();
  renderMarket();
  // read it right away so the price shows without waiting for the next scan
  if (!mScan.running) readAmazonInto(entry).then(() => { saveQuiet(); renderMarket(); });
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
  entry.at = Date.now();
}

// ---- the scan ----------------------------------------------------------------------
const rnd = (a, b) => a + Math.random() * (b - a);
async function runMarketScan(onlyRows = null) {
  if (mScan.running) return;
  const rows = (onlyRows || items.map((_, i) => i)).filter((i) => idOf(items[i]));
  const ids = [...new Set(rows.map((i) => idOf(items[i])))];
  if (!ids.length) { alert("No rows have an Item ID to look up. Add them on the Incentive price list tab."); return; }
  hideAmazonPage();
  mScan = { running: true, done: 0, total: ids.length, current: "", currentId: "", step: "", stepN: "", stop: false, startedAt: Date.now() };
  const full = !onlyRows;
  renderMarket();
  const amzSeen = new Map(); // asin → read result, so a SKU listed twice reads each ASIN once per scan
  for (const id of ids) {
    if (mScan.stop) break;
    const rowsFor = items.map((_, i) => i).filter((i) => idOf(items[i]) === id);
    const sku = items[rowsFor[0]]?.sku || id;
    mScan.current = `Walmart: ${sku}`; mScan.currentId = id; mScan.step = "walmart";
    renderMarket();
    document.querySelector("#mTbody .m-row.sel")?.scrollIntoView?.({ block: "nearest" });
    const r = await window.api.marketReadWalmart(id).catch(() => null);
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
      amzSeen.set(a.asin, { price: a.price, title: a.title, prime: a.prime, seller: a.seller, offers: a.offers, at: a.at, failed: a.failed, robot: a.robot, unavailable: a.unavailable });
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
    localStorage.setItem("marketLastScan", String(mLastScan));
    localStorage.setItem("marketLastScanMs", String(mLastScanMs));
    localStorage.setItem("marketLastScanDay", new Date().toDateString());
  }
  renderMarket();
  if (full && !stopped) showSummary();
}
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
  const st = $("mSchedState");
  st.textContent = mSched.on ? "on" : "off";
  st.classList.toggle("on", !!mSched.on);
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

// ---- filters, search, export ---------------------------------------------------------------
document.querySelectorAll("#mFilters .m-chip").forEach((b) => b.addEventListener("click", () => { mFilter = b.dataset.f; renderMarket(); }));
$("mSearch").addEventListener("input", () => { mSearch = $("mSearch").value.trim(); renderMarket(); });
$("mSearch").addEventListener("keydown", (e) => e.stopPropagation());

function marketRows() {
  return items.map((_, i) => i).filter((i) => idOf(items[i])).map((i) => {
    const f = rowFacts(i);
    const gap = f.low != null && f.during > 0 ? Math.round((f.low - f.during) * 100) / 100 : "";
    return [f.it.sku, f.it.itemId, f.during > 0 ? f.during : "", f.bb ? f.bb.price : "", f.bb ? (f.mine ? myStore : f.bb.seller || "") : "",
      f.wmLow ?? "", f.sellers.length || "", f.low ?? "", amzList(f.it).map((a) => a.asin || "typed").join(" "), gap, f.bb?.at ? new Date(f.bb.at).toLocaleString() : ""];
  });
}
$("mExportBtn").addEventListener("click", async () => {
  const rows = marketRows();
  if (!rows.length) { alert("Nothing to export yet."); return; }
  const head = ["SKU", "Item ID", "Our Price", "Walmart Buy Box", "Buy Box Seller", "Walmart Lowest", "Walmart Sellers", "Amazon Buy Box", "Amazon Listings", "Gap vs Amazon", "Checked"];
  const res = await window.api.exportSheet({ head, rows, name: "market", widths: [26, 14, 12, 16, 22, 14, 14, 16, 30, 14, 20] });
  finishExport(res, rows.length);
});

// ---- end-of-scan pop-up ------------------------------------------------------------------------
function summaryRows() {
  return items.map((_, i) => i).filter((i) => idOf(items[i])).map((i) => rowFacts(i)).filter((f) => f.cheaper)
    .sort((a, b) => (b.during - b.low) - (a.during - a.low));
}
function showSummary() {
  const rows = summaryRows();
  const box = $("mSumRows");
  $("mSumText").textContent = rows.length
    ? `Amazon is cheaper than you on ${rows.length} listing${rows.length === 1 ? "" : "s"}. Tick the ones to export.`
    : "Amazon isn't undercutting any of your listings. Nothing to match today.";
  box.innerHTML = rows.map((f, k) =>
    `<label class="m-sum-row"><input type="checkbox" checked data-k="${k}" /><span class="sku">${esc(f.it.sku || f.it.itemId)}</span><span class="num">${fmt(f.during)}</span><span class="num amz">${fmt(f.low)}</span><span class="num match">${fmt(f.low)}</span></label>`).join("");
  $("mSumCsv").disabled = $("mSumXlsx").disabled = !rows.length;
  window.api.hideListing();
  $("mSummary").classList.remove("hidden");
  const exportSel = async (ext) => {
    const picked = [...box.querySelectorAll("input[type=checkbox]")].filter((c) => c.checked).map((c) => rows[Number(c.dataset.k)]);
    if (!picked.length) { alert("Tick at least one row."); return; }
    const head = ["SKU", "Item ID", "Our Price", "Amazon Buy Box", "Match Price", "Walmart Buy Box", "Buy Box Seller"];
    const out = picked.map((f) => [f.it.sku, f.it.itemId, f.during, f.low, f.low, f.bb ? f.bb.price : "", f.bb ? (f.mine ? myStore : f.bb.seller || "") : ""]);
    const res = await window.api.exportSheet({ head, rows: out, name: "amazon-match", ext, widths: [26, 14, 12, 16, 14, 16, 22] });
    finishExport(res, out.length);
  };
  $("mSumCsv").onclick = () => exportSel("csv");
  $("mSumXlsx").onclick = () => exportSel("xlsx");
}
function closeSummary() { $("mSummary").classList.add("hidden"); }
$("mSumClose").addEventListener("click", closeSummary);
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
window.api.appVersion().then((v) => { $("mVersion").textContent = "v" + v; });
setTab(appTab);
