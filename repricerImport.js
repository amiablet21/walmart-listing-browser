// Reads the items of one Walmart repricer strategy — strictly read-only.
//
// Three sources, all ending in the same rows:
//   { sku, itemId, price, min, max, inventory, status, strategy }
//
//   API     Pricing Insights lists every item with its repricer strategy,
//           min / max price, current price and inventory (walmartApi.js).
//   Seller  a Seller Center page, loaded in a hidden view of the signed-in
//   Center  session. The page is only loaded, scrolled and paged through; the
//           rows come from the data the page itself fetched (captured as it
//           arrives) and, failing that, from the visible table.
//   File    a report downloaded from Seller Center (.xlsx / .csv).
//
// Field names differ between all three and change over time, so every source
// goes through one mapper that recognises a field by its name's shape.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (k) => String(k ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sameName = (a, b) => String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === String(b ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function numOf(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") return numOf(v.amount ?? v.price ?? v.value ?? v.currentPrice ?? null);
  const m = String(v).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function textOf(v) {
  if (v == null) return null;
  if (typeof v === "object") return textOf(v.name ?? v.displayName ?? v.label ?? v.value ?? v.status ?? null);
  const s = String(v).trim();
  return s || null;
}

// First match wins, in this order; `not` keeps look-alikes out.
const FIELDS = [
  ["strategy", /strategy(name|title)?$|^repricerstrategy|^strategy/, /status|id$|type|min|max/, textOf],
  ["sku", /^(seller|partner|vendor|offer|merchant)?sku(id)?$/, null, textOf],
  ["itemId", /^(wm|walmart|us)?itemid$|^itemnumber$|^wmitemid|^itemid/, null, (v) => { const s = String(typeof v === "object" ? "" : v ?? "").trim(); return /^\d{5,}$/.test(s) ? s : null; }],
  ["min", /min(imum)?(seller|item|repricer)?(allowed)?price|pricemin|^min(imum)?(seller)?(allowed)?$|^floor(price)?$|repricermin/, /shipping|order|qty|quantity/, numOf],
  ["max", /max(imum)?(seller|item|repricer)?(allowed)?price|pricemax|^max(imum)?(seller)?(allowed)?$|^ceiling(price)?$|repricermax/, /shipping|order|qty|quantity/, numOf],
  ["price", /^(current|item|selling|your|my|base|offer|seller|list)?price$|^currentprice|^priceamount$/, /min|max|buybox|compet|suggest|ship|compar|reference|was|msrp/, numOf],
  ["inventory", /^(available)?(inventory|qty|quantity|stock)(count|qty|quantity|available|onhand)?$|^onhand(qty|quantity)?$|^inputqty$|^availabletosell/, /min|max|order|status/, numOf],
  ["rpStatus", /repricer.*status|strategy.*status/, null, textOf],
  ["status", /^(item|published|publish|lifecycle|offer|listing)?status$/, null, textOf],
];

// One record (a JSON object, or { header: cell } from a table) → a row, or
// null when it has no SKU. Nested objects are read two levels deep.
function mapRecord(obj) {
  if (!obj || typeof obj !== "object") return null;
  const flat = [];
  const add = (k, v, d, prefix) => {
    flat.push([norm(prefix + k), v]);
    if (prefix) flat.push([norm(k), v]);
    if (v && typeof v === "object" && !Array.isArray(v) && d < 2) for (const k2 in v) add(k2, v[k2], d + 1, prefix + k);
  };
  for (const k in obj) add(k, obj[k], 0, "");
  const out = {};
  for (const [field, re, not, read] of FIELDS) {
    for (const [k, v] of flat) {
      if (!re.test(k) || (not && not.test(k))) continue;
      const val = read(v);
      if (val != null) { out[field] = val; break; }
    }
  }
  if (!out.sku) return null;
  return {
    sku: out.sku, itemId: out.itemId || "", price: out.price ?? null, min: out.min ?? null, max: out.max ?? null,
    inventory: out.inventory ?? null, status: out.rpStatus || out.status || null, strategy: out.strategy || null,
  };
}

// Every list of SKU-bearing records anywhere inside a JSON value.
function findRecords(json, out = []) {
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || typeof o !== "object" || d > 12 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      const objs = o.filter((e) => e && typeof e === "object" && !Array.isArray(e));
      if (objs.length) {
        const mapped = objs.map(mapRecord).filter(Boolean);
        if (mapped.length >= Math.max(1, objs.length * 0.6)) { out.push(...mapped); return; }
      }
      for (const e of o) walk(e, d + 1);
      return;
    }
    for (const k in o) walk(o[k], d + 1);
  };
  walk(json, 0);
  return out;
}

// Rows of a sheet (arrays of cells) → records, using the header row's names.
function recordsFromTable(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /^\s*(seller |partner )?sku\s*$/i.test(String(c ?? ""))) || r.filter((c) => /sku|item\s*id|price/i.test(String(c ?? ""))).length >= 2);
  if (hi < 0) return [];
  const head = rows[hi].map((h) => String(h ?? "").trim());
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const obj = {};
    head.forEach((h, i) => { if (h && String(r[i] ?? "").trim() !== "") obj[h] = r[i]; });
    const rec = mapRecord(obj);
    if (rec) out.push(rec);
  }
  return out;
}

// One row per SKU; later reads fill what earlier ones lacked.
function mergeRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = r.sku.toLowerCase();
    const prev = by.get(k);
    if (!prev) { by.set(k, { ...r }); continue; }
    for (const f of Object.keys(r)) if ((prev[f] == null || prev[f] === "") && r[f] != null && r[f] !== "") prev[f] = r[f];
  }
  return [...by.values()];
}
// Keep the strategy's rows. When no row names a strategy at all, the source
// is taken to be that strategy's own list (`assumed`).
function forStrategy(rows, strategy) {
  const named = rows.filter((r) => r.strategy);
  if (!named.length) return { rows, assumed: true, seen: [] };
  const seen = [...new Set(named.map((r) => r.strategy))];
  return { rows: rows.filter((r) => sameName(r.strategy, strategy)), assumed: false, seen };
}

// ---- Walmart API -------------------------------------------------------------
async function fromApi(client, strategy, onProgress) {
  const all = await client.listPricingInsights(onProgress);
  const rows = all.map((r) => ({
    sku: r.sku, itemId: r.itemId || "", price: r.currentPrice, min: r.repricerMin, max: r.repricerMax,
    inventory: r.inventory, status: r.repricerStatus || null, strategy: r.repricerStrategy || null,
  }));
  const picked = forStrategy(mergeRows(rows), strategy);
  if (picked.assumed) return { error: `Walmart's API returned ${rows.length} item${rows.length === 1 ? "" : "s"} but no repricer strategy names, so the "${strategy}" items can't be told apart. Use the Seller Center page or a report file instead.` };
  if (!picked.rows.length) return { error: `No item in Walmart's API is on a strategy named "${strategy}". Strategies it does list: ${picked.seen.slice(0, 8).join(", ") || "none"}.` };
  return { rows: picked.rows, source: "api" };
}

// ---- Seller Center page --------------------------------------------------------
// The visible table: header cells name the columns, each row becomes a record.
const TABLE_SCRIPT = `(() => {
  const txt = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
  const out = [];
  const tables = new Set();
  document.querySelectorAll('table, [role="grid"], [role="table"], [role="treegrid"]').forEach((t) => tables.add(t));
  for (const t of tables) {
    const heads = [...t.querySelectorAll('th, [role="columnheader"]')].map(txt);
    if (!heads.some((h) => /sku/i.test(h))) continue;
    for (const row of t.querySelectorAll('tr, [role="row"]')) {
      const cells = [...row.querySelectorAll('td, [role="gridcell"], [role="cell"]')].map(txt);
      if (!cells.length) continue;
      const rec = {};
      heads.forEach((h, i) => { if (h && cells[i]) rec[h] = cells[i]; });
      // a cell that packs "SKU: X" / "Item ID: 123" under the item's name
      const all = cells.join(" | ");
      const sku = /\\bSKU:?\\s*([^\\s|]+)/i.exec(all); if (sku && !Object.keys(rec).some((k) => /^sku$/i.test(k.trim()))) rec["SKU"] = sku[1];
      const id = /\\bItem ID:?\\s*(\\d{5,})/i.exec(all); if (id) rec["Item ID"] = id[1];
      out.push(rec);
    }
  }
  return { rows: out, url: location.href, title: document.title, signIn: /login|signin|sign-in/i.test(location.href) || !!document.querySelector('input[type="password"]') };
})()`;
// Scroll every scrolling area to its end so lazily loaded rows arrive.
const SCROLL_SCRIPT = `(() => {
  let moved = 0;
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollHeight - el.clientHeight < 80) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
    const before = el.scrollTop; el.scrollTop = el.scrollTop + el.clientHeight * 0.9;
    if (el.scrollTop !== before) moved++;
  }
  const y = window.scrollY; window.scrollBy(0, window.innerHeight * 0.9); if (window.scrollY !== y) moved++;
  return moved;
})()`;
// The table's own "next page" control, and nothing else: it must be labelled
// exactly as a next-page button. Paging is the only click made in Seller Center.
const NEXT_SCRIPT = `(() => {
  const label = (b) => (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim();
  const btn = [...document.querySelectorAll('button, [role="button"], a[role="button"]')].find((b) => /^(go to )?next( page)?$/i.test(label(b)));
  if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
  btn.click(); return true;
})()`;

async function fromSellerCenter(v, url, strategy, loadAndWait) {
  const wc = v.webContents;
  const dbg = wc.debugger;
  const captured = [];
  const jsonIds = new Set();
  let lastHit = Date.now();
  const onMessage = async (_e, method, params) => {
    try {
      if (method === "Network.responseReceived") {
        const mime = String(params.response?.mimeType || "");
        if (/json/i.test(mime) && /walmart/i.test(String(params.response?.url || ""))) jsonIds.add(params.requestId);
      } else if (method === "Network.loadingFinished" && jsonIds.has(params.requestId)) {
        jsonIds.delete(params.requestId);
        const r = await dbg.sendCommand("Network.getResponseBody", { requestId: params.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
        if (body.length > 20_000_000) return;
        const found = findRecords(JSON.parse(body));
        if (found.length) { captured.push(...found); lastHit = Date.now(); }
      }
    } catch { /* a response that isn't ours to read */ }
  };
  let attached = false;
  try {
    // a view that has never loaded a page doesn't answer debugger commands yet
    if (!wc.getURL()) await loadAndWait(v, "about:blank");
    if (!dbg.isAttached()) { dbg.attach("1.3"); attached = true; }
    dbg.on("message", onMessage);
    await Promise.race([dbg.sendCommand("Network.enable"), wait(4000).then(() => { throw new Error("no answer"); })]);
  } catch { /* fall back to the visible table alone */ }
  const table = [];
  let info = null;
  try {
    await loadAndWait(v, url);
    await wait(3500);
    let quiet = 0, lastCount = -1;
    for (let round = 0; round < 80 && quiet < 3; round++) {
      info = await wc.executeJavaScript(TABLE_SCRIPT, true).catch(() => null);
      if (info?.signIn) break;
      for (const rec of info?.rows || []) { const m = mapRecord(rec); if (m) table.push(m); }
      const count = mergeRows([...captured, ...table]).length;
      quiet = count === lastCount && Date.now() - lastHit > 1500 ? quiet + 1 : 0;
      lastCount = count;
      const moved = await wc.executeJavaScript(SCROLL_SCRIPT, true).catch(() => 0);
      await wait(900);
      if (!moved && quiet >= 1) {
        const paged = await wc.executeJavaScript(NEXT_SCRIPT, true).catch(() => false);
        if (paged) { quiet = 0; await wait(2200); }
      }
    }
  } finally {
    try { dbg.removeListener("message", onMessage); } catch { /* gone */ }
    if (attached) { try { dbg.detach(); } catch { /* gone */ } }
  }
  if (info?.signIn) return { error: "Seller Center asked you to sign in. Open the Seller Center pane (Incentive price list tab → Seller Center), sign in there, then read again.", signIn: true };
  // the page's own data first: it has exact numbers; the table fills the gaps
  const all = mergeRows([...captured, ...table]);
  if (!all.length) return { error: `No items could be read from that Seller Center page (${info?.title || url}). Open the strategy's item list in the Seller Center pane, then use "Use the pane's page" so this reads the same page.`, url: info?.url || url };
  const picked = forStrategy(all, strategy);
  if (!picked.rows.length) return { error: `That page lists ${all.length} item${all.length === 1 ? "" : "s"}, but none on a strategy named "${strategy}". Strategies on it: ${picked.seen.slice(0, 8).join(", ")}.` };
  return { rows: picked.rows, source: "seller", assumed: picked.assumed, url: info?.url || url };
}

// ---- report file ---------------------------------------------------------------
function fromTables(tables, strategy) {
  const all = mergeRows(tables.flatMap(recordsFromTable));
  if (!all.length) return { error: "No rows with a SKU column were found in that file." };
  const picked = forStrategy(all, strategy);
  if (!picked.rows.length) return { error: `The file has ${all.length} item${all.length === 1 ? "" : "s"}, but none on a strategy named "${strategy}". Strategies in it: ${picked.seen.slice(0, 8).join(", ")}.` };
  return { rows: picked.rows, source: "file", assumed: picked.assumed };
}

module.exports = { mapRecord, findRecords, recordsFromTable, mergeRows, forStrategy, fromApi, fromSellerCenter, fromTables, sameName };
