// Renderer: spreadsheet-style incentive price list. Clicking a row docks that
// item's live Walmart listing in the right pane. Cells are editable
// (double-click); $ Change and % Change recompute automatically.
const $ = (id) => document.getElementById(id);

// The initial sheet data (SKU, item ID, before price, during-incentive price).
// $ Change and % Change are computed: change = during − before, % = change / before.
const SEED_VERSION = "1";
const SEED = [
  ["T227U",                      "712535618",   127.80, 122.49],
  ["UTSMT220",                   "157381628",   125.80, 120.44],
  ["SM-X133-64GB-GREY",          "17977102065", 133.10, 127.49],
  ["X13364GBSILVER-INTL",        "17981657425", 145.60, 139.49],
  ["X133-128GB-GRAY",            "20183771747", 209.00, 199.99],
  ["X133-128GB-SILVER",          "20218702698", 209.00, 199.99],
  ["X135-64GB-GRAY-LTE",         "19238174747", 160.00, 152.99],
  ["X135-64GB-SILVER",           "19231616180", 187.00, 177.99],
  ["TABA9+64GB",                 "5166665540",  192.40, 183.99],
  ["Galaxy Tab A9+ 128GB",       "5166665538",  281.00, 266.99],
  ["X230-128GB-BLACK",           "18250561124", 260.00, 247.99],
  ["x230Silver",                 "18089905174", 276.00, 259.99],
  ["x230256gbGREY",              "18233967193", 312.00, 297.99],
  ["X230256GB sILVER",           "18287160379", 312.00, 297.99],
  ["X400-128GB-SILVER",          "16262509271", 363.00, 344.99],
  ["X400-128GB-GRAY",            "16913906387", 363.00, 344.99],
  ["X400-128GB-SILVER-INTL-VER", "17834906716", 379.20, 359.99],
  ["X400-128GB-BLACK-INTL-VER",  "17766259664", 364.00, 347.99],
  ["X400128GBRED-INTL",          "17834956635", 364.00, 347.99],
  ["X400-128-GRAY-CASE",         "18939553807", 432.20, 409.99],
  ["X400-CASE-GRAY-2",           "19292304408", 432.20, 409.99],
  ["X400-256GB-SILVER",          "17335308877", 405.60, 387.99],
  ["X400256GBSILV-INTL",         "17835006626", 405.60, 387.99],
  ["X400256GBRED-INTL",          "17795750902", 405.60, 387.99],
  ["X406-128GB-GRAY-INT",        "19623717396", 400.80, 382.99],
  ["X520-128GB-BLUE",            "15502755529", 416.00, 397.99],
  ["X520-128GB-GREY",            "15455000416", 401.10, 383.99],
  ["X520-128GB-SILVER",          "15481861948", 416.00, 397.99],
  ["X520-256GB-BLUE-US",         "15458124293", 540.00, 515.99],
  ["X520-256GB-SILVER-US",       "15460769282", 540.00, 515.99],
  ["X520-256GB-GRAY-US",         "15455050627", 540.00, 515.99],
  ["X520-128GB-BLUE-INTL-VER",   "16501650055", 442.00, 422.99],
].map(([sku, itemId, before, during]) => ({ sku, itemId, before, during }));

let items = [];        // [{ sku, itemId, before, during }]
let selected = -1;     // index into items
let dragFrom = -1;     // row index being dragged, -1 when idle
let activeCell = null; // { i, field } — the clicked cell (Sheets-style focus)

// find (Ctrl+F) state
let findTerm = "";
let findMatches = []; // [{ i, field }]
let findIdx = -1;

// undo/redo history — snapshots of `items` taken before each mutation
let undoStack = [];
let redoStack = [];

// run a mutation of `items`; if it actually changed anything, record the
// pre-mutation snapshot for Ctrl+Z
function applyMutation(fn) {
  const before = JSON.stringify(items);
  fn();
  if (JSON.stringify(items) !== before) {
    undoStack.push(JSON.parse(before));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }
}

function afterHistory() {
  if (selected >= items.length) selected = -1;
  if (activeCell && activeCell.i >= items.length) activeCell = null;
  persist();
  render();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.parse(JSON.stringify(items)));
  items = undoStack.pop();
  afterHistory();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.parse(JSON.stringify(items)));
  items = redoStack.pop();
  afterHistory();
}

// ---- custom columns --------------------------------------------------------
// User-added columns after F (G, H, …). Definitions live in localStorage;
// each row's values live on the item under item.custom[key].
let customCols = [];
try { customCols = JSON.parse(localStorage.getItem("customCols") || "[]") || []; } catch { customCols = []; }
const saveCols = () => localStorage.setItem("customCols", JSON.stringify(customCols));

const BASE_FIELDS = ["sku", "itemId", "before", "during", "change", "pct", "regCom", "incCom"];

// per-row commission rates (%) — defaults for rows that don't specify them
const DEFAULT_REG_COM = 6;
const DEFAULT_INC_COM = 2;
function fillComs(it) {
  if (it.regCom == null || it.regCom === "") it.regCom = DEFAULT_REG_COM;
  if (it.incCom == null || it.incCom === "") it.incCom = DEFAULT_INC_COM;
  return it;
}
const newRow = () => ({ sku: "", itemId: "", before: 0, during: 0, regCom: DEFAULT_REG_COM, incCom: DEFAULT_INC_COM });
let FIELD_ORDER = [...BASE_FIELDS];
function rebuildFieldOrder() { FIELD_ORDER = [...BASE_FIELDS, ...customCols.map((c) => "c_" + c.key)]; }
rebuildFieldOrder();

// raw stored value of any cell (custom columns live under item.custom)
function getRaw(i, field) {
  return field.startsWith("c_") ? items[i]?.custom?.[field.slice(2)] : items[i]?.[field];
}

// ---- column widths (drag the edge of a header to resize) -------------------
let colWidths = {};
try { colWidths = JSON.parse(localStorage.getItem("colWidths") || "{}") || {}; } catch { colWidths = {}; }
const DEFAULT_W = { sku: 190, itemId: 115, before: 95, during: 115, change: 85, pct: 85, regCom: 90, incCom: 90 };
const colW = (f) => colWidths[f] || DEFAULT_W[f] || 110;

function addResizeHandle(th, field) {
  const h = document.createElement("span");
  h.className = "resize-h";
  h.title = "Drag to resize column";
  h.addEventListener("dblclick", (e) => e.stopPropagation());
  h.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = th.offsetWidth;
    document.body.classList.add("col-resizing");
    const move = (ev) => {
      // mouse moves in screen px; the sheet may be zoomed. The table is fixed
      // at 100% width, so widths act as weights — growing this column
      // automatically shrinks the others to keep everything in view.
      const w = Math.max(40, Math.round(startW + (ev.clientX - startX) / sheetZoom));
      colWidths[field] = w;
      th.style.width = w + "px";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      localStorage.setItem("colWidths", JSON.stringify(colWidths));
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  th.appendChild(h);
}

const BASE_LETTER = { sku: "A", itemId: "B", before: "C", during: "D", change: "E", pct: "F", regCom: "G", incCom: "H" };
function fieldToLetter(f) {
  if (BASE_LETTER[f]) return BASE_LETTER[f];
  const idx = customCols.findIndex((c) => "c_" + c.key === f);
  return idx >= 0 ? String.fromCharCode(73 + idx) : "?";
}
function letterToField(L) {
  const inv = { A: "sku", B: "itemId", C: "before", D: "during", E: "change", F: "pct", G: "regCom", H: "incCom" };
  if (inv[L]) return inv[L];
  const idx = L.charCodeAt(0) - 73; // I is the first custom column
  return customCols[idx] ? "c_" + customCols[idx].key : null;
}

// ---- persistence -----------------------------------------------------------
async function load() {
  const saved = await window.api.listItems();
  if (localStorage.getItem("seedVersion") === SEED_VERSION && saved.length) {
    items = saved;
  } else {
    // first run with this sheet (or older data format) — load the sheet
    items = SEED.slice();
    persist();
    localStorage.setItem("seedVersion", SEED_VERSION);
  }
  items.forEach(fillComs); // rows saved before commission columns existed
  render();
  // seller mode doesn't depend on a row being selected — show it right away
  if (paneMode === "seller") dockListing();
}
let saveFlashTimer = null;
function persist() {
  window.api.saveItems(items);
  // flash the "Saved ✓" indicator so every change is visibly saved
  const el = $("saveState");
  if (el) {
    el.classList.add("show");
    clearTimeout(saveFlashTimer);
    saveFlashTimer = setTimeout(() => el.classList.remove("show"), 1400);
  }
}

// Move a row to a new position (insertion index before removal), keeping the
// same listing selected.
function moveItem(from, to) {
  applyMutation(() => {
    const selectedItem = items[selected] || null;
    const [moved] = items.splice(from, 1);
    if (to > from) to--;
    items.splice(to, 0, moved);
    if (selectedItem) selected = items.indexOf(selectedItem);
  });
  persist();
  render();
}

function removeRow(i) {
  applyMutation(() => {
    items.splice(i, 1);
    if (selected === i) {
      selected = -1;
      dockListing();
    } else if (selected > i) {
      selected--;
    }
  });
  persist();
  render();
}

// ---- formatting ------------------------------------------------------------
const money = (n) => (Number.isFinite(n) ? n.toFixed(2) : "#ERR");
const chDollar = (n) => (!Number.isFinite(n) ? "#ERR" : n < 0 ? `($${Math.abs(n).toFixed(2)})` : `$${n.toFixed(2)}`);
const chPct = (n) => (!Number.isFinite(n) ? "#ERR" : n < 0 ? `(${Math.abs(n).toFixed(1)}%)` : `${n.toFixed(1)}%`);
const comPct = (n) => (Number.isFinite(n) ? `${Math.round(n * 100) / 100}%` : "#ERR");

// ---- formula engine --------------------------------------------------------
// Price cells accept "=" formulas with A1-style refs matching the sheet's
// columns: C=Before Price, D=During Incentive, E=$ Change, F=% Change.
// Sheet row 1 is the header, so C2 = the first data row's Before Price.
// Supported: + - * / ( ), ranges (C2:C10), SUM, AVERAGE, MIN, MAX, ROUND, ABS.
function fieldValue(i, field, stack = new Set()) {
  if (field === "change" || field === "pct") {
    const rawE = items[i][field];
    if (rawE == null || rawE === "") {
      // built-in equations: E = D − C, F = (D − C) ÷ C × 100
      if (field === "change") return fieldValue(i, "during", stack) - fieldValue(i, "before", stack);
      const b = fieldValue(i, "before", stack);
      if (!b) return 0;
      return ((fieldValue(i, "during", stack) - b) / b) * 100;
    }
    // a per-cell override exists — falls through and evaluates like any cell
  }
  const key = i + ":" + field;
  if (stack.has(key)) throw new Error("circular reference");
  stack.add(key);
  try {
    const raw = getRaw(i, field);
    if (typeof raw === "string" && raw.trim().startsWith("=")) {
      return evalFormula(raw.trim().slice(1), stack);
    }
    return Number(raw) || 0;
  } finally {
    stack.delete(key);
  }
}

function refValue(col, row, stack) {
  const field = letterToField(col);
  const idx = row - 2;                    // sheet row 2 = first data row
  if (!field || idx < 0 || idx >= items.length) throw new Error("bad reference");
  return fieldValue(idx, field, stack);
}

const FORMULA_FUNCS = {
  SUM: (...a) => a.reduce((x, y) => x + y, 0),
  AVERAGE: (...a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0),
  AVG: (...a) => FORMULA_FUNCS.AVERAGE(...a),
  MIN: (...a) => Math.min(...a),
  MAX: (...a) => Math.max(...a),
  ROUND: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n,
  ABS: (x) => Math.abs(x),
};

// Tiny arithmetic parser (recursive descent) — the page's CSP forbids
// eval/new Function, so formulas are evaluated by hand: numbers, + - * / ( ),
// unary minus, and whitelisted functions with comma-separated args.
function evalExpr(src) {
  let pos = 0;
  const skip = () => { while (src[pos] === " ") pos++; };
  function parseExpr() {
    let v = parseTerm();
    skip();
    while (src[pos] === "+" || src[pos] === "-") {
      const op = src[pos++];
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
      skip();
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    skip();
    while (src[pos] === "*" || src[pos] === "/") {
      const op = src[pos++];
      const r = parseFactor();
      v = op === "*" ? v * r : v / r;
      skip();
    }
    return v;
  }
  function parseFactor() {
    skip();
    if (src[pos] === "-") { pos++; return -parseFactor(); }
    if (src[pos] === "+") { pos++; return parseFactor(); }
    if (src[pos] === "(") {
      pos++;
      const v = parseExpr();
      skip();
      if (src[pos] !== ")") throw new Error("missing )");
      pos++;
      return v;
    }
    const fm = /^[A-Z]+/.exec(src.slice(pos));
    if (fm && FORMULA_FUNCS[fm[0]]) {
      pos += fm[0].length;
      skip();
      if (src[pos] !== "(") throw new Error("expected ( after " + fm[0]);
      pos++;
      const args = [];
      skip();
      if (src[pos] === ")") pos++;
      else {
        for (;;) {
          args.push(parseExpr());
          skip();
          if (src[pos] === ",") { pos++; continue; }
          if (src[pos] === ")") { pos++; break; }
          throw new Error("bad arguments");
        }
      }
      return FORMULA_FUNCS[fm[0]](...args);
    }
    const nm = /^\d+(\.\d+)?/.exec(src.slice(pos));
    if (nm) { pos += nm[0].length; return Number(nm[0]); }
    throw new Error("unexpected '" + (src[pos] ?? "end") + "'");
  }
  const v = parseExpr();
  skip();
  if (pos < src.length) throw new Error("unexpected '" + src[pos] + "'");
  return v;
}

function evalFormula(expr, stack) {
  let s = expr.toUpperCase();
  // expand same-column ranges: C2:C10 → C2,C3,…,C10
  s = s.replace(/([A-Z])(\d+):\1(\d+)/g, (_, col, a, b) => {
    a = +a; b = +b;
    if (b < a) [a, b] = [b, a];
    const refs = [];
    for (let r = a; r <= b && refs.length <= items.length; r++) refs.push(col + r);
    return refs.join(",");
  });
  // replace cell refs with their evaluated values (plain decimal literals)
  s = s.replace(/([A-Z])(\d+)/g, (_, col, row) => {
    const v = refValue(col, +row, stack);
    const t = String(v);
    return "(" + (/E/i.test(t) ? v.toFixed(10) : t) + ")";
  });
  const v = evalExpr(s);
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("bad result");
  return v;
}

// evaluate a field, returning NaN (rendered as #ERR) on any formula problem
const safe = (i, f) => { try { return fieldValue(i, f); } catch { return NaN; } };

// ---- inline cell editing ---------------------------------------------------
// Double-click a cell to edit. Enter/blur commits, Escape cancels. Price cells
// parse "$1,234.56" style input; the change columns recompute on commit.
function startEdit(tr, i, td) {
  if (td.querySelector("input")) return;
  const field = td.dataset.field;
  const isPrice = field === "before" || field === "during";
  const raw0 = getRaw(i, field);
  const isFormula = typeof raw0 === "string" && raw0.trim().startsWith("=");
  const isComputed = field === "change" || field === "pct";
  const rr = i + 2;
  // editing a formula cell shows the formula, not the computed value; the
  // change columns open showing their equation so it can be tweaked per cell
  const cur = isFormula
    ? raw0.trim()
    : isComputed
      ? (raw0 == null || raw0 === "" ? (field === "change" ? `=D${rr}-C${rr}` : `=(D${rr}-C${rr})/C${rr}*100`) : String(raw0))
      : isPrice
        ? money(Number(raw0) || 0)
        : String(raw0 ?? "");
  tr.draggable = false;
  td.classList.add("editing");
  // lock the cell's current width so the column doesn't jump while editing
  td.style.width = td.offsetWidth + "px";
  td.innerHTML = "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = cur;
  td.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  let nav = null; // "down" (Enter) / "right" (Tab) — Sheets-style move after commit
  const commit = () => {
    if (done) return;
    done = true;
    applyMutation(() => setCell(i, field, input.value));
    if (nav && activeCell && activeCell.i === i && activeCell.field === field) {
      if (nav === "down" && i + 1 < items.length) activeCell = { i: i + 1, field };
      if (nav === "right") {
        const idx = FIELD_ORDER.indexOf(field);
        activeCell = { i, field: FIELD_ORDER[Math.min(FIELD_ORDER.length - 1, idx + 1)] };
      }
    }
    persist();
    render();
    if (nav) document.querySelectorAll(".sku-row")[activeCell?.i ?? i]?.scrollIntoView({ block: "nearest" });
  };
  const cancel = () => { if (done) return; done = true; render(); };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { nav = "down"; input.blur(); }
    else if (e.key === "Tab") { e.preventDefault(); nav = "right"; input.blur(); }
    else if (e.key === "Escape") cancel();
    e.stopPropagation();
  });
  input.addEventListener("blur", commit);
}

// ---- rendering --------------------------------------------------------------
function renderHead() {
  const tr = $("headRow");
  tr.innerHTML = "";
  const rn = document.createElement("th");
  rn.className = "rn";
  rn.textContent = "1";
  // widen the gutter to fit the biggest row number (96 → 1046 → …)
  rn.style.width = Math.max(34, 14 + String(items.length + 1).length * 8) + "px";
  tr.appendChild(rn);
  const BASE_TITLES = ["SKU", "Item ID", "Before Price", "During Incentive", "$ Change", "% Change", "Reg Comm %", "Incent Comm %"];
  BASE_TITLES.forEach((t, k) => {
    const th = document.createElement("th");
    th.textContent = t;
    th.style.width = colW(BASE_FIELDS[k]) + "px";
    addResizeHandle(th, BASE_FIELDS[k]);
    tr.appendChild(th);
  });
  customCols.forEach((c, k) => {
    const f = "c_" + c.key;
    const th = document.createElement("th");
    th.className = "custom-h";
    th.textContent = c.name;
    th.title = "Double-click to rename";
    th.style.width = colW(f) + "px";
    const x = document.createElement("button");
    x.className = "col-del";
    x.textContent = "×";
    x.title = "Delete column";
    x.addEventListener("click", () => deleteColumn(k));
    th.appendChild(x);
    th.addEventListener("dblclick", () => renameColumn(k));
    addResizeHandle(th, f);
    tr.appendChild(th);
  });
}

function render() {
  $("count").textContent = items.length || "";
  renderHead();

  const tb = $("tbody");
  tb.innerHTML = "";
  items.forEach((it, i) => {
    const before = safe(i, "before");
    const during = safe(i, "during");
    const ch = safe(i, "change");
    const pct = safe(i, "pct");
    const reg = safe(i, "regCom");
    const inc = safe(i, "incCom");
    const tr = document.createElement("tr");
    tr.className = "sku-row" + (i === selected ? " sel" : "");
    tr.draggable = true;
    tr.innerHTML = `
      <td class="rn"><span class="n">${i + 2}</span><button class="rowdel" title="Delete row">×</button></td>
      <td class="sku" data-field="sku"></td>
      <td class="mono id" data-field="itemId"></td>
      <td class="num${Number.isFinite(before) ? "" : " err"}" data-field="before">${money(before)}</td>
      <td class="num${Number.isFinite(during) ? "" : " err"}" data-field="during">${money(during)}</td>
      <td class="num${ch < 0 ? " neg" : ""}${Number.isFinite(ch) ? "" : " err"}" data-field="change">${chDollar(ch)}</td>
      <td class="num${pct < 0 ? " neg" : ""}${Number.isFinite(pct) ? "" : " err"}" data-field="pct">${chPct(pct)}</td>
      <td class="num${Number.isFinite(reg) ? "" : " err"}" data-field="regCom">${comPct(reg)}</td>
      <td class="num${Number.isFinite(inc) ? "" : " err"}" data-field="incCom">${comPct(inc)}</td>`;
    // custom column cells
    for (const c of customCols) {
      const f = "c_" + c.key;
      const td = document.createElement("td");
      td.dataset.field = f;
      td.className = "custom";
      const raw = it.custom?.[c.key];
      if (typeof raw === "string" && raw.trim().startsWith("=")) {
        const v = safe(i, f);
        td.textContent = Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "#ERR";
        td.classList.add("num");
        if (!Number.isFinite(v)) td.classList.add("err");
      } else {
        td.textContent = raw ?? "";
        if (raw != null && raw !== "" && Number.isFinite(Number(raw))) td.classList.add("num");
      }
      tr.appendChild(td);
    }
    tr.querySelector(".sku").textContent = it.sku;
    tr.querySelector(".id").textContent = it.itemId;
    // mark formula cells (dotted underline + the formula as a tooltip)
    FIELD_ORDER.filter((f) => f !== "sku" && f !== "itemId").forEach((f) => {
      const raw = getRaw(i, f);
      if (typeof raw === "string" && raw.trim().startsWith("=")) {
        const td = tr.querySelector(`td[data-field="${f}"]`);
        if (td) {
          td.classList.add("formula");
          td.title = raw;
        }
      }
    });
    // highlight the active cell
    if (activeCell && activeCell.i === i) {
      tr.querySelector(`td[data-field="${activeCell.field}"], td[data-col="${activeCell.field}"]`)
        ?.classList.add("active-cell");
    }
    tr.addEventListener("click", (e) => {
      if (e.target.closest("input, .rowdel")) return;
      // remember which cell was clicked (Sheets-style active cell)
      const td = e.target.closest("td");
      const f = td?.dataset.field || td?.dataset.col || null;
      const wasActive = !!(activeCell && activeCell.i === i && activeCell.field === f);
      activeCell = f ? { i, field: f } : null;
      select(i);
      if (wasActive) editActive(); // clicking the focused cell again edits it
    });
    tr.querySelector(".rowdel").addEventListener("click", (e) => {
      e.stopPropagation();
      removeRow(i);
    });
    // double-click a cell to edit it
    tr.querySelectorAll("td[data-field]").forEach((td) => {
      td.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startEdit(tr, i, td);
      });
    });
    // drag to reorder
    tr.addEventListener("dragstart", (e) => {
      dragFrom = i;
      tr.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    tr.addEventListener("dragend", () => {
      dragFrom = -1;
      tr.classList.remove("dragging");
      document.querySelectorAll(".sku-row.drop-above, .sku-row.drop-below")
        .forEach((r) => r.classList.remove("drop-above", "drop-below"));
    });
    tr.addEventListener("dragover", (e) => {
      if (dragFrom < 0 || dragFrom === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const above = e.offsetY < tr.offsetHeight / 2;
      tr.classList.toggle("drop-above", above);
      tr.classList.toggle("drop-below", !above);
    });
    tr.addEventListener("dragleave", () => tr.classList.remove("drop-above", "drop-below"));
    tr.addEventListener("drop", (e) => {
      if (dragFrom < 0 || dragFrom === i) return;
      e.preventDefault();
      const above = e.offsetY < tr.offsetHeight / 2;
      moveItem(dragFrom, above ? i : i + 1);
    });
    tb.appendChild(tr);
  });

  // find highlights (yellow = match, orange = current)
  if (findTerm) {
    computeMatches();
    if (findIdx >= findMatches.length) findIdx = findMatches.length ? 0 : -1;
    if (findIdx < 0 && findMatches.length) findIdx = 0;
    const rows = tb.querySelectorAll(".sku-row");
    findMatches.forEach((m, k) => {
      const td = rows[m.i]?.querySelector(`td[data-field="${m.field}"]`);
      if (td) td.classList.add(k === findIdx ? "hl-cur" : "hl");
    });
    $("findCount").textContent = findMatches.length ? `${findIdx + 1} of ${findMatches.length}` : "0 results";
  }

  renderDetailBar();
  updateFxBar();
}

function renderDetailBar() {
  const it = items[selected];
  $("curSku").textContent = it ? (it.sku || "(no SKU)") : "Select a listing";
  $("curItem").textContent = it ? (it.itemId ? `item ${it.itemId}` : "no item ID yet") : "";
  $("prevBtn").disabled = !(selected > 0);
  $("nextBtn").disabled = !(selected >= 0 && selected < items.length - 1);
}

// ---- selection + docked listing --------------------------------------------
function slotBounds() {
  const r = $("listingSlot").getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

// which side of Walmart the pane shows: "customer" (the selected row's public
// listing) or "seller" (a free-browsing Seller Center session, independent of
// row selection — it loads once and row clicks never navigate it)
let paneMode = localStorage.getItem("paneMode") === "seller" ? "seller" : "customer";

function dockListing() {
  const it = items[selected];
  if (paneMode === "seller") {
    $("slotPlaceholder").style.display = "none";
    document.querySelector(".loading-text").textContent = "Loading Seller Center…";
    window.api.showListing(null, slotBounds(), { mode: "seller" });
    return;
  }
  if (!it?.itemId) {
    window.api.hideListing();
    $("slotPlaceholder").style.display = "";
    return;
  }
  $("slotPlaceholder").style.display = "none";
  document.querySelector(".loading-text").textContent = "Loading Walmart…";
  window.api.showListing(it.itemId, slotBounds(), { mode: "customer" });
}

function renderModeSeg() {
  document.querySelectorAll("#modeSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === paneMode));
}
renderModeSeg();
document.querySelectorAll("#modeSeg .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (paneMode === b.dataset.mode) return;
    paneMode = b.dataset.mode;
    localStorage.setItem("paneMode", paneMode);
    renderModeSeg();
    dockListing();
  });
});

function select(i) {
  if (i < 0 || i >= items.length) return;
  selected = i;
  dockListing();
  render();
  // keep the selected row in view
  document.querySelectorAll(".sku-row")[i]?.scrollIntoView({ block: "nearest" });
}

// keep the docked pane aligned with its slot as the window resizes
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => dockListing(), 60);
});

// ---- resizable split -------------------------------------------------------
// The Walmart pane is a native view that swallows mouse events, so it is
// hidden while dragging and re-docked at the new size on release.
const side = $("side");
{
  const w = Number(localStorage.getItem("sideWidth"));
  if (w >= 340) side.style.width = Math.min(w, window.innerWidth - 320) + "px";
}
$("splitBar").addEventListener("mousedown", (e) => {
  e.preventDefault();
  window.api.hideListing();
  document.body.classList.add("resizing");
  const move = (ev) => {
    const w = Math.min(Math.max(ev.clientX, 340), window.innerWidth - 320);
    side.style.width = w + "px";
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing");
    localStorage.setItem("sideWidth", parseInt(side.style.width, 10) || 680);
    dockListing();
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});

// ---- sheet zoom (Ctrl+scroll over the left side) ---------------------------
let sheetZoom = Number(localStorage.getItem("sheetZoom")) || 1;
function applySheetZoom() { $("sheet").style.zoom = sheetZoom; }
side.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  sheetZoom = Math.min(1.6, Math.max(0.5, Math.round((sheetZoom + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100));
  localStorage.setItem("sheetZoom", sheetZoom);
  applySheetZoom();
}, { passive: false });
applySheetZoom();

// ---- loading overlay -------------------------------------------------------
// shown while walmart.com loads (the main process hides the native pane and
// tells us when loading starts/stops)
window.api.onListingLoading((loading) => {
  const show = loading &&
    (paneMode === "seller" || (selected >= 0 && !!items[selected]?.itemId));
  $("loadingOverlay").classList.toggle("hidden", !show);
});

// The customer pane reports when the user browses to another listing or
// variant inside it; if that item is in the sheet, jump to its row.
window.api.onListingNavigated((itemId) => {
  if (paneMode !== "customer") return;
  const id = String(itemId).trim();
  const idx = items.findIndex((it) => String(it.itemId ?? "").trim() === id);
  if (idx < 0 || idx === selected) return;
  selected = idx;
  render();
  const row = document.querySelectorAll(".sku-row")[idx];
  row?.scrollIntoView({ block: "nearest" });
  row?.classList.add("nav-flash");
  setTimeout(() => row?.classList.remove("nav-flash"), 1300);
});

// ---- copy & paste ----------------------------------------------------------
// Click a cell, then Ctrl+C copies that cell (formulas copy as "=…"), Ctrl+V
// pastes into it — including multi-cell grids from Sheets, anchored at the
// cell. With no cell clicked, Ctrl+C copies the whole selected row and Ctrl+V
// inserts pasted lines as new rows. Inside a cell editor, native copy/paste
// applies as usual.
const parseNum = (s) => {
  const str = String(s ?? "").trim();
  const negative = /^\(.*\)$/.test(str);      // "(5.31)" style negatives
  const n = Number(str.replace(/[$,()%\s]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
};

// what Ctrl+C puts on the clipboard for one cell
function cellRaw(i, field) {
  const raw = getRaw(i, field);
  const isFormula = typeof raw === "string" && raw.trim().startsWith("=");
  if (isFormula && field !== "sku" && field !== "itemId") return raw.trim();
  if (field === "before" || field === "during") return money(safe(i, field));
  if (field === "change") return chDollar(safe(i, "change"));
  if (field === "pct") return chPct(safe(i, "pct"));
  return String(raw ?? "");
}

function setCell(i, field, text) {
  const t = String(text).trim();
  if (field === "sku" || field === "itemId") { items[i][field] = t; return; }
  if (field.startsWith("c_")) {
    // custom column — stores text, numbers, or "=" formulas as typed
    const key = field.slice(2);
    if (!items[i].custom) items[i].custom = {};
    if (t === "") delete items[i].custom[key];
    else items[i].custom[key] = t;
    return;
  }
  if (field === "change" || field === "pct") {
    // clearing the cell restores the built-in equation
    items[i][field] = t === "" ? undefined : t.startsWith("=") ? t : parseNum(t);
    return;
  }
  items[i][field] = t.startsWith("=") ? t : parseNum(t);
}

function handlePaste(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return;

  applyMutation(() => {
    if (activeCell) {
      // grid paste anchored at the active cell, Sheets-style; grows the sheet
      // downward if the grid runs past the last row
      const startCol = FIELD_ORDER.indexOf(activeCell.field);
      const multi = lines.length > 1 || lines[0].includes("\t");
      lines.forEach((line, r) => {
        const rowIdx = activeCell.i + r;
        while (rowIdx >= items.length) items.push(newRow());
        line.split("\t").forEach((val, c) => {
          const f = FIELD_ORDER[startCol + c];
          // multi-cell pastes never overwrite the change columns' equations —
          // those recompute; paste a single value/formula into one to override it
          if (f && !(multi && (f === "change" || f === "pct"))) setCell(rowIdx, f, val);
        });
      });
    } else {
      // no cell chosen — treat lines as whole rows (SKU, Item ID, Before, During)
      const rows = [];
      for (const line0 of lines) {
        const line = line0.trim();
        if (!line) continue;
        let parts = line.split("\t");                 // Sheets copies as TSV
        if (parts.length < 2) parts = line.split(/[,;]+/);
        parts = parts.map((s) => s.trim());
        if (parts.length < 2) continue;
        if (/^sku$/i.test(parts[0])) continue;        // header row
        rows.push(fillComs({ sku: parts[0], itemId: parts[1], before: parseNum(parts[2]), during: parseNum(parts[3]) }));
      }
      if (!rows.length) return;
      const at = selected >= 0 ? selected + 1 : items.length;
      items.splice(at, 0, ...rows);
    }
  });
  persist();
  render();
}

window.addEventListener("keydown", async (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return; // native in editors
  const k = e.key.toLowerCase();
  if (k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (k === "y") { e.preventDefault(); redo(); return; }
  if (k === "f") { e.preventDefault(); openFind(); return; }
  if (k === "c") {
    if (String(window.getSelection())) return;      // highlighted text — native copy
    if (activeCell) {
      e.preventDefault();
      window.api.writeClipboard(cellRaw(activeCell.i, activeCell.field));
    } else if (selected >= 0) {
      e.preventDefault();
      window.api.writeClipboard(FIELD_ORDER.map((f) => cellRaw(selected, f)).join("\t"));
    }
  } else if (k === "v") {
    e.preventDefault();
    handlePaste(await window.api.readClipboard());
  }
});

// ---- wiring -----------------------------------------------------------------
$("prevBtn").addEventListener("click", () => select(selected - 1));
$("nextBtn").addEventListener("click", () => select(selected + 1));
$("zoomIn").addEventListener("click", () => window.api.zoomListing(1));
$("zoomOut").addEventListener("click", () => window.api.zoomListing(-1));

$("addRowBtn").addEventListener("click", () => {
  applyMutation(() => items.push(newRow()));
  persist();
  render();
  // scroll to the new row and start editing its SKU right away
  const rows = document.querySelectorAll(".sku-row");
  const tr = rows[rows.length - 1];
  tr?.scrollIntoView({ block: "nearest" });
  if (tr) startEdit(tr, items.length - 1, tr.querySelector('td[data-field="sku"]'));
});

// ---- cell editing helpers --------------------------------------------------
const EDITABLE_FIELDS = ["sku", "itemId", "before", "during", "change", "pct", "regCom", "incCom"];
const isEditableField = (f) => EDITABLE_FIELDS.includes(f) || f.startsWith("c_");

// open the active cell's inline editor; `initial` replaces the content
// (type-to-replace, like Sheets)
function editActive(initial) {
  if (!activeCell) return;
  const { i, field } = activeCell;
  if (!isEditableField(field)) return;
  const tr = document.querySelectorAll(".sku-row")[i];
  const td = tr?.querySelector(`td[data-field="${field}"]`);
  if (!tr || !td) return;
  startEdit(tr, i, td);
  if (initial != null) {
    const input = td.querySelector("input");
    if (input) { input.value = initial; input.setSelectionRange(initial.length, initial.length); }
  }
}

// ---- formula bar -----------------------------------------------------------
function updateFxBar() {
  const fxRef = $("fxRef");
  const fxInput = $("fxInput");
  if (document.activeElement === fxInput) return; // don't clobber while typing
  if (!activeCell || !items[activeCell.i]) {
    fxRef.textContent = "—";
    fxInput.value = "";
    fxInput.disabled = true;
    return;
  }
  const { i, field } = activeCell;
  const r = i + 2;
  fxRef.textContent = fieldToLetter(field) + r;
  fxInput.disabled = false;
  const raw = getRaw(i, field);
  const isFormula = typeof raw === "string" && raw.trim().startsWith("=");
  if (field === "change" || field === "pct") {
    fxInput.value = isFormula
      ? raw.trim()
      : raw == null || raw === ""
        ? (field === "change" ? `=D${r}-C${r}` : `=(D${r}-C${r})/C${r}*100`)
        : String(raw);
  } else {
    fxInput.value = isFormula
      ? raw.trim()
      : field === "before" || field === "during"
        ? money(Number(raw) || 0)
        : String(raw ?? "");
  }
}

$("fxInput").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter" && activeCell && isEditableField(activeCell.field)) {
    applyMutation(() => setCell(activeCell.i, activeCell.field, $("fxInput").value));
    persist();
    render();
    $("fxInput").blur();
  } else if (e.key === "Escape") {
    $("fxInput").blur();
    updateFxBar();
  }
});

// ---- find (Ctrl+F) ---------------------------------------------------------
// what a cell "contains" for search: its displayed text plus any formula
function cellSearchText(i, f) {
  if (f === "sku" || f === "itemId") return String(items[i][f] ?? "");
  const raw = getRaw(i, f);
  const formula = typeof raw === "string" && raw.trim().startsWith("=") ? raw : "";
  if (f.startsWith("c_")) {
    let shown;
    if (formula) { const v = safe(i, f); shown = Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "#ERR"; }
    else shown = String(raw ?? "");
    return shown + " " + formula;
  }
  const v = safe(i, f);
  const shown = f === "change" ? chDollar(v)
    : f === "pct" ? chPct(v)
    : f === "regCom" || f === "incCom" ? comPct(v)
    : money(v);
  return shown + " " + formula;
}

function computeMatches() {
  findMatches = [];
  const t = findTerm.toLowerCase();
  if (!t) return;
  items.forEach((_, i) => {
    for (const f of FIELD_ORDER) {
      if (cellSearchText(i, f).toLowerCase().includes(t)) findMatches.push({ i, field: f });
    }
  });
}

function openFind() {
  $("findBar").classList.remove("hidden");
  $("findInput").focus();
  $("findInput").select();
}

function closeFind() {
  findTerm = "";
  findIdx = -1;
  findMatches = [];
  $("findInput").value = "";
  $("findBar").classList.add("hidden");
  render();
}

function scrollToMatch() {
  const m = findMatches[findIdx];
  if (!m) return;
  document.querySelectorAll(".sku-row")[m.i]?.scrollIntoView({ block: "nearest" });
}

function stepFind(d) {
  if (!findMatches.length) return;
  findIdx = (findIdx + d + findMatches.length) % findMatches.length;
  render();
  scrollToMatch();
}

$("findInput").addEventListener("input", () => {
  findTerm = $("findInput").value.trim();
  findIdx = 0;
  render();
  scrollToMatch();
});
$("findInput").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") closeFind();
});
$("findNext").addEventListener("click", () => stepFind(1));
$("findPrev").addEventListener("click", () => stepFind(-1));
$("findClose").addEventListener("click", closeFind);

// ---- columns / save / export -----------------------------------------------
function deleteColumn(k) {
  const col = customCols[k];
  if (!col) return;
  if (!confirm(`Delete column "${col.name}" and its values?`)) return;
  applyMutation(() => {
    for (const it of items) { if (it.custom) delete it.custom[col.key]; }
  });
  customCols.splice(k, 1);
  saveCols();
  rebuildFieldOrder();
  if (activeCell && !FIELD_ORDER.includes(activeCell.field)) activeCell = null;
  persist();
  render();
}

function renameColumn(k) {
  const col = customCols[k];
  if (!col) return;
  const name = prompt("Column name:", col.name);
  if (name == null || !name.trim()) return;
  col.name = name.trim();
  saveCols();
  render();
}

$("addColBtn").addEventListener("click", () => {
  const letter = String.fromCharCode(71 + customCols.length); // G, H, …
  const name = prompt("Name for the new column:", `Column ${letter}`);
  if (name == null || !name.trim()) return;
  customCols.push({ key: Math.random().toString(36).slice(2, 8), name: name.trim() });
  saveCols();
  rebuildFieldOrder();
  render();
});

$("saveBtn").addEventListener("click", () => persist());

async function exportRegular() {
  const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : "");
  // The exported sheet has the same layout as the app (header row 1, data from
  // row 2, same column letters), so formulas export as live spreadsheet
  // formulas: {f: "D2-C2", v: computed} cells. AVG is renamed for Excel.
  const toExcelFormula = (raw) => raw.trim().replace(/^=/, "").replace(/\bAVG\s*\(/gi, "AVERAGE(");
  const fx = (i, field) => {
    const raw = getRaw(i, field);
    return typeof raw === "string" && raw.trim().startsWith("=") ? toExcelFormula(raw) : null;
  };
  const head = ["SKU", "Item ID", "Before Price", "During Incentive", "$ Change", "% Change",
                "Regular Commission", "During Incentive Commission",
                ...customCols.map((c) => c.name)];
  const rows = items.map((it, i) => {
    const r = i + 2;
    const priceCell = (field) => {
      const f = fx(i, field);
      const v = round2(safe(i, field));
      return f ? { f, v } : v;
    };
    // change/pct: custom formula → that formula; hard number override → the
    // number; otherwise the built-in equation, exported live
    const changeRaw = getRaw(i, "change");
    const changeV = round2(safe(i, "change"));
    const change = fx(i, "change") ? { f: fx(i, "change"), v: changeV }
      : changeRaw != null && changeRaw !== "" ? changeV
      : { f: `D${r}-C${r}`, v: changeV };
    const pctRaw = getRaw(i, "pct");
    const pctV = Number.isFinite(safe(i, "pct")) ? Math.round(safe(i, "pct") * 10) / 10 : "";
    const pct = fx(i, "pct") ? { f: fx(i, "pct"), v: pctV }
      : pctRaw != null && pctRaw !== "" ? pctV
      : { f: `IFERROR((D${r}-C${r})/C${r}*100,0)`, v: pctV };
    const extras = customCols.map((c) => {
      const field = "c_" + c.key;
      const f = fx(i, field);
      if (f) return { f, v: round2(safe(i, field)) };
      const raw = getRaw(i, field);
      if (raw != null && raw !== "" && Number.isFinite(Number(raw))) return Number(raw);
      return raw ?? "";
    });
    return [it.sku, it.itemId, priceCell("before"), priceCell("during"), change, pct,
            priceCell("regCom"), priceCell("incCom"), ...extras];
  });
  const res = await window.api.exportSheet({ head, rows, name: "incentive-list" });
  finishExport(res, rows.length);
}

// The 11-column incentive template the Walmart rep uploads. Item ID, prices,
// the partner constants, and each row's commission rates are filled in —
// Status, dates, and Item Name are left for the rep, matching their sheet.
const REP_PARTNER_ID = 10001467995;
const REP_PARTNER_NAME = "HotDeals";

async function exportRep() {
  const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : "");
  const head = [
    "Status", "Item ID", "Partner ID", "Partner Name", "Regular Commission Rate",
    "Avg. Price Before Incentive (Past 90 days)", "Incentive Start Date",
    "Incentive End Date", "Incentive Commission Rate", "Price During Incentive",
    "Item Name",
  ];
  const rate = (i, field, dflt) => {
    const v = round2(safe(i, field));
    return Number.isFinite(v) ? v : dflt;
  };
  const rows = items
    .map((it, i) => (String(it.itemId ?? "").trim()
      ? ["", String(it.itemId).trim(), REP_PARTNER_ID, REP_PARTNER_NAME,
         rate(i, "regCom", DEFAULT_REG_COM),
         round2(safe(i, "before")), "", "",
         rate(i, "incCom", DEFAULT_INC_COM),
         round2(safe(i, "during")), ""]
      : null))
    .filter(Boolean);
  if (!rows.length) { alert("No rows with an Item ID to export."); return; }
  const res = await window.api.exportSheet({
    head, rows,
    name: "walmart-incentive-rep",
    widths: head.map((h) => Math.max(12, h.length + 2)),
  });
  finishExport(res, rows.length);
}

function finishExport(res, count) {
  if (res?.error) alert("Export failed: " + res.error);
  else if (res?.saved) alert(res.note || `Exported ${count} rows to:\n${res.path}`);
}

// Export opens a format chooser first; the Walmart pane is a native layer
// that would cover the dialog, so it hides while the modal is open.
function closeExportModal() {
  $("exportModal").classList.add("hidden");
  dockListing();
}
$("exportBtn").addEventListener("click", () => {
  if (!items.length) { alert("Nothing to export."); return; }
  window.api.hideListing();
  $("exportModal").classList.remove("hidden");
});
$("exportCancel").addEventListener("click", closeExportModal);
$("exportModal").addEventListener("click", (e) => {
  if (e.target.id === "exportModal") closeExportModal();
});
$("exportRegular").addEventListener("click", () => { closeExportModal(); exportRegular(); });
$("exportRep").addEventListener("click", () => { closeExportModal(); exportRep(); });

// ---- import ----------------------------------------------------------------
// The Import button opens an instructions dialog first; "Choose file…" runs
// the actual import. The Walmart pane is a native layer that would cover the
// dialog, so it hides while the dialog is open and comes back after.
function openImportModal() {
  window.api.hideListing();
  $("importModal").classList.remove("hidden");
}
function closeImportModal() {
  $("importModal").classList.add("hidden");
  dockListing();
}
$("importBtn").addEventListener("click", openImportModal);
$("importCancel").addEventListener("click", closeImportModal);
$("importModal").addEventListener("click", (e) => {
  if (e.target.id === "importModal") closeImportModal();
});
let pendingImportRows = null;

// mode: "append" | "replace" | null (cancel)
function finishImport(mode) {
  const rows = pendingImportRows || [];
  pendingImportRows = null;
  $("importChoiceModal").classList.add("hidden");
  if (!mode || !rows.length) { closeImportModal(); return; }
  let added = rows.length;
  let skipped = 0;
  applyMutation(() => {
    if (mode === "replace") {
      items = rows;
      selected = -1;
      activeCell = null;
      $("slotPlaceholder").style.display = "";
    } else {
      // add to bottom, skipping rows already in the table (same SKU + item ID)
      const seen = new Set(items.map((r) => `${r.sku} ${r.itemId}`));
      const fresh = rows.filter((r) => !seen.has(`${r.sku} ${r.itemId}`));
      added = fresh.length;
      skipped = rows.length - fresh.length;
      items.push(...fresh);
    }
  });
  persist();
  render();
  closeImportModal(); // restores the Walmart pane if a row is still selected
  if (mode === "append") {
    alert(skipped
      ? `Added ${added} new row${added === 1 ? "" : "s"}. Skipped ${skipped} already in the table.`
      : `Added ${added} row${added === 1 ? "" : "s"}.`);
  }
}

$("importChoiceCancel").addEventListener("click", () => finishImport(null));
$("importAppend").addEventListener("click", () => finishImport("append"));
$("importReplace").addEventListener("click", () => finishImport("replace"));
$("importChoiceModal").addEventListener("click", (e) => {
  if (e.target.id === "importChoiceModal") finishImport(null);
});

$("importChoose").addEventListener("click", async () => {
  $("importModal").classList.add("hidden");
  const res = await window.api.importSheet();
  if (!res || res.canceled) { closeImportModal(); return; }
  if (res.error) { alert("Import failed: " + res.error); closeImportModal(); return; }
  const rows = res.rows || [];
  if (!rows.length) {
    alert("No usable rows found. Only SKU (column A) and Item ID (column B) are required.");
    closeImportModal();
    return;
  }
  pendingImportRows = rows;
  if (!items.length) { finishImport("replace"); return; } // empty table — just load it
  $("importChoiceMsg").textContent =
    `Found ${rows.length} row${rows.length === 1 ? "" : "s"} in the file. ` +
    `Add them under the current ${items.length} rows (duplicates are skipped), or replace the whole table?`;
  $("importChoiceModal").classList.remove("hidden");
});

// ---- keyboard: Sheets-style cell interaction --------------------------------
// With a cell focused: type to replace, Enter/F2 to edit, Delete to clear,
// arrows to move between cells. With no cell focused: ↑/↓ (or j/k) step
// through rows and load their listings.
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (activeCell) {
    const { i, field } = activeCell;
    if (e.key === "Escape") { activeCell = null; render(); return; }
    if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); editActive(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (isEditableField(field)) {
        e.preventDefault();
        applyMutation(() => setCell(i, field, ""));
        persist();
        render();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const ni = Math.min(items.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
      activeCell = { i: ni, field };
      render();
      document.querySelectorAll(".sku-row")[ni]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const idx = FIELD_ORDER.indexOf(field);
      const ni = Math.min(FIELD_ORDER.length - 1, Math.max(0, idx + (e.key === "ArrowRight" ? 1 : -1)));
      activeCell = { i, field: FIELD_ORDER[ni] };
      render();
      return;
    }
    if (e.key.length === 1) { e.preventDefault(); editActive(e.key); return; }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); select(selected < 0 ? 0 : selected + 1); }
  if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); select(selected <= 0 ? 0 : selected - 1); }
});

load();
