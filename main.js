// Walmart Listing Browser — Electron main process.
// Keeps a local list of { sku, itemId } rows and loads the live walmart.com
// listing for the selected row into a docked browser pane on the right.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { buildRepricerBuffer, DEFAULT_STRATEGY } = require("./repricer");
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
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: "Export spreadsheet",
    defaultPath: `${name}-${stamp}.xlsx`,
    filters: [
      { name: "Excel", extensions: ["xlsx"] },
      { name: "CSV", extensions: ["csv"] },
    ],
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

function makePane(mode) {
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
  if (mode === "customer") {
    const report = (url) => {
      const m = /\/ip\/(?:[^/]+\/)?(\d{5,})(?:[/?#]|$)/.exec(url);
      if (!m || m[1] === customerItem) return;
      customerItem = m[1]; // a later row click on this item won't reload
      try { win?.webContents.send("listing:navigated", m[1]); } catch { /* window gone */ }
    };
    v.webContents.on("did-navigate", (_e, url) => { report(url); sendPrice(null); scheduleReadPrice(v); });
    v.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) { report(url); sendPrice(null); scheduleReadPrice(v); }
    });
    v.webContents.on("did-finish-load", () => scheduleReadPrice(v));
  }
  win.contentView.addChildView(v);
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
let priceTimers = [];
let lastPrice = null;
function sendPrice(p) {
  lastPrice = p;
  try { win?.webContents.send("listing:price", p); } catch { /* window gone */ }
}
function scheduleReadPrice(v) {
  for (const t of priceTimers) clearTimeout(t);
  priceTimers = [];
  const item = customerItem;
  const attempt = async () => {
    if (panes.customer !== v || customerItem !== item || v.webContents.isDestroyed()) return false;
    try {
      const r = await v.webContents.executeJavaScript(PRICE_SCRIPT, true);
      if (r && r.price) {
        let sellers = {};
        try { sellers = (await v.webContents.executeJavaScript(SELLERS_SCRIPT, true)) || {}; } catch { /* optional */ }
        sendPrice({ itemId: item, price: r.price, was: r.was ?? null, seller: sellers.seller ?? null, others: sellers.others ?? null });
        return true;
      }
    } catch { /* page navigated mid-read */ }
    return false;
  };
  // walmart.com hydrates late; retry a few times, stop at the first hit
  let done = false;
  for (const ms of [400, 1500, 3500, 7000]) {
    priceTimers.push(setTimeout(async () => { if (!done && await attempt()) done = true; }, ms));
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
    paneLoading = true;
    v.webContents.loadURL(customerUrl(itemId));
  }
  // a load we started is still in flight → stay hidden behind the spinner
  if (paneLoading && v.webContents.isLoading()) v.setVisible(false);
  return true;
}
// Load a listing into the customer pane without showing it, so the price
// suggestion keeps working while the user has the pane closed. The view
// stays invisible (paneWanted=false) through did-stop-loading.
function panePrefetch(itemId) {
  if (!itemId) return false;
  const created = !panes.customer;
  if (created) panes.customer = makePane("customer");
  const v = panes.customer;
  activePane = "customer";
  paneWanted = false;
  for (const o of Object.values(panes)) o?.setVisible(false);
  if (customerItem !== itemId) {
    customerItem = itemId;
    paneLoading = true;
    v.webContents.loadURL(customerUrl(itemId));
  } else if (lastPrice && lastPrice.itemId === itemId) {
    sendPrice(lastPrice);          // already read — answer from memory
  } else {
    scheduleReadPrice(v);          // page is there, price wasn't caught yet
  }
  return true;
}
function paneHide() {
  paneWanted = false;
  activePane = null;
  for (const v of Object.values(panes)) v?.setVisible(false);
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
// installer in the background and swaps the app on restart. macOS: the build
// is unsigned, so the OS won't let it replace itself — we check the GitHub API
// for a newer tag and hand the user the .dmg link instead.
const RELEASES_API = "https://api.github.com/repos/amiablet21/walmart-listing-browser/releases/latest";
const RELEASES_PAGE = "https://github.com/amiablet21/walmart-listing-browser/releases/latest";
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
  const asset = (rel.assets || []).find((a) => /\.dmg$/i.test(a.name));
  return { version, url: asset?.browser_download_url || rel.html_url || RELEASES_PAGE };
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
    const { version, url } = await checkGithubRelease();
    return pushUpdate(isNewer(version, app.getVersion())
      ? { state: "available", version, url, manual } : { state: "none", manual });
  } catch (e) {
    return pushUpdate({ state: "error", message: e?.message || String(e), manual });
  }
}
async function downloadUpdate() {
  if (process.platform !== "win32") {
    shell.openExternal(updateState.url || RELEASES_PAGE);
    return updateState;
  }
  pushUpdate({ state: "downloading", percent: 0 });
  try { await autoUpdater.downloadUpdate(); } catch (e) { pushUpdate({ state: "error", message: e?.message || String(e) }); }
  return updateState;
}
function installUpdate() {
  if (process.platform === "win32" && updateState.state === "ready") {
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }
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
  ipcMain.handle("listing:zoom", (_e, dir) => paneZoomBy(dir));
  ipcMain.handle("listing:openExternal", (_e, itemId) =>
    shell.openExternal(`https://www.walmart.com/ip/${encodeURIComponent(itemId)}`));
  ipcMain.handle("clip:read", () => clipboard.readText());
  ipcMain.handle("clip:write", (_e, t) => { clipboard.writeText(String(t ?? "")); return true; });
  ipcMain.handle("sheet:import", () => importSheet());
  ipcMain.handle("sheet:template", () => saveImportTemplate());
  ipcMain.handle("sheet:export", (_e, payload) => exportSheet(payload));
  ipcMain.handle("sheet:exportRepricer", (_e, payload) => exportRepricer(payload));
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
