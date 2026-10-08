// Walmart Listing Browser — Electron main process.
// Keeps a local list of { sku, itemId } rows and loads the live walmart.com
// listing for the selected row into a docked browser pane on the right.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, clipboard, session } = require("electron");
const path = require("path");
const fs = require("fs");
const { buildRepricerBuffer, DEFAULT_STRATEGY } = require("./repricer");
const { buildIncentiveBuffer } = require("./incentive");
const { autoUpdater } = require("electron-updater");

// ---- tiny JSON store (userData/items.json) --------------------------------
let dataFile = null;
let uiFile = null; // userData/ui.json — small UI prefs (pane zoom)
function loadUi() {
  try { return JSON.parse(fs.readFileSync(uiFile, "utf8")) || {}; } catch { return {}; }
}
function saveUi(patch) {
  try { fs.writeFileSync(uiFile, JSON.stringify({ ...loadUi(), ...patch })); } catch { /* best effort */ }
}
function loadItems() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, "utf8")).items || [];
  } catch {
    return [];
  }
}
function saveItems(items) {
  try {
    fs.writeFileSync(dataFile, JSON.stringify({ items }, null, 2));
  } catch (e) {
    console.error("Failed to save items:", e);
  }
  return items;
}

// ---- spreadsheet import (.xlsx / .csv / .tsv) ------------------------------
// Reads SKU, Item ID, Before Price, During Incentive from columns A-D, plus
// per-row commission rates from any header-labeled "…Commission…" columns.
// Only SKU is required; everything else may be blank.
const parseNumMain = (s) => Number(String(s ?? "").replace(/[$,()%\s]/g, "")) || 0;

function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (q) {
      if (c === '"') { if (line[k + 1] === '"') { cur += '"'; k++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function normalizeRows(rows) {
  // Per-row commission columns are located by header label (any column whose
  // header mentions "commission") rather than by position, so older sheets
  // with $ Change / % Change in columns E-F can't be misread. Without labeled
  // columns every row gets the defaults.
  const REG_DEFAULT = 6, INC_DEFAULT = 2;
  let regIdx = -1, incIdx = -1;
  const header = rows.find((p) => /^sku$/i.test(String(p?.[0] ?? "").trim()));
  if (header) {
    const labels = header.map((s) => String(s ?? "").toLowerCase());
    regIdx = labels.findIndex((l) => l.includes("commission") && l.includes("regular"));
    incIdx = labels.findIndex((l) =>
      l.includes("commission") && (l.includes("incentive") || l.includes("during")));
    if (incIdx === -1) incIdx = labels.findIndex((l, k) => l.includes("commission") && k !== regIdx);
  }
  const commission = (parts, idx, dflt) => {
    const s = String(idx >= 0 ? parts[idx] ?? "" : "").trim();
    if (!s) return dflt;
    const n = parseNumMain(s);
    return n >= 0 && n <= 100 ? n : dflt;
  };
  const out = [];
  for (const parts of rows) {
    if (!parts?.length) continue;
    if (/^sku$/i.test(String(parts[0] ?? "").trim())) continue;    // header row
    const [sku, itemId, before, during] = parts;
    if (!String(sku ?? "").trim()) continue;                        // SKU is the only required column
    out.push({
      sku: String(sku ?? "").trim(),
      itemId: String(itemId ?? "").trim(),
      before: parseNumMain(before),
      during: parseNumMain(during),
      regCom: commission(parts, regIdx, REG_DEFAULT),
      incCom: commission(parts, incIdx, INC_DEFAULT),
    });
  }
  return out;
}

function parseDelimited(text) {
  const rows = [];
  for (const line of String(text).replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    rows.push((line.includes("\t") ? line.split("\t") : splitCsvLine(line)).map((s) => s.trim()));
  }
  return normalizeRows(rows);
}

function cellText(cell) {
  const v = cell?.value;
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.result != null) return String(v.result);              // formula cell → its value
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if (v.text != null) return String(v.text);
    return "";
  }
  return String(v);
}

async function parseXlsx(file) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("No worksheet found in the file.");
  const rows = [];
  ws.eachRow((row) => rows.push([1, 2, 3, 4, 5, 6, 7, 8].map((c) => cellText(row.getCell(c)))));
  return normalizeRows(rows);
}

async function importSheet() {
  const res = await dialog.showOpenDialog(win, {
    title: "Import spreadsheet",
    filters: [
      { name: "All spreadsheets", extensions: ["xlsx", "csv", "tsv", "txt"] },
      { name: "CSV (.csv)", extensions: ["csv"] },
      { name: "Excel (.xlsx)", extensions: ["xlsx"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const file = res.filePaths[0];
  try {
    const rows = file.toLowerCase().endsWith(".xlsx")
      ? await parseXlsx(file)
      : parseDelimited(fs.readFileSync(file, "utf8"));
    return { rows, file };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ---- import template (.xlsx) ------------------------------------------------
// A blank sheet laid out exactly the way importSheet() expects it, with one
// example row so the columns are self-explanatory. Saved wherever the user
// picks; they fill it in (Excel / Google Sheets) and import it back.
const TEMPLATE_HEAD = [
  "SKU", "Item ID", "Before Price", "During Incentive", "Regular Commission", "During Incentive Commission",
];
async function saveImportTemplate() {
  const res = await dialog.showSaveDialog(win, {
    title: "Save import template",
    defaultPath: "import-template.xlsx",
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  try {
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Import");
    ws.addRow(TEMPLATE_HEAD);
    ws.getRow(1).font = { bold: true };
    ws.addRow(["EXAMPLE-SKU-001", "123456789", 19.99, 17.99, 6, 2]);
    ws.addRow(["EXAMPLE-SKU-002", "", "", "", "", ""]); // only SKU is required
    ws.getRow(2).font = ws.getRow(3).font = { italic: true, color: { argb: "FF888888" } };
    ws.getCell("A2").note = "Example rows — delete them before importing.";
    [26, 15, 14, 16, 18, 26].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    await wb.xlsx.writeFile(res.filePath);
    return { saved: true, path: res.filePath };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// ---- spreadsheet export (.xlsx / .csv) -------------------------------------
async function exportSheet(payload) {
  const head = Array.isArray(payload?.head) ? payload.head : [];
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const widths = Array.isArray(payload?.widths) ? payload.widths : null;
  const name = typeof payload?.name === "string" && payload.name ? payload.name : "incentive-list";
  const csvFirst = payload?.ext === "csv";
  const stamp = new Date().toISOString().slice(0, 10);
  const filters = [{ name: "Excel", extensions: ["xlsx"] }, { name: "CSV", extensions: ["csv"] }];
  const res = await dialog.showSaveDialog(win, {
    title: "Export spreadsheet",
    defaultPath: `${name}-${stamp}.${csvFirst ? "csv" : "xlsx"}`,
    filters: csvFirst ? filters.reverse() : filters,
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const file = res.filePath;
  // cells are plain values or {f: "D2-C2", v: computed} formula cells
  const isFx = (c) => c && typeof c === "object" && typeof c.f === "string";
  const LOCKED = ["EBUSY", "EPERM", "EACCES"];
  try {
    let write;
    if (file.toLowerCase().endsWith(".csv")) {
      const esc = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      // "=formula" strings — Excel and Google Sheets evaluate them on open
      const cellStr = (c) => (isFx(c) ? "=" + c.f : c);
      const lines = [head.map(esc).join(",")];
      for (const r of rows) lines.push(r.map((c) => esc(cellStr(c))).join(","));
      const content = lines.join("\r\n");
      write = async (target) => fs.writeFileSync(target, content, "utf8");
    } else {
      const ExcelJS = require("exceljs");
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Incentive");
      ws.addRow(head);
      ws.getRow(1).font = { bold: true };
      for (const r of rows) {
        ws.addRow(r.map((c) => (isFx(c)
          ? { formula: c.f, result: typeof c.v === "number" ? c.v : undefined }
          : c)));
      }
      head.forEach((_, i) => { ws.getColumn(i + 1).width = widths?.[i] ?? (i === 0 ? 26 : 15); });
      write = (target) => wb.xlsx.writeFile(target);
    }
    try {
      await write(file);
      return { saved: true, path: file };
    } catch (e) {
      // target open in Excel? save under "name (2).ext" instead of failing
      if (!LOCKED.includes(e.code)) throw e;
      const ext = path.extname(file);
      const base = file.slice(0, file.length - ext.length);
      let alt = null;
      for (let n = 2; n <= 50; n++) {
        const cand = `${base} (${n})${ext}`;
        if (!fs.existsSync(cand)) { alt = cand; break; }
      }
      if (!alt) throw e;
      await write(alt);
      return {
        saved: true,
        path: alt,
        note: `"${path.basename(file)}" is open in another program (likely Excel), so the export was saved as "${path.basename(alt)}". Close the old file to overwrite it next time.`,
      };
    }
  } catch (e) {
    if (LOCKED.includes(e.code)) {
      return { error: "The file is open in another program (probably Excel). Close it there and export again." };
    }
    return { error: e.message || String(e) };
  }
}

// ---- repricer bulk-upload export -------------------------------------------
// Builds Walmart's Repricer Bulk Upload file for every SKU, each assigned the
// chosen strategy (defaults to IMRAN BUY BOX), and saves it via a dialog.
async function exportRepricer(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const strategy = payload?.strategy || DEFAULT_STRATEGY;
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: "Export repricer bulk upload",
    defaultPath: `repricer-bulk-upload-${stamp}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const file = res.filePath;
  const LOCKED = ["EBUSY", "EPERM", "EACCES"];
  try {
    const buf = await buildRepricerBuffer(rows, strategy);
    const write = (target) => fs.writeFileSync(target, Buffer.from(buf));
    try {
      write(file);
      return { saved: true, path: file };
    } catch (e) {
      // target open in Excel? save under "name (2).xlsx" instead of failing
      if (!LOCKED.includes(e.code)) throw e;
      const ext = path.extname(file);
      const base = file.slice(0, file.length - ext.length);
      let alt = null;
      for (let n = 2; n <= 50; n++) {
        const cand = `${base} (${n})${ext}`;
        if (!fs.existsSync(cand)) { alt = cand; break; }
      }
      if (!alt) throw e;
      write(alt);
      return {
        saved: true,
        path: alt,
        note: `"${path.basename(file)}" is open in another program (likely Excel), so the export was saved as "${path.basename(alt)}". Close the old file to overwrite it next time.`,
      };
    }
  } catch (e) {
    if (LOCKED.includes(e.code)) {
      return { error: "The file is open in another program (probably Excel). Close it there and export again." };
    }
    return { error: e.message || String(e) };
  }
}

// ---- Account Manager incentive export ---------------------------------------
// Fills the Account Manager's "Item & Partner Level Comm Break" template with
// one row per Item ID, saves it via a dialog, then reveals the file in
// Finder / Explorer so it can be dragged straight into an email.
async function exportIncentive(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const opts = payload?.opts && typeof payload.opts === "object" ? payload.opts : {};
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: "Export for Account Manager",
    defaultPath: `Item & Partner Level Comm Break ${stamp}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const file = res.filePath;
  const LOCKED = ["EBUSY", "EPERM", "EACCES"];
  try {
    const buf = await buildIncentiveBuffer(rows, opts);
    const write = (target) => fs.writeFileSync(target, buf);
    let saved = file, note;
    try {
      write(file);
    } catch (e) {
      // target open in Excel? save under "name (2).xlsx" instead of failing
      if (!LOCKED.includes(e.code)) throw e;
      const ext = path.extname(file);
      const base = file.slice(0, file.length - ext.length);
      let alt = null;
      for (let n = 2; n <= 50; n++) {
        const cand = `${base} (${n})${ext}`;
        if (!fs.existsSync(cand)) { alt = cand; break; }
      }
      if (!alt) throw e;
      write(alt);
      saved = alt;
      note = `"${path.basename(file)}" is open in another program (likely Excel), so the export was saved as "${path.basename(alt)}". Close the old file to overwrite it next time.`;
    }
    shell.showItemInFolder(saved);
    return { saved: true, path: saved, note };
  } catch (e) {
    if (LOCKED.includes(e.code)) {
      return { error: "The file is open in another program (probably Excel). Close it there and export again." };
    }
    return { error: e.message || String(e) };
  }
}

// ---- right-click menu (copy/paste in fields, copy links) ------------------
function attachContextMenu(contents) {
  contents.on("context-menu", (_e, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: "copy" });
    }
    if (params.linkURL) {
      template.push(
        ...(template.length ? [{ type: "separator" }] : []),
        { label: "Copy link address", click: () => clipboard.writeText(params.linkURL) },
      );
    }
    if (template.length) Menu.buildFromTemplate(template).popup();
  });
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1520,
    height: 880,
    minWidth: 1100,
    minHeight: 560,
    backgroundColor: "#FAF9F5",
    icon: path.join(__dirname, "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  attachContextMenu(win.webContents);
  win.loadFile(path.join(__dirname, "index.html"));
}

// ---- docked live-listing panes --------------------------------------------
// Two WebContentsViews (window-grade browsers, unlike <webview> which
// walmart.com refuses to render into) positioned over the right side of the
// window; the renderer sends the region's bounds. "customer" follows the
// selected row's public listing; "seller" is a free-browsing Seller Center
// session that loads once and is never navigated by row clicks — switching
// modes only shows/hides the panes, so neither side ever reloads.
// Present as plain Chrome (no "Electron/…" token, which trips bot detection),
// but truthfully: the real platform and the real Chromium version Electron
// ships. A mismatched UA (e.g. "Windows" while running on a Mac, or a stale
// Chrome version) makes walmart.com's robot-or-human checks fire and fail.
const CHROME_UA = (() => {
  const chromeVer = `${(process.versions.chrome || "130").split(".")[0]}.0.0.0`;
  const platform =
    process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : process.platform === "win32" ? "Windows NT 10.0; Win64; x64"
    : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
})();
const panes = { customer: null, seller: null };
let activePane = null;   // which pane the renderer currently wants shown
let customerItem = null; // itemId loaded in the customer pane
let paneZoom = 1; // 100% by default; the user's adjustment persists (ui.json)
let paneWanted = false;  // whether the renderer currently wants a pane visible
let paneLoading = false; // true only while WE are loading (not walmart's own background loads)

// The worker view only ever has to yield numbers, so its images, media and
// fonts are refused — most of a listing's download. The visible panes are
// untouched (the filter checks which view is asking).
const workerContentsIds = new Set();
let leanHooked = false;
function hookLeanLoading() {
  if (leanHooked) return;
  leanHooked = true;
  const ses = session.fromPartition("persist:listing");
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, cb) => {
    const t = details.resourceType;
    cb({ cancel: workerContentsIds.has(details.webContentsId) && (t === "image" || t === "media" || t === "font") });
  });
}

function makePane(mode) {
  hookLeanLoading();
  const v = new WebContentsView({
    webPreferences: {
      partition: "persist:listing", // one session for both panes: log in once
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  v.webContents.setUserAgent(CHROME_UA);
  v.webContents.on("dom-ready", () => {
    try { v.webContents.setZoomFactor(paneZoom); } catch { /* view gone */ }
  });
  // Ctrl+scroll (or trackpad pinch) over the pane zooms it, like a browser.
  v.webContents.on("zoom-changed", (_e, dir) => {
    paneZoomBy(dir === "in" ? 1 : -1);
  });
  // Loading screen: an HTML overlay can't cover the native view, so while a
  // load WE started is in flight the view hides and the renderer shows a
  // spinner. Only our loads count — walmart.com fires loading events
  // constantly (ads, iframes) and reacting to those made the pane flicker.
  v.webContents.on("did-start-loading", () => {
    if (!paneLoading || panes[activePane] !== v) return;
    try { win?.webContents.send("listing:loading", true); } catch { /* window gone */ }
    if (paneWanted) v.setVisible(false);
  });
  v.webContents.on("did-stop-loading", () => {
    if (!paneLoading || panes[activePane] !== v) return;
    paneLoading = false;
    try { win?.webContents.send("listing:loading", false); } catch { /* window gone */ }
    if (paneWanted) v.setVisible(true);
  });
  attachContextMenu(v.webContents);
  v.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) v.webContents.loadURL(url);
    return { action: "deny" };
  });
  // When the user browses to another listing or variant inside the customer
  // pane, tell the renderer so it can jump to that row. Variant clicks are
  // SPA history pushes, hence also did-navigate-in-page.
  // Listing views (the visible customer pane and the hidden worker) read the
  // price after every navigation. Only the visible pane reports where the
  // user browsed, so the sheet can jump to that row.
  if (mode === "customer" || mode === "worker") {
    const report = (url) => {
      const m = /\/ip\/(?:[^/]+\/)?(\d{5,})(?:[/?#]|$)/.exec(url);
      if (!m || m[1] === v.__item) return;
      v.__item = m[1];
      v.__lastPrice = null;
      if (mode === "customer") {
        customerItem = m[1]; // a later row click on this item won't reload
        try { win?.webContents.send("listing:navigated", m[1]); } catch { /* window gone */ }
      }
    };
    v.webContents.on("did-navigate", (_e, url) => { report(url); scheduleReadPrice(v); });
    v.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) { report(url); scheduleReadPrice(v); }
    });
    v.webContents.on("dom-ready", () => scheduleReadPrice(v));       // data payload is already in the HTML
    v.webContents.on("did-finish-load", () => scheduleReadPrice(v));  // fallback for late-hydrating prices
  }
  win.contentView.addChildView(v);
  if (mode === "worker" || mode === "amazon") {
    workerContentsIds.add(v.webContents.id);
    v.setBounds({ x: 0, y: 0, width: 1024, height: 768 }); // real size: the page lays out and hydrates normally
    v.setVisible(false);
  }
  return v;
}

// ---- buy-box price from the docked listing ----------------------------------
// Runs inside walmart.com after a listing loads and pulls the current ("Now")
// price and the crossed-out "was" price: structured data first (stable across
// redesigns), then the page's Next.js payload, then the visible price element.
// The renderer offers the result as a one-click During Incentive value.
const PRICE_SCRIPT = `(() => {
  const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/\\d+(?:\\.\\d{1,2})?/); return m ? Number(m[0]) : null; };
  const ok = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  try {
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      const j = JSON.parse(el.textContent); const arr = Array.isArray(j) ? j : [j];
      for (const o of arr) {
        if (!o || !/product/i.test(String(o["@type"]))) continue;
        const offs = Array.isArray(o.offers) ? o.offers : o.offers ? [o.offers] : [];
        for (const of_ of offs) { const p = num(of_?.price ?? of_?.lowPrice); if (ok(p)) return { price: p, was: null, src: "ld" }; }
      }
    }
  } catch {}
  try {
    const nd = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null");
    const pi = nd?.props?.pageProps?.initialData?.data?.product?.priceInfo;
    const p = pi?.currentPrice?.price, w = pi?.wasPrice?.price ?? pi?.listPrice?.price;
    if (ok(p)) return { price: p, was: ok(w) ? w : null, src: "next" };
  } catch {}
  const el = document.querySelector('[itemprop="price"]') || document.querySelector('[data-testid="price-wrap"] [itemprop="price"]') || document.querySelector('span[data-seo-id="hero-price"]');
  const p = num(el?.getAttribute?.("content") || el?.textContent);
  if (ok(p)) { const w = num(document.querySelector('[data-testid="price-wrap"] .strike, [data-seo-id="strike-through-price"]')?.textContent); return { price: p, was: ok(w) ? w : null, src: "dom" }; }
  return null;
})()`;
// Who holds the buy box and how many other sellers there are. Best effort:
// the Next.js payload first, then the page text ("Sold and shipped by X",
// "Compare all N sellers" / "More seller options (N)").
const SELLERS_SCRIPT = `(() => {
  const out = { seller: null, others: null };
  try {
    const nd = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null");
    const pr = nd?.props?.pageProps?.initialData?.data?.product;
    if (pr?.sellerName) out.seller = String(pr.sellerName).trim();
    if (Number.isInteger(pr?.additionalOfferCount)) out.others = pr.additionalOfferCount;
  } catch {}
  try {
    const text = document.body?.innerText || "";
    if (!out.seller) { const m = /Sold (?:and shipped |& shipped )?by\\s+([^\\n|]{2,60}?)(?:\\s*\\||\\n|$)/i.exec(text); if (m) out.seller = m[1].trim(); }
    if (out.others == null) {
      const m = /Compare all (\\d+) sellers/i.exec(text) || /More seller options \\((\\d+)\\)/i.exec(text) || /(\\d+) more sellers?/i.exec(text);
      if (m) out.others = Math.max(0, Number(m[1]) - (/Compare all/i.test(m[0]) ? 1 : 0));
    }
  } catch {}
  return out;
})()`;
// The other sellers' names and prices. Walmart's data payload sometimes has
// them; otherwise open the "Compare all sellers" panel once and read it.
const OFFERS_SCRIPT = `(async () => {
  const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/\\d+(?:\\.\\d{1,2})?/); return m ? Number(m[0]) : null; };
  const ok = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  const found = [];
  const dedupe = (arr) => { const out = [], seen = new Set(); for (const o of arr) { const k = o.seller.toLowerCase() + "|" + o.price; if (!seen.has(k)) { seen.add(k); out.push(o); } } return out.sort((a, b) => a.price - b.price).slice(0, 12); };
  try {
    const nd = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null");
    const seen = new Set();
    const walk = (o, d) => {
      if (!o || typeof o !== "object" || d > 14 || seen.has(o)) return; seen.add(o);
      if (Array.isArray(o)) {
        if (o.length > 1 && o.every((e) => e && typeof e === "object" && (e.sellerName || e.sellerDisplayName))) {
          for (const e of o) { const p = num(e.priceInfo?.currentPrice?.price ?? e.currentPrice?.price ?? e.price?.price ?? e.price); const n = e.sellerName || e.sellerDisplayName; if (n && ok(p)) found.push({ seller: String(n).trim(), price: p }); }
        }
        for (const e of o) walk(e, d + 1); return;
      }
      for (const k in o) walk(o[k], d + 1);
    };
    walk(nd, 0);
  } catch {}
  if (found.length > 1) return dedupe(found);
  try {
    if (!window.__wlbOffersTried) {
      window.__wlbOffersTried = true;
      const btn = [...document.querySelectorAll("button, a")].find((b) => /Compare all \\d+ sellers|More seller options/i.test(b.textContent || ""));
      if (btn) {
        btn.click();
        await new Promise((r) => setTimeout(r, 1800));
        const root = document.querySelector('[role="dialog"]') || document.body;
        const text = root.innerText || "";
        const re = /\\$\\s?(\\d[\\d,]*\\.\\d{2})[\\s\\S]{0,400}?Sold (?:and shipped |& shipped )?by\\s+([^\\n|]{2,60}?)(?:\\s*\\||\\n|$)/gi;
        let m; while ((m = re.exec(text))) { const p = num(m[1]); if (ok(p)) found.push({ seller: m[2].trim(), price: p }); }
        try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch {}
      }
    }
  } catch {}
  return dedupe(found);
})()`;
// Each listing view tracks its own item, last read and retry timers.
let lastPrice = null; // most recent read from any view (the renderer asks for it on startup)
function sendPrice(v, p) {
  if (v) v.__lastPrice = p;
  lastPrice = p;
  try { win?.webContents.send("listing:price", p); } catch { /* window gone */ }
}
// Never opens the sellers panel on its own: that visibly jumps the page the
// user is reading. Seller prices come only from paneOffers (hidden worker).
function scheduleReadPrice(v, withOffers = false) {
  const item = v.__item;
  if (!item) return;
  if (v.__lastPrice && v.__lastPrice.itemId === item) return; // already read since this navigation
  for (const t of v.__timers || []) clearTimeout(t);
  v.__timers = [];
  const attempt = async () => {
    if (v.__item !== item || v.webContents.isDestroyed()) return false;
    try {
      const r = await v.webContents.executeJavaScript(PRICE_SCRIPT, true);
      if (r && r.price) {
        let sellers = {}, offers = [];
        try { sellers = (await v.webContents.executeJavaScript(SELLERS_SCRIPT, true)) || {}; } catch { /* optional */ }
        if (sellers.others > 0 && withOffers) { // only on explicit request
          try { offers = (await v.webContents.executeJavaScript(OFFERS_SCRIPT, true)) || []; } catch { /* optional */ }
        }
        if (v.__item !== item) return false; // moved on while the panel was loading
        sendPrice(v, { itemId: item, price: r.price, was: r.was ?? null, seller: sellers.seller ?? null, others: sellers.others ?? null, offers });
        return true;
      }
    } catch { /* page navigated mid-read */ }
    return false;
  };
  // walmart.com hydrates late; retry a few times, stop at the first hit
  let done = false;
  for (const ms of [0, 400, 1500, 3500, 7000]) {
    v.__timers.push(setTimeout(async () => { if (!done && await attempt()) done = true; }, ms));
  }
}

const customerUrl = (itemId) => `https://www.walmart.com/ip/${encodeURIComponent(itemId)}`;
const SELLER_HOME = "https://seller.walmart.com/items-and-inventory/manage-items";

function paneShow(itemId, b, mode) {
  mode = mode === "seller" ? "seller" : "customer";
  const created = !panes[mode];
  if (created) panes[mode] = makePane(mode);
  const v = panes[mode];
  activePane = mode;
  paneWanted = true;
  const other = panes[mode === "seller" ? "customer" : "seller"];
  if (other) other.setVisible(false);
  v.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  });
  v.setVisible(true);
  if (mode === "seller") {
    // load Seller Center once, ever; after that the user browses it freely
    if (created) {
      paneLoading = true;
      v.webContents.loadURL(SELLER_HOME);
    }
  } else if (itemId && customerItem !== itemId) {
    customerItem = itemId;
    v.__item = itemId;
    v.__lastPrice = null;
    paneLoading = true;
    v.webContents.loadURL(customerUrl(itemId));
  }
  // a load we started is still in flight → stay hidden behind the spinner
  if (paneLoading && v.webContents.isLoading()) v.setVisible(false);
  return true;
}

// ---- hidden worker view ------------------------------------------------------
// All background reads (pane closed, scans, seller lookups for the hover
// card) go through a view that is never shown, so what the user is looking
// at in the pane is never disturbed.
function ensureWorker() {
  if (!panes.worker) panes.worker = makePane("worker");
  return panes.worker;
}
function workerLoad(itemId) {
  const w = ensureWorker();
  if (w.__item !== itemId) {
    w.__item = itemId;
    w.__lastPrice = null;
    w.webContents.loadURL(customerUrl(itemId));
    return true;
  }
  return false;
}
function panePrefetch(itemId) {
  if (!itemId) return false;
  const w = ensureWorker();
  if (!workerLoad(itemId)) {
    if (w.__lastPrice && w.__lastPrice.itemId === itemId) sendPrice(w, w.__lastPrice); // answer from memory
    else scheduleReadPrice(w);                                                           // page is there, price wasn't caught yet
  }
  return true;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The other sellers' prices for one item, on demand (the hover card). Loads
// the item in the worker if needed, waits for its price, then opens the panel.
async function paneOffers(itemId) {
  if (!itemId) return null;
  const w = ensureWorker();
  workerLoad(itemId);
  for (let i = 0; i < 50 && !(w.__lastPrice && w.__lastPrice.itemId === itemId); i++) await wait(300); // ≤15 s
  if (w.__item !== itemId || !w.__lastPrice || w.__lastPrice.itemId !== itemId) return null;
  try {
    const offers = (await w.webContents.executeJavaScript(OFFERS_SCRIPT, true)) || [];
    if (w.__item !== itemId) return null;
    sendPrice(w, { ...w.__lastPrice, offers });
    return offers;
  } catch { return null; }
}
// The Market tab's scan: buy box, seller and every other seller's price for
// one item, read fresh in the hidden worker (a day-old page is reloaded).
async function marketReadWalmart(itemId) {
  if (!itemId) return null;
  const w = ensureWorker();
  w.__item = null; // force a reload even if this item was the last one read
  workerLoad(itemId);
  for (let i = 0; i < 80 && !(w.__lastPrice && w.__lastPrice.itemId === itemId); i++) await wait(300); // ≤24 s
  if (w.__item !== itemId || !w.__lastPrice || w.__lastPrice.itemId !== itemId) return null;
  let offers = [];
  if (w.__lastPrice.others !== 0) {
    try { offers = (await w.webContents.executeJavaScript(OFFERS_SCRIPT, true)) || []; } catch { offers = []; }
  }
  if (w.__item !== itemId) return null;
  const p = { ...w.__lastPrice, offers, at: Date.now() };
  sendPrice(w, p);
  return p;
}

// ---- Amazon (Market tab) ---------------------------------------------------
// A second hidden view reads amazon.com product pages for the Amazon listings
// linked to a SKU: buy box price, Prime, seller, other-offer count. A robot
// check is reported as { robot: true }; the view can then be shown docked so
// the user passes it once (amazonShow) — the session is shared, so later
// reads go through.
const AMZ_SCRIPT = `(() => {
  const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/\\d+(?:\\.\\d{1,2})?/); return m ? Number(m[0]) : null; };
  const ok = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  const text = document.body?.innerText || "";
  if (/Robot Check/i.test(document.title) || document.querySelector('form[action*="validateCaptcha"]') || /Enter the characters you see below|Type the characters you see/i.test(text)) return { robot: true };
  const title = (document.getElementById("productTitle")?.textContent || document.title.replace(/\\s*[:|-]\\s*Amazon\\.com.*$/i, "")).replace(/\\s+/g, " ").trim().slice(0, 120);
  let price = null;
  const sels = ['#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen', '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen', '#apex_desktop .priceToPay .a-offscreen', '#apex_desktop .a-price .a-offscreen',
    '#price_inside_buybox', '#newBuyBoxPrice', '#priceblock_ourprice', '#priceblock_dealprice', '#sns-base-price',
    '#buybox .a-price .a-offscreen', '#desktop_buybox .a-price .a-offscreen', '#tp_price_block_total_price_ww .a-offscreen'];
  for (const sel of sels) { const el = document.querySelector(sel); const p = num(el?.textContent); if (ok(p)) { price = p; break; } }
  const unavailable = /Currently unavailable/i.test(document.querySelector('#availability')?.textContent || "") || !!document.querySelector('#outOfStock');
  const prime = !!document.querySelector('#buybox i.a-icon-prime, #desktop_buybox i.a-icon-prime, #apex_desktop i.a-icon-prime, #primeExclusiveBuyBox, #deliveryBlockMessage i.a-icon-prime, [aria-label="Prime"]');
  let seller = null;
  const sEl = document.querySelector('#sellerProfileTriggerId') || document.querySelector('#merchantInfoFeature_feature_div .offer-display-feature-text-message') || document.querySelector('#merchant-info a') || document.querySelector('#merchant-info');
  if (sEl) seller = sEl.textContent.replace(/^\\s*Sold by\\s*/i, "").replace(/\\s+/g, " ").trim().slice(0, 60);
  if (!seller) { const m = /Sold by\\s+([^\\n]{2,60}?)(?:\\n|$)/i.exec(text); if (m) seller = m[1].trim(); }
  let offers = null;
  const oEl = document.querySelector('#olpLinkWidget_feature_div, #olp-upd-new, #dynamic-aod-ingress-box, #moreBuyingChoices_feature_div, #olp_feature_div');
  const om = /New\\s*\\((\\d+)\\)|\\((\\d+)\\)\\s*from|(\\d+)\\s+(?:new\\s+)?(?:offers?|sellers?)/i.exec(oEl?.textContent || "");
  if (om) offers = Number(om[1] || om[2] || om[3]);
  let sold = null;
  const sEl2 = document.querySelector('#social-proofing-faceout-title-text, #socialProofingAsinFaceout_feature_div, [id^="social-proofing"]');
  const sm = /(\\d[\\d,.]*\\s*[Kk]?\\+?)\\s+bought in (?:the )?past month/i.exec(sEl2?.textContent || "") || /(\\d[\\d,.]*\\s*[Kk]?\\+?)\\s+bought in (?:the )?past month/i.exec(text);
  if (sm) sold = sm[1].replace(/\\s+/g, "").toUpperCase();
  return { price: ok(price) ? price : null, title, prime, seller, offers, unavailable, sold };
})()`;
const amazonUrl = (asin) => `https://www.amazon.com/dp/${encodeURIComponent(asin)}?th=1&psc=1`;
function ensureAmazon() {
  if (!panes.amazon) panes.amazon = makePane("amazon");
  return panes.amazon;
}
function amazonLoad(v, url) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(t); v.webContents.removeListener("did-finish-load", fin); v.webContents.removeListener("did-fail-load", fin); resolve(); };
    const t = setTimeout(fin, 20000);
    v.webContents.once("did-finish-load", fin);
    v.webContents.once("did-fail-load", fin);
    v.webContents.loadURL(url).catch(() => fin());
  });
}
async function amazonRead(asin) {
  asin = String(asin ?? "").trim();
  if (!/^[A-Z0-9]{10}$/i.test(asin)) return { asin, error: "not an ASIN" };
  const v = ensureAmazon();
  v.__asin = asin;
  await amazonLoad(v, amazonUrl(asin));
  let last = null;
  for (const ms of [400, 1200, 2500, 4500]) {
    await wait(ms);
    if (v.__asin !== asin || v.webContents.isDestroyed()) return null;
    try { last = await v.webContents.executeJavaScript(AMZ_SCRIPT, true); } catch { last = null; }
    if (last && (last.robot || last.price)) break;
  }
  return { asin, ...(last || {}), readAt: Date.now() };
}
let amazonShown = false;
function amazonShow(asin, b) {
  const v = ensureAmazon();
  if (asin && v.__asin !== asin) { v.__asin = asin; v.webContents.loadURL(amazonUrl(asin)).catch(() => {}); }
  else if (!v.webContents.getURL()) v.webContents.loadURL("https://www.amazon.com/").catch(() => {});
  v.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) });
  v.setVisible(true);
  amazonShown = true;
  return true;
}
function amazonHide() {
  amazonShown = false;
  panes.amazon?.setVisible(false);
  return true;
}

function paneHide() {
  paneWanted = false;
  activePane = null;
  for (const [k, v] of Object.entries(panes)) { if (k !== "amazon" || !amazonShown) v?.setVisible(false); }
  return true;
}
function paneZoomBy(dir) {
  paneZoom = dir === 0 ? 1 : Math.min(1.5, Math.max(0.4, Math.round((paneZoom + dir * 0.05) * 100) / 100));
  for (const v of Object.values(panes)) {
    try { v?.webContents.setZoomFactor(paneZoom); } catch { /* view gone */ }
  }
  saveUi({ paneZoom });
  return paneZoom;
}

// ---- updates ---------------------------------------------------------------
// New versions are published as GitHub Releases by the release workflow.
// Windows: electron-updater fetches latest.yml from the release, downloads the
// installer in the background and swaps the app on restart.
// macOS: the build is unsigned, so Squirrel/electron-updater can't be used and
// a .dmg downloaded in the browser gets Gatekeeper's "unidentified developer"
// stop every time. Instead the app downloads the release's .zip itself (files
// an app fetches directly carry no quarantine flag), unpacks it with ditto,
// and on "Restart to update" a small shell script swaps the bundle in place
// once the app has quit, then reopens it. If any of that isn't possible
// (running from the .dmg, download blocked), the .dmg link is offered.
const RELEASES_API = "https://api.github.com/repos/amiablet21/walmart-listing-browser/releases/latest";
const RELEASES_PAGE = "https://github.com/amiablet21/walmart-listing-browser/releases/latest";
const { execFile, spawn } = require("child_process");
let updateState = { state: "idle", current: app.getVersion() };
function pushUpdate(patch) {
  updateState = { ...updateState, ...patch, current: app.getVersion() };
  try { win?.webContents.send("update:state", updateState); } catch { /* window gone */ }
  return updateState;
}
const semver = (v) => String(v ?? "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) { // a > b ?
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;
autoUpdater.on("update-available", (info) => pushUpdate({ state: "available", version: info.version }));
autoUpdater.on("update-not-available", () => pushUpdate({ state: "none" }));
autoUpdater.on("download-progress", (p) => pushUpdate({ state: "downloading", percent: Math.round(p.percent) }));
autoUpdater.on("update-downloaded", (info) => pushUpdate({ state: "ready", version: info.version }));
autoUpdater.on("error", (e) => pushUpdate({ state: "error", message: e?.message || String(e) }));

async function checkGithubRelease() {
  const res = await fetch(RELEASES_API, { headers: { "User-Agent": "walmart-listing-browser", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || "").replace(/^v/, "");
  const assets = rel.assets || [];
  const dmg = assets.find((a) => /\.dmg$/i.test(a.name));
  const zip = assets.find((a) => /-mac\.zip$|-universal\.zip$|\.zip$/i.test(a.name) && !/win/i.test(a.name));
  return { version, url: dmg?.browser_download_url || rel.html_url || RELEASES_PAGE, zipUrl: zip?.browser_download_url || null };
}

// The running .app bundle (…/Walmart Listing Browser.app), or null outside one.
function macAppBundle() {
  const m = /^(.*?\.app)\/Contents\//.exec(process.execPath);
  return m ? m[1] : null;
}
// Can this install swap itself? Not from the mounted .dmg (read-only) and not
// without a bundle at all (dev run).
function macCanSelfUpdate() {
  const bundle = macAppBundle();
  if (!bundle || bundle.startsWith("/Volumes/")) return false;
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return true; } catch { return false; }
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) return pushUpdate({ state: "none", manual, dev: true });
  pushUpdate({ state: "checking", manual });
  try {
    if (process.platform === "win32") {
      const r = await autoUpdater.checkForUpdates();
      // the event handlers above push the resulting state; echo it back
      const version = r?.updateInfo?.version;
      return pushUpdate(version && isNewer(version, app.getVersion())
        ? { state: "available", version, manual } : { state: "none", manual });
    }
    const { version, url, zipUrl } = await checkGithubRelease();
    const canSelfUpdate = process.platform === "darwin" && !!zipUrl && macCanSelfUpdate();
    return pushUpdate(isNewer(version, app.getVersion())
      ? { state: "available", version, url, zipUrl, canSelfUpdate, manual } : { state: "none", manual });
  } catch (e) {
    return pushUpdate({ state: "error", message: e?.message || String(e), manual });
  }
}

// Stream a URL to a file, following redirects, reporting percent.
async function downloadFile(url, dest, onPercent) {
  const res = await fetch(url, { headers: { "User-Agent": "walmart-listing-browser" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0, lastPct = -1;
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    if (total) { const pct = Math.floor((got / total) * 100); if (pct !== lastPct) { lastPct = pct; onPercent(pct); } }
  }
  await new Promise((resolve, reject) => { out.on("error", reject); out.end(resolve); });
}
const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

let macUpdate = null; // { version, newApp } once unpacked
async function downloadMacUpdate() {
  const { version, zipUrl } = updateState;
  const dir = path.join(app.getPath("temp"), "walmart-listing-browser-update", version);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, "update.zip");
  pushUpdate({ state: "downloading", percent: 0, version });
  await downloadFile(zipUrl, zipPath, (percent) => pushUpdate({ state: "downloading", percent, version }));
  await run("/usr/bin/ditto", ["-x", "-k", zipPath, dir]); // keeps the bundle structure and permissions
  const appName = fs.readdirSync(dir).find((n) => n.endsWith(".app"));
  if (!appName) throw new Error("the downloaded build has no .app inside");
  const newApp = path.join(dir, appName);
  try { await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newApp]); } catch { /* none set */ }
  if (!fs.existsSync(path.join(newApp, "Contents", "MacOS"))) throw new Error("the downloaded build looks incomplete");
  macUpdate = { version, newApp };
  pushUpdate({ state: "ready", version });
}
async function downloadUpdate() {
  if (process.platform === "darwin" && updateState.state === "available" && updateState.canSelfUpdate) {
    try { await downloadMacUpdate(); }
    catch (e) { pushUpdate({ state: "error", message: `${e?.message || e}. Use the .dmg instead.`, fromDownload: true }); }
    return updateState;
  }
  if (process.platform !== "win32") {
    shell.openExternal(updateState.url || RELEASES_PAGE);
    return updateState;
  }
  pushUpdate({ state: "downloading", percent: 0 });
  try { await autoUpdater.downloadUpdate(); } catch (e) { pushUpdate({ state: "error", message: e?.message || String(e), fromDownload: true }); }
  return updateState;
}
// Swap the bundle after this process exits: a detached shell script waits for
// our PID to go away, replaces the old app with the new one and reopens it.
function installMacUpdate() {
  const dest = macAppBundle();
  if (!macUpdate || !dest) return false;
  const script = path.join(path.dirname(macUpdate.newApp), "swap.sh");
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(script, `#!/bin/sh
PID=${process.pid}
i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.3; i=$((i+1)); done
DEST=${q(dest)}
NEW=${q(macUpdate.newApp)}
BAK="$DEST.previous"
rm -rf "$BAK"
mv "$DEST" "$BAK" 2>/dev/null
if mv "$NEW" "$DEST" 2>/dev/null || /usr/bin/ditto "$NEW" "$DEST"; then
  rm -rf "$BAK"
else
  mv "$BAK" "$DEST" 2>/dev/null
fi
/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
sleep 0.5
/usr/bin/open "$DEST"
`, { mode: 0o755 });
  const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore" });
  child.unref();
  setTimeout(() => app.quit(), 150);
  return true;
}
function installUpdate() {
  if (process.platform === "win32" && updateState.state === "ready") {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }
  if (process.platform === "darwin" && updateState.state === "ready" && installMacUpdate()) return true;
  shell.openExternal(updateState.url || RELEASES_PAGE);
  return false;
}
const UPDATE_EVERY = 4 * 60 * 60 * 1000;

// ---- app lifecycle ---------------------------------------------------------
// Own taskbar identity (icon grouping, notifications) instead of Electron's.
app.setAppUserModelId("com.imrantursun.walmart-listing-browser");

app.whenReady().then(() => {
  dataFile = path.join(app.getPath("userData"), "items.json");
  uiFile = path.join(app.getPath("userData"), "ui.json");
  const savedZoom = loadUi().paneZoom;
  if (Number.isFinite(savedZoom)) paneZoom = Math.min(1.5, Math.max(0.4, savedZoom));

  ipcMain.handle("items:list", () => loadItems());
  ipcMain.handle("items:save", (_e, items) => saveItems(Array.isArray(items) ? items : []));
  ipcMain.handle("listing:show", (_e, { itemId, bounds, mode }) => paneShow(itemId, bounds, mode));
  ipcMain.handle("listing:hide", () => paneHide());
  ipcMain.handle("listing:prefetch", (_e, itemId) => panePrefetch(itemId));
  ipcMain.handle("listing:offers", (_e, itemId) => paneOffers(itemId));
  ipcMain.handle("market:readWalmart", (_e, itemId) => marketReadWalmart(itemId));
  ipcMain.handle("market:readAmazon", (_e, asin) => amazonRead(asin));
  ipcMain.handle("market:showAmazon", (_e, { asin, bounds }) => amazonShow(asin, bounds));
  ipcMain.handle("market:hideAmazon", () => amazonHide());
  ipcMain.handle("market:openAmazon", (_e, asin) => shell.openExternal(amazonUrl(asin)));
  ipcMain.handle("listing:zoom", (_e, dir) => paneZoomBy(dir));
  ipcMain.handle("listing:openExternal", (_e, itemId) =>
    shell.openExternal(`https://www.walmart.com/ip/${encodeURIComponent(itemId)}`));
  ipcMain.handle("clip:read", () => clipboard.readText());
  ipcMain.handle("clip:write", (_e, t) => { clipboard.writeText(String(t ?? "")); return true; });
  ipcMain.handle("sheet:import", () => importSheet());
  ipcMain.handle("sheet:template", () => saveImportTemplate());
  ipcMain.handle("sheet:export", (_e, payload) => exportSheet(payload));
  ipcMain.handle("sheet:exportRepricer", (_e, payload) => exportRepricer(payload));
  ipcMain.handle("sheet:exportIncentive", (_e, payload) => exportIncentive(payload));
  ipcMain.handle("listing:price", () => lastPrice);
  ipcMain.handle("update:check", (_e, manual) => checkForUpdates(!!manual));
  ipcMain.handle("update:download", () => downloadUpdate());
  ipcMain.handle("update:install", () => installUpdate());
  ipcMain.handle("update:state", () => updateState);
  ipcMain.handle("app:version", () => app.getVersion());

  createWindow();
  // quiet check shortly after launch, then every few hours while running
  setTimeout(() => checkForUpdates(false), 8000);
  setInterval(() => { if (updateState.state !== "downloading" && updateState.state !== "ready") checkForUpdates(false); }, UPDATE_EVERY);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
