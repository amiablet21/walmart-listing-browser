// Repricer tab — put items on a Walmart repricer strategy and change their
// minimum and maximum, through the Walmart API.
//
// Runs after renderer.js and market.js and shares their globals (items, $, esc,
// fmt, when, money, safe, idOf, rowFacts, wfOf, wfCell, keysReady, appTab …).
//
// This is the one tab that changes something at Walmart, so nothing leaves by
// itself: edits wait in a tray, the send dialog lists every change, and the
// main process enforces the rest (one upload every 10 minutes, a backup before
// each one, and — until it has passed — a one-item test as the first upload).
//
//   rList   the SKUs shown in the tab, in order                (localStorage)
//   rEdits  what you typed, per SKU: { strategy, min, max }    (localStorage)
//   rSent   changes sent and not yet seen back from Walmart     (localStorage)
//   rpr     what Walmart holds, as last read: rpr.state[SKU]    (main process)

const inRepricer = () => appTab === "repricer";
const rTiming = () => ({ firstCheckMs: 5 * 60000, pollMs: 60000, polls: 15, ...(window.__wlbTestTiming || {}) }); // shortened only by the automated tests
const rLoad = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
let rList = rLoad("rprSkus", []);
let rEdits = rLoad("rprEdits", {});
let rSent = rLoad("rprSent", {});
let rpr = { state: {}, readAt: 0, lastSendAt: 0, gateMs: 600000, test: null, sends: [], fileAt: 0, fileRows: 0, fileStrategy: "" };
let rByLower = new Map();
let rFilter = "all", rSearchText = "";
let rBusy = "";      // a read in progress, in words
let rFlow = null;    // an upload being followed: { test, feedId, skus, text }
let rResult = null;  // the last outcome to show: { kind: "ok" | "bad" | "info", html }
const rSave = () => { localStorage.setItem("rprSkus", JSON.stringify(rList)); localStorage.setItem("rprEdits", JSON.stringify(rEdits)); localStorage.setItem("rprSent", JSON.stringify(rSent)); };
function rSetState(d) {
  if (!d || typeof d !== "object") return;
  rpr = { ...rpr, ...d, state: d.state || rpr.state };
  rByLower = new Map(Object.entries(rpr.state).map(([k, v]) => [k.toLowerCase(), v]));
}
const rKey = (sku) => String(sku ?? "").trim().toLowerCase();
const rState = (sku) => rByLower.get(rKey(sku)) || null;
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const rNum = (v) => { const s = String(v ?? "").replace(/[$,\s]/g, ""); return s === "" ? null : (Number.isFinite(Number(s)) ? r2(s) : NaN); };
const rTested = () => rpr.test?.result === "passed";

// What Walmart holds for a SKU, and what the row shows (your edit, or that).
function rBase(sku) {
  const s = rState(sku);
  return { strategy: s && !s.missing ? String(s.strategy || "") : "", min: s?.min ?? null, max: s?.max ?? null };
}
function rVal(sku) {
  const e = rEdits[rKey(sku)], b = rBase(sku);
  return { strategy: e?.strategy ?? b.strategy, min: e?.min ?? (b.min == null ? "" : String(b.min)), max: e?.max ?? (b.max == null ? "" : String(b.max)) };
}
// The change a row asks for: null (none), { invalid } or { sku, strategy, min, max }.
// A row can be edited once Walmart's settings for it are known: a change is
// worked out against them, so an unread or unknown item has nothing to change.
const rEditable = (sku) => { const s = rState(sku); return !!s && !s.missing; };
function rChange(sku) {
  if (!rEdits[rKey(sku)] || !rEditable(sku)) return null;
  const b = rBase(sku), v = rVal(sku);
  const strategy = String(v.strategy || "").trim();
  if (!strategy) return b.strategy ? { sku, strategy: "" } : null;
  const min = rNum(v.min), max = rNum(v.max);
  if (min == null || max == null) return { sku, invalid: "A strategy needs a minimum and a maximum price." };
  if (Number.isNaN(min) || Number.isNaN(max)) return { sku, invalid: "Use plain numbers, like 129.99." };
  if (!(min >= 0.01)) return { sku, invalid: "The minimum must be at least $0.01." };
  if (max < min) return { sku, invalid: "The maximum is below the minimum." };
  const same = strategy.toLowerCase() === b.strategy.toLowerCase() && b.min != null && b.max != null && Math.abs(b.min - min) < 0.005 && Math.abs(b.max - max) < 0.005;
  return same ? null : { sku, strategy, min, max };
}
const rSameChange = (a, b) => !!a && !!b && String(a.strategy || "").toLowerCase() === String(b.strategy || "").toLowerCase()
  && (!a.strategy || (Math.abs(a.min - b.min) < 0.005 && Math.abs(a.max - b.max) < 0.005));
// Changes still to send (a change already sent and awaiting Walmart isn't one).
function rPending() {
  const out = [], bad = [];
  for (const sku of rList) {
    const c = rChange(sku);
    if (!c) continue;
    if (c.invalid) bad.push(c);
    else if (!rSameChange(c, rSent[rKey(sku)]?.change)) out.push(c);
  }
  return { out, bad };
}
const rDescribe = (c, b = rBase(c.sku)) => !c.strategy
  ? `taken off ${b.strategy || "its strategy"}`
  : `${b.strategy && b.strategy.toLowerCase() === c.strategy.toLowerCase() ? "" : `${b.strategy ? "moved to" : "put on"} ${c.strategy} · `}min ${fmt(c.min)}${b.min != null && Math.abs(b.min - c.min) >= 0.005 ? ` (was ${fmt(b.min)})` : ""} · max ${fmt(c.max)}${b.max != null && Math.abs(b.max - c.max) >= 0.005 ? ` (was ${fmt(b.max)})` : ""}`;

// ---- rendering -----------------------------------------------------------------------------
function rRowsShown() {
  const q = rSearchText.toLowerCase();
  return rList.filter((sku) => {
    const b = rBase(sku), c = rChange(sku);
    if (rFilter === "on" && !b.strategy) return false;
    if (rFilter === "off" && b.strategy) return false;
    if (rFilter === "changed" && !c) return false;
    if (rFilter === "wf" && wfOf({ sku })?.status !== "enrolled") return false;
    return !q || sku.toLowerCase().includes(q) || rVal(sku).strategy.toLowerCase().includes(q);
  });
}
function rStatusCell(sku) {
  const s = rState(sku), sent = rSent[rKey(sku)];
  if (sent) return `<span class="m-pill wait" title="Sent ${esc(when(sent.at))}. Walmart applies uploads afterwards; Refresh to see whether it shows yet.">Sent · waiting</span>`;
  if (!s) return `<span class="m-muted">Not read yet</span>`;
  if (s.missing) return `<span class="m-muted" title="Walmart's API has no item under this exact SKU in your account">Not in your Walmart catalog</span>`;
  if (!s.strategy) return `<span class="m-pill off">No strategy</span>`;
  return `<span class="m-pill you" title="Repricer status, as Walmart reports it">${esc(s.status || "On strategy")}</span>`;
}
function rHint(sku, tr) {
  const b = rBase(sku), c = rChange(sku), v = rVal(sku);
  tr.classList.toggle("changed", !!c && !c.invalid);
  tr.classList.toggle("invalid", !!c?.invalid);
  const was = (cls, text) => { const el = tr.querySelector(cls); if (el) el.textContent = text; };
  const edited = !!rEdits[rKey(sku)];
  was(".w-s", edited && String(v.strategy || "").trim().toLowerCase() !== b.strategy.toLowerCase() ? `was ${b.strategy || "none"}` : "");
  was(".w-min", edited && b.min != null && rNum(v.min) !== b.min ? `was ${money(b.min)}` : "");
  was(".w-max", edited && b.max != null && rNum(v.max) !== b.max ? `was ${money(b.max)}` : "");
  was(".w-err", c?.invalid || "");
}
function renderRepricerTab() {
  if (!inRepricer()) { rpSync(); return; } // the Market tab shows the same settings, one listing at a time
  const tb = $("rTbody");
  tb.innerHTML = "";
  const shown = rRowsShown();
  if (!shown.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" class="m-empty">${rList.length ? "No rows match." : "Nothing here yet. Press “Add all from Incentive list”, or add SKUs by hand."}</td>`;
    tb.appendChild(tr);
  }
  const rowOf = new Map(items.map((it, i) => [rKey(it.sku), i]));
  for (const sku of shown) {
    const v = rVal(sku), s = rState(sku);
    const i = rowOf.get(rKey(sku));
    const f = i != null && idOf(items[i]) ? rowFacts(i) : null;
    const bb = f?.bb ? `<span class="m-pill ${f.mine ? "you" : "lost"}">${f.mine ? "You" : "Lost"}</span><b>${fmt(f.bb.price)}</b>${!f.mine && f.bb.seller ? `<span class="m-muted">${esc(f.bb.seller)}</span>` : ""}` : `<span class="m-muted">${i == null ? "Not on the price list" : "Not scanned"}</span>`;
    const tr = document.createElement("tr");
    tr.className = "r-row";
    tr.dataset.sku = sku;
    const off = rEditable(sku) ? "" : " disabled";
    tr.innerHTML =
      `<td class="sku"><button class="r-x" data-x title="Take this row off the tab (nothing changes at Walmart)" aria-label="Remove row">×</button>${esc(sku)}</td>` +
      `<td><input class="r-in r-s" list="rStrategies" value="${esc(v.strategy)}" placeholder="No strategy" aria-label="Strategy for ${esc(sku)}"${off} /><span class="r-was w-s"></span></td>` +
      `<td class="num"><span class="r-was w-min"></span><input class="r-in r-n r-min" inputmode="decimal" value="${esc(v.min)}" aria-label="Minimum price for ${esc(sku)}"${off} /></td>` +
      `<td class="num"><span class="r-was w-max"></span><input class="r-in r-n r-max" inputmode="decimal" value="${esc(v.max)}" aria-label="Maximum price for ${esc(sku)}"${off} /></td>` +
      `<td class="num"><b>${s?.price > 0 ? fmt(s.price) : "—"}</b></td>` +
      `<td class="sep">${bb}</td>` +
      `<td class="sep">${wfCell(wfOf({ sku, itemId: i != null ? items[i].itemId : "" }))}</td>` +
      `<td class="sep">${rStatusCell(sku)}<span class="r-was w-err"></span></td>`;
    rHint(sku, tr);
    tb.appendChild(tr);
  }
  // known strategy names, for the Strategy boxes
  const names = [...new Set([...Object.values(rpr.state).map((s) => s?.strategy).filter(Boolean), ...Object.values(rEdits).map((e) => String(e?.strategy || "").trim()).filter(Boolean)])].sort();
  $("rStrategies").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
  const count = { all: rList.length, on: rList.filter((k) => rBase(k).strategy).length, off: rList.filter((k) => !rBase(k).strategy).length,
    changed: rList.filter((k) => rChange(k)).length, wf: rList.filter((k) => wfOf({ sku: k })?.status === "enrolled").length };
  document.querySelectorAll("#rFilters .m-chip").forEach((b) => { b.classList.toggle("active", rFilter === b.dataset.f); b.querySelector(".n").textContent = ` ${count[b.dataset.f]}`; });
  const fillable = shown.filter(rEditable).length;
  $("rFillN").textContent = `Apply to ${fillable} row${fillable === 1 ? "" : "s"}`;
  $("rLast").textContent = rBusy || (rpr.fileAt ? `${rpr.fileStrategy}: ${rpr.fileRows} items imported ${when(rpr.fileAt)} · ${count.on} of ${count.all} here on a strategy`
    : rpr.readAt ? `Prices read from Walmart ${when(rpr.readAt)} · no strategy imported yet` : "Nothing read yet");
  $("rRefresh").disabled = !!rBusy || !keysReady() || !rList.length;
  renderRTray();
}
function renderRTray() {
  const { out, bad } = rPending();
  const tray = $("rTray"), note = $("rNotice");
  const wait = (rpr.lastSendAt || 0) + (rpr.gateMs || 600000) - Date.now();
  tray.classList.toggle("hidden", !out.length && !bad.length);
  $("rTrayHead").textContent = `${out.length} change${out.length === 1 ? "" : "s"} waiting${bad.length ? ` · ${bad.length} row${bad.length === 1 ? "" : "s"} to fix first` : ""}`;
  $("rTraySub").textContent = rpr.sendsOff ? "Import the strategy's download from Seller Center first (see the note above the table)."
    : !keysReady() ? "Add your Walmart API keys first (Market → Scan settings → API keys…)."
    : rFlow ? "An upload is being checked — wait for it to finish."
    : wait > 0 ? `Walmart takes one upload every 10 minutes. Next one in ${Math.floor(wait / 60000)}:${String(Math.floor((wait % 60000) / 1000)).padStart(2, "0")}.`
    : !rTested() ? "The first upload is a one-item test: one change goes out, and the app checks that only that item changed."
    : "Nothing is sent until you review and confirm.";
  $("rSend").disabled = !out.length || !keysReady() || !!rFlow || wait > 0 || !!rpr.sendsOff;
  $("rSend").textContent = rTested() ? "Review and send…" : "Start the one-item test…";
  // the notice above the table: an upload in progress, its outcome, or an unfinished test
  const unfinished = !rFlow && rpr.test && (rpr.test.result === "sent" || rpr.test.result === "unclear");
  const html = rFlow ? `<span class="m-spin"></span><span>${esc(rFlow.text)}</span>`
    : rResult ? `<span>${rResult.html}</span><button class="mini" id="rResultX" type="button">Dismiss</button>`
    : rpr.sendsOff ? `<span><b>Import your strategy first.</b> Walmart's API gives prices but not an item's strategy, minimum or maximum, so the boxes below are empty and sending is off. Import the strategy's download from Seller Center to see the real settings and switch sending on.</span><button class="mini" id="rImportGo" type="button">Import…</button>`
    : rMoved.length ? `<span>A failed test left ${rMoved.length} item${rMoved.length === 1 ? "" : "s"} changed at Walmart (${rMoved.slice(0, 5).map((m) => esc(m.sku)).join(", ")}${rMoved.length > 5 ? "…" : ""}). Their settings from before are saved.</span><button class="mini" id="rRestore" type="button">Put those ${rMoved.length} back</button>`
    : unfinished && rpr.fileAt ? `<span>The one-item test for <b>${esc(rpr.test.sku)}</b> was sent ${esc(when(rpr.test.at))}. To finish it: in Seller Center clear the search box, <b>Download</b> the strategy again, and import that file here.${rpr.test.note ? ` ${esc(rpr.test.note)}` : ""}</span><button class="mini" id="rImportGo" type="button">Import…</button>`
    : unfinished ? `<span>The one-item test for <b>${esc(rpr.test.sku)}</b> was sent ${esc(when(rpr.test.at))} and hasn't been confirmed yet.${rpr.test.note ? ` ${esc(rpr.test.note)}` : ""}</span><button class="mini" id="rFinish" type="button" ${keysReady() ? "" : "disabled"}>Check it now</button>`
    : "";
  note.className = "r-notice" + (html ? "" : " hidden") + (rFlow ? " busy" : rResult ? ` ${rResult.kind}` : rpr.sendsOff ? " info" : rMoved.length ? " bad" : "");
  if (note.dataset.html !== html) { note.innerHTML = html; note.dataset.html = html; }
  if (!inRepricer()) rpSync();
}
setInterval(() => { if (inRepricer()) renderRTray(); }, 1000);
$("rNotice").addEventListener("click", (e) => {
  if (e.target.id === "rResultX") { rResult = null; renderRTray(); }
  if (e.target.id === "rFinish") rFollow({ test: true, feedId: rpr.test.feedId, skus: [rpr.test.sku], now: true });
  if (e.target.id === "rRestore") rRestore();
  if (e.target.id === "rImportGo") openRImport();
});

// ---- editing ---------------------------------------------------------------------------------
$("rTbody").addEventListener("input", (e) => {
  const tr = e.target.closest("tr.r-row");
  if (!tr || !e.target.classList.contains("r-in")) return;
  const sku = tr.dataset.sku, b = rBase(sku);
  const v = { strategy: tr.querySelector(".r-s").value, min: tr.querySelector(".r-min").value, max: tr.querySelector(".r-max").value };
  const untouched = v.strategy.trim().toLowerCase() === b.strategy.toLowerCase() && rNum(v.min) === b.min && rNum(v.max) === b.max;
  if (untouched) delete rEdits[rKey(sku)]; else rEdits[rKey(sku)] = v;
  delete rSent[rKey(sku)]; // typing over a sent change makes it a new one
  rSave();
  rHint(sku, tr);
  renderRTray();
});
$("rTbody").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && e.target.classList.contains("r-in")) e.target.blur(); });
$("rTbody").addEventListener("click", (e) => {
  if (!e.target.closest("[data-x]")) return;
  const sku = e.target.closest("tr.r-row").dataset.sku;
  rList = rList.filter((k) => k !== sku);
  delete rEdits[rKey(sku)]; delete rSent[rKey(sku)];
  rSave();
  renderRepricerTab();
});
function rAddSkus(skus) {
  const have = new Set(rList.map(rKey));
  let added = 0;
  for (const raw of skus) { const sku = String(raw ?? "").trim(); if (sku && !have.has(rKey(sku))) { rList.push(sku); have.add(rKey(sku)); added++; } }
  rSave();
  renderRepricerTab();
  const unread = rList.filter((k) => !rState(k));
  if (unread.length && keysReady() && !rBusy) rRead(unread);
  return added;
}
$("rAddAll").addEventListener("click", () => {
  $("rAddModal").classList.add("hidden");
  const n = rAddSkus(items.map((it) => it.sku).filter((s) => String(s ?? "").trim()));
  rResult = { kind: "info", html: n ? `Added ${n} SKU${n === 1 ? "" : "s"} from the Incentive price list.${keysReady() ? "" : " Add your Walmart API keys (Market → Scan settings) to read their repricer settings."}` : "Every SKU on the Incentive price list is already here." };
  renderRTray();
});
$("rAdd").addEventListener("click", () => { $("rAddText").value = ""; $("rAddModal").classList.remove("hidden"); setTimeout(() => $("rAddText").focus(), 30); });
$("rAddCancel").addEventListener("click", () => $("rAddModal").classList.add("hidden"));
$("rAddModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") $("rAddModal").classList.add("hidden"); });
$("rAddOk").addEventListener("click", () => {
  rAddSkus($("rAddText").value.split(/[\n,;\t]+/));
  $("rAddModal").classList.add("hidden");
});
document.querySelectorAll("#rFilters .m-chip").forEach((b) => b.addEventListener("click", () => { rFilter = b.dataset.f; renderRepricerTab(); }));
$("rSearch").addEventListener("input", () => { rSearchText = $("rSearch").value.trim(); renderRepricerTab(); });
$("rSearch").addEventListener("keydown", (e) => e.stopPropagation());
$("rDiscard").addEventListener("click", () => {
  if (!confirm("Discard every change you typed here? Nothing has been sent for them.")) return;
  for (const sku of rList) if (!rSent[rKey(sku)]) delete rEdits[rKey(sku)];
  rSave();
  renderRepricerTab();
});
// Fill the rows shown: a strategy, max from the Incentive price, min a percentage under the max.
[$("rFillStrategy"), $("rFillPct")].forEach((el) => el.addEventListener("keydown", (e) => e.stopPropagation()));
$("rFillGo").addEventListener("click", () => {
  const strategy = $("rFillStrategy").value.trim(), useMax = $("rFillMax").checked;
  const pct = rNum($("rFillPct").value);
  if (!strategy && !useMax && pct == null) { $("rFillStrategy").focus(); return; }
  if (pct != null && (Number.isNaN(pct) || pct <= 0 || pct >= 100)) { $("rFillPct").focus(); return; }
  const rowOf = new Map(items.map((it, i) => [rKey(it.sku), i]));
  let n = 0;
  for (const sku of rRowsShown()) {
    if (!rEditable(sku)) continue;
    const v = { ...rVal(sku) };
    if (strategy) v.strategy = strategy;
    const i = rowOf.get(rKey(sku));
    const during = i != null ? safe(i, "during") : 0;
    if (useMax && during > 0) v.max = money(during);
    const max = rNum(v.max);
    if (pct != null && max > 0) v.min = money(r2(max * (1 - pct / 100)));
    rEdits[rKey(sku)] = v; delete rSent[rKey(sku)];
    n++;
  }
  rSave();
  renderRepricerTab();
});

// ---- reading from Walmart ----------------------------------------------------------------------
window.api.onRepricerProgress?.(({ done, total, slowed }) => {
  rBusy = `Reading from Walmart: ${done} of ${total} SKUs${slowed ? " · Walmart asked to slow down, so this takes a few minutes" : ""}`;
  if (inRepricer()) $("rLast").textContent = rBusy; else rpSync();
});
// A sent change that now shows in Walmart's settings is done: the edit has become the fact.
function rReconcile() {
  for (const [k, s] of Object.entries(rSent)) {
    const c = rChange(s.change.sku);
    if (!c || (c && !c.invalid && !rSameChange(c, s.change))) { delete rSent[k]; if (!c) delete rEdits[k]; }
  }
  rSave();
}
async function rRead(skus) {
  if (rBusy) return null;
  rBusy = `Reading from Walmart: 0 of ${skus.length} SKUs`;
  renderRepricerTab();
  const res = await window.api.repricerRead(skus).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  rBusy = "";
  rSetState(res);
  rReconcile();
  if (!res?.ok && res?.error) rResult = { kind: "bad", html: `Couldn't read prices from Walmart: ${esc(res.error)}` };
  else if (res?.ok && skus.length >= 5 && res.read === 0) rResult = { kind: "bad", html: `Walmart answered, but with no item for any of the ${skus.length} SKUs asked about. That points at how the app reads the answer, not at your SKUs. Press <b>Log files</b> and send over <b>repricer-debug.json</b>.` };
  renderRepricerTab();
  return res;
}
$("rRefresh").addEventListener("click", () => rRead(rList));

// ---- importing a strategy's download from Seller Center ------------------------------------------
function openRImport() {
  $("rImportStrategy").value = rpr.fileStrategy || localStorage.getItem("rprStrategy") || "IMRAN BUY BOX 2";
  $("rImportErr").textContent = "";
  $("rImportModal").classList.remove("hidden");
}
$("rImport").addEventListener("click", openRImport);
$("rImportCancel").addEventListener("click", () => $("rImportModal").classList.add("hidden"));
$("rImportModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") $("rImportModal").classList.add("hidden"); });
$("rImportOk").addEventListener("click", async () => {
  const strategy = $("rImportStrategy").value.trim();
  if (!strategy) { $("rImportStrategy").focus(); return; }
  localStorage.setItem("rprStrategy", strategy);
  $("rImportOk").disabled = true;
  try {
    let res = await window.api.repricerImportFile({ strategy }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (res?.short) {
      if (!confirm(`This file has ${res.rows} item${res.rows === 1 ? "" : "s"}; the last import of ${strategy} had ${res.prevRows}.\n\nThat usually means the search box in Seller Center wasn't cleared before downloading. Importing it would treat the other ${res.prevRows - res.rows} as taken off the strategy.${rpr.test && (rpr.test.result === "sent" || rpr.test.result === "unclear") ? "\n\nIf you DID clear the search box, import it: a one-item test is waiting on this file, and items missing from it is exactly what the test is there to catch." : ""}\n\nImport it anyway?`)) { $("rImportErr").textContent = "Not imported. Clear the search box in Seller Center, download again, and choose that file."; return; }
      res = await window.api.repricerImportFile({ strategy, force: true, again: true }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    }
    if (res?.canceled) return;
    if (!res?.ok) { $("rImportErr").textContent = res?.error || "The file couldn't be imported."; return; }
    const before = rpr.test?.before || null;
    rSetState(res);
    rAddSkus(res.skus || []);
    rReconcile();
    $("rImportModal").classList.add("hidden");
    // an import is also how a pending one-item test gets its answer
    if (rpr.test && (rpr.test.result === "sent" || rpr.test.result === "unclear")) {
      const feed = (rpr.sends || []).find((x) => x.feedId === rpr.test.feedId)?.feed || null;
      rResult = await rJudgeTest(feed ? { ok: true, ...feed } : null, { ok: true }, before);
    } else rResult = { kind: "ok", html: `Imported ${res.rows} item${res.rows === 1 ? "" : "s"} on <b>${esc(strategy)}</b> from ${esc(res.file)}. Their real minimum and maximum are in the table.` };
    renderRepricerTab();
  } finally { $("rImportOk").disabled = false; }
});
$("rLogs").addEventListener("click", () => window.api.repricerShowFiles());

// ---- sending -------------------------------------------------------------------------------------
let rToSend = [];
function openRSend() {
  const { out } = rPending();
  if (!out.length) return;
  const test = !rTested();
  $("rSendTitle").textContent = test ? "First, a one-item test" : `Send ${out.length} change${out.length === 1 ? "" : "s"} to Walmart`;
  $("rSendSub").innerHTML = test
    ? (rpr.fileAt
      ? `Before the app sends many changes at once, it sends <b>one</b> and checks the result. It sends this one change and waits for Walmart to process it (about 5 minutes). Then you download the strategy from Seller Center again and import it here, and the app confirms that this item changed and <b>no other item did</b>. Walmart's documentation doesn't say plainly what an upload does to items that aren't in it; this test is how the app finds out safely. A backup of your current settings is saved first.`
      : `Before the app sends many changes at once, it sends <b>one</b> and checks the result. It reads every item on this tab first, sends the one change, waits for Walmart to process it (about 5 minutes), then reads everything again and confirms that this item changed and <b>no other item did</b>. Walmart's documentation doesn't say plainly what an upload does to items that aren't in it; this test is how the app finds out safely. A backup of your current settings is saved first.`)
    : `These go to Walmart as one upload. Walmart applies it afterwards — usually within minutes, and its guide says to allow up to 4 hours for prices to follow. A backup of the current settings is saved first.`;
  $("rSendPickRow").classList.toggle("hidden", !(test && out.length > 1));
  $("rSendPick").innerHTML = out.map((c, k) => `<option value="${k}">${esc(c.sku)}</option>`).join("");
  const list = () => {
    rToSend = test ? [out[Number($("rSendPick").value) || 0]] : out;
    $("rSendList").innerHTML = rToSend.map((c) => `<div class="r-chg"><b>${esc(c.sku)}</b><span>${esc(rDescribe(c))}</span></div>`).join("");
    $("rSendOk").textContent = test ? "Send this one change" : `Send ${rToSend.length} change${rToSend.length === 1 ? "" : "s"}`;
  };
  $("rSendPick").onchange = list;
  list();
  $("rSendErr").textContent = "";
  $("rSendModal").classList.remove("hidden");
}
$("rSend").addEventListener("click", openRSend);
$("rSendCancel").addEventListener("click", () => $("rSendModal").classList.add("hidden"));
$("rSendModal").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") $("rSendModal").classList.add("hidden"); });
$("rSendOk").addEventListener("click", async () => {
  const test = !rTested();
  const sending = rToSend.slice();
  $("rSendOk").disabled = true;
  try {
    if (test && !rpr.fileAt) {
      // the "before" picture: every item on the tab, read fresh
      $("rSendErr").textContent = "Reading every item's current settings first…";
      const read = await rRead(rList);
      if (!read?.ok) { $("rSendErr").textContent = `Nothing was sent. The current settings couldn't be read: ${read?.error || "unknown error"}`; return; }
      const c = rChange(sending[0].sku);
      if (!c || c.invalid) { $("rSendErr").textContent = "Nothing was sent. After reading Walmart's current settings, this row no longer has a change to send."; return; }
      sending[0] = c;
    }
    $("rSendErr").textContent = "Sending…";
    const res = await window.api.repricerSend(sending, { test }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    rSetState(res);
    if (!res?.ok) { $("rSendErr").textContent = `Walmart did not take the upload: ${res?.error || "unknown error"}`; renderRTray(); return; }
    const at = Date.now();
    for (const c of sending) rSent[rKey(c.sku)] = { change: c, feedId: res.feedId, at };
    rSave();
    $("rSendModal").classList.add("hidden");
    rResult = null;
    renderRepricerTab();
    rFollow({ test, feedId: res.feedId, skus: sending.map((c) => c.sku) });
  } finally { $("rSendOk").disabled = false; }
});

// Follow an upload: wait, ask Walmart what became of it, read the items back, say how it went.
const rWait = (ms) => new Promise((r) => setTimeout(r, ms));
async function rFollow({ test, feedId, skus, now }) {
  if (rFlow) return;
  const T = rTiming();
  rFlow = { test, feedId, skus, text: "" };
  const say = (t) => { if (rFlow) rFlow.text = t; renderRTray(); };
  let feed = null;
  try {
    if (!now) {
      const until = Date.now() + T.firstCheckMs;
      while (Date.now() < until) { say(`Sent. Walmart is processing the upload — first check in ${Math.ceil((until - Date.now()) / 60000)} min.`); await rWait(Math.min(15000, Math.max(250, until - Date.now()))); }
    }
    for (let k = 0; k < T.polls; k++) {
      say("Asking Walmart what became of the upload…");
      feed = await window.api.repricerFeed(feedId).catch(() => null);
      if (feed?.ok && /PROCESSED|ERROR/.test(feed.status) && !(feed.processing > 0)) break;
      say(`Walmart is still processing the upload${feed?.ok ? ` (${feed.status.toLowerCase()})` : ""} — checking again in a minute.`);
      await rWait(T.pollMs);
    }
    if (rpr.fileAt) {
      // The settings come from Seller Center's download, so the app can't read them back by itself.
      rFlow = null;
      const errs = rFeedErrors(feed, skus);
      const took = feed?.ok ? ` Walmart's answer: ${esc(feed.status.toLowerCase())}${feed.succeeded != null ? `, ${feed.succeeded} of ${feed.received ?? skus.length} accepted` : ""}.` : " Walmart hasn't confirmed the upload yet.";
      if (test) {
        rResult = errs.length ? await rJudgeTest(feed, { ok: false }, null)
          : { kind: "info", html: `The test change for <b>${esc(skus[0])}</b> was sent.${took} To finish the test: in Seller Center clear the search box, <b>Download</b> the strategy again, and import that file here. <button class="mini" id="rImportGo" type="button">Import…</button>` };
      } else {
        // the test has passed, so what Walmart reports as accepted becomes the current settings
        const res = await window.api.repricerApplyFeed(feedId).catch(() => null);
        if (res) rSetState(res);
        rReconcile();
        for (const x of errs) { delete rSent[rKey(x.sku)]; } // a rejected change goes back to "waiting to be sent"
        rSave();
        const done = (res?.applied || []).length, waiting = skus.filter((k) => rSent[rKey(k)]).length;
        rResult = errs.length
          ? { kind: "bad", html: `${done} of ${skus.length} accepted by Walmart. Rejected: ${errs.slice(0, 4).map((x) => `<b>${esc(x.sku)}</b> — ${esc(x.error || x.state)}`).join("; ")}${errs.length > 4 ? "…" : ""}. The rejected rows still show your edit.` }
          : waiting ? { kind: "info", html: `${skus.length} change${skus.length === 1 ? "" : "s"} sent.${took} ${done} confirmed so far; the rest are marked “Sent · waiting”. Import a fresh download from Seller Center to settle them.` }
          : { kind: "ok", html: `Done: Walmart accepted all ${skus.length} change${skus.length === 1 ? "" : "s"}. They now show as your current settings.` };
      }
      renderRepricerTab();
      return;
    }
    say(test ? "Reading every item again to compare…" : "Reading the changed items back…");
    const before = test ? rpr.test?.before || {} : null;
    const read = await rRead(test ? rList : skus);
    rFlow = null;
    rResult = test ? await rJudgeTest(feed, read, before) : rJudge(feed, read, skus);
  } catch (e) {
    rFlow = null;
    rResult = { kind: "bad", html: `The check stopped: ${esc(String(e?.message || e))}. The upload itself was sent; press Refresh from Walmart to see where things stand.` };
  }
  renderRepricerTab();
}
const rFeedErrors = (feed, skus) => (feed?.items || []).filter((x) => !x.ok && x.state && skus.some((k) => rKey(k) === rKey(x.sku)));
function rJudge(feed, read, skus) {
  const errs = rFeedErrors(feed, skus);
  const waiting = skus.filter((k) => rSent[rKey(k)]).length;
  if (errs.length) return { kind: "bad", html: `Walmart rejected ${errs.length} of ${skus.length}: ${errs.slice(0, 4).map((x) => `<b>${esc(x.sku)}</b> — ${esc(x.error || x.state)}`).join("; ")}${errs.length > 4 ? "…" : ""}` };
  if (!read?.ok) return { kind: "info", html: `The upload was sent, but the items couldn't be read back (${esc(read?.error || "unknown error")}). Press Refresh from Walmart later.` };
  if (waiting) return { kind: "info", html: `Walmart took the upload${feed?.ok ? ` (${esc(feed.status.toLowerCase())})` : ""}. ${skus.length - waiting} of ${skus.length} show the new settings so far; the rest are marked “Sent · waiting”. Press Refresh from Walmart in a while.` };
  return { kind: "ok", html: `Done: all ${skus.length} change${skus.length === 1 ? "" : "s"} now show at Walmart.` };
}
// The one-item test: the item must show what was sent, and nothing else may have moved.
async function rJudgeTest(feed, read, before) {
  const t = rpr.test;
  if (!t) return { kind: "info", html: "No test is on record." };
  const errs = rFeedErrors(feed, [t.sku]);
  const finish = async (result, note) => { rSetState(await window.api.repricerSetTest({ result, note }).catch(() => null)); };
  if (errs.length) {
    delete rSent[rKey(t.sku)]; rSave();
    await finish("failed", `Walmart rejected it: ${errs[0].error || errs[0].state}`);
    return { kind: "bad", html: `Test failed: Walmart rejected the change for <b>${esc(t.sku)}</b> — ${esc(errs[0].error || errs[0].state)}. Nothing else was sent, and nothing changed at Walmart.` };
  }
  if (!read?.ok) { await finish("unclear", "The items couldn't be read back."); return { kind: "info", html: `The test change was sent, but the items couldn't be read back (${esc(read?.error || "unknown error")}). Use “Check it now” in a few minutes.` }; }
  // anything other than the test item that no longer matches the "before" picture
  const moved = [];
  for (const [sku, b] of Object.entries(before || {})) {
    if (rKey(sku) === rKey(t.sku) || !b || b.missing) continue;
    const a = rState(sku);
    if (!a || a.missing) continue;
    if (String(a.strategy || "").toLowerCase() !== String(b.strategy || "").toLowerCase() || (b.strategy && (Math.abs((a.min ?? -1) - (b.min ?? -1)) >= 0.005 || Math.abs((a.max ?? -1) - (b.max ?? -1)) >= 0.005))) moved.push({ sku, b, a });
  }
  if (moved.length) {
    await finish("failed", `${moved.length} other item(s) changed.`);
    rMoved = moved; rSaveMoved();
    return { kind: "bad", html: `Test failed: besides <b>${esc(t.sku)}</b>, ${moved.length} other item${moved.length === 1 ? "" : "s"} changed at Walmart (${moved.slice(0, 5).map((m) => esc(m.sku)).join(", ")}${moved.length > 5 ? "…" : ""}). Sending many changes stays locked. A backup was saved before the test. <button class="mini" id="rRestore" type="button">Put those ${moved.length} back</button>` };
  }
  const now = rState(t.sku), s = t.sent;
  const applied = now && !now.missing && String(now.strategy || "").toLowerCase() === String(s.strategy || "").toLowerCase() && (!s.strategy || (Math.abs((now.min ?? -1) - s.min) < 0.005 && Math.abs((now.max ?? -1) - s.max) < 0.005));
  if (applied) {
    await finish("passed", "");
    return { kind: "ok", html: `Test passed: <b>${esc(t.sku)}</b> shows the new settings at Walmart and no other item changed. You can now send many changes at once.` };
  }
  await finish("unclear", `Walmart took the upload${feed?.ok ? ` (${feed.status.toLowerCase()})` : ""} but the item doesn't show the new settings yet.`);
  return { kind: "info", html: `Walmart took the test upload${feed?.ok ? ` (${esc(feed.status.toLowerCase())})` : ""} and no other item changed, but <b>${esc(t.sku)}</b> doesn't show the new settings yet. Walmart can take a while; ${rpr.fileAt ? "download the strategy again in a few minutes and import it" : "use “Check it now” in a few minutes"}.` };
}
// Items a failed test found changed, with their settings from before it. Kept
// across restarts until they have been sent back.
let rMoved = rLoad("rprMoved", []);
const rSaveMoved = () => localStorage.setItem("rprMoved", JSON.stringify(rMoved));
async function rRestore() {
  if (!rMoved.length) return;
  const wait = (rpr.lastSendAt || 0) + (rpr.gateMs || 600000) - Date.now();
  if (wait > 0) { rResult = { kind: "bad", html: `Walmart takes one upload every 10 minutes, so the saved settings can go back in ${Math.ceil(wait / 60000)} min. <button class="mini" id="rRestore" type="button">Put those ${rMoved.length} back</button>` }; renderRTray(); return; }
  // Everything that was on a strategy before the test goes back in one upload,
  // not only the items seen to change: if an upload replaces whatever it
  // doesn't mention, sending a few would undo the rest again.
  const before = rpr.test?.before || {};
  const all = Object.values(before).filter((b) => b && !b.missing && b.strategy && b.min != null && b.max != null).map((b) => ({ sku: b.sku, strategy: b.strategy, min: b.min, max: b.max }));
  const back = all.length ? all : rMoved.map((m) => ({ sku: m.sku, strategy: m.b.strategy || "", min: m.b.min, max: m.b.max }));
  if (!confirm(`Send the saved settings of ${back.length} item${back.length === 1 ? "" : "s"} (everything that was on a strategy before the test) back to Walmart?`)) return;
  const res = await window.api.repricerSend(back, { restore: true }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
  rSetState(res);
  rResult = res?.ok ? { kind: "info", html: `The saved settings of ${back.length} item${back.length === 1 ? "" : "s"} were sent back. Press Refresh from Walmart in about 10 minutes to confirm.` }
    : { kind: "bad", html: `The saved settings were not sent: ${esc(res?.error || "unknown error")} The backup files are in the app's data folder (repricer-backups). <button class="mini" id="rRestore" type="button">Try again</button>` };
  if (res?.ok) { rMoved = []; rSaveMoved(); }
  renderRepricerTab();
}

// ---- keyboard: the sheet's shortcuts stay out of this tab -------------------------------------------
window.addEventListener("keydown", (e) => {
  if (!inRepricer()) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.stopImmediatePropagation();
}, true);

// ---- start -------------------------------------------------------------------------------------------
(async () => {
  try { rSetState(await window.api.repricerGet()); } catch { /* nothing stored */ }
  if (inRepricer()) renderRepricerTab(); else if (inMarket()) renderMarket();
})();
