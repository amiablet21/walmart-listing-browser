// Walmart Listing Browser — Electron main process.
// Keeps a local list of { sku, itemId } rows and loads the live walmart.com
// listing for the selected row into a docked browser pane on the right.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, clipboard, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const { buildRepricerBuffer, DEFAULT_STRATEGY } = require("./repricer");
const { WalmartClient } = require("./walmartApi");

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
    if (!String(sku ?? "").trim() && !String(itemId ?? "").trim()) continue;
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

// ---- Walmart Marketplace API (Buy Box scan) --------------------------------
// Credentials live in userData/api.json. The Client Secret is encrypted with
// the OS keychain (Electron safeStorage) when available; it never leaves the
// main process — the renderer only learns whether one is stored.
let apiFile = null;
function loadApiSettings() {
  try { return JSON.parse(fs.readFileSync(apiFile, "utf8")) || {}; } catch { return {}; }
}
function encryptSecret(secret) {
  const s = String(secret ?? "");
  if (!s) return "";
  if (safeStorage.isEncryptionAvailable()) return "enc:" + safeStorage.encryptString(s).toString("base64");
  return "raw:" + Buffer.from(s, "utf8").toString("base64");
}
function decryptSecret(stored) {
  const s = String(stored ?? "");
  if (!s) return "";
  try {
    if (s.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(s.slice(4), "base64"));
    if (s.startsWith("raw:")) return Buffer.from(s.slice(4), "base64").toString("utf8");
  } catch { /* keychain changed → treat as missing */ }
  return "";
}
// What the renderer may see: never the secret itself.
function publicApiSettings() {
  const cfg = loadApiSettings();
  return {
    clientId: cfg.clientId || "",
    env: cfg.env === "sandbox" ? "sandbox" : "production",
    hasSecret: !!decryptSecret(cfg.secret),
    lastScan: cfg.lastScan || null,
  };
}
function saveApiSettings(patch) {
  const cur = loadApiSettings();
  const next = { ...cur };
  if (typeof patch?.clientId === "string") next.clientId = patch.clientId.trim();
  if (patch?.env) next.env = patch.env === "sandbox" ? "sandbox" : "production";
  // an empty secret in the form means "keep the one already stored"
  if (typeof patch?.clientSecret === "string" && patch.clientSecret.trim()) {
    next.secret = encryptSecret(patch.clientSecret.trim());
  }
  if (patch?.clear) { next.clientId = ""; next.secret = ""; }
  if (patch?.lastScan !== undefined) next.lastScan = patch.lastScan;
  try { fs.writeFileSync(apiFile, JSON.stringify(next, null, 2)); } catch (e) { console.error("Failed to save API settings:", e); }
  return publicApiSettings();
}
function makeClient(override) {
  const cfg = loadApiSettings();
  return new WalmartClient({
    clientId: override?.clientId?.trim() || cfg.clientId,
    clientSecret: override?.clientSecret?.trim() || decryptSecret(cfg.secret),
    env: override?.env || cfg.env,
  });
}
async function testApi(override) {
  try {
    const r = await makeClient(override).testConnection();
    return { ok: true, host: r.host };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}
let scanning = false;
async function scanBuyBox(skus) {
  if (scanning) return { error: "A scan is already running." };
  scanning = true;
  try {
    const client = makeClient();
    const list = Array.isArray(skus) ? skus : [];
    const { bySku, missing } = await client.pricingInsights(list, (done, total) => {
      try { win?.webContents.send("api:progress", { done, total }); } catch { /* window gone */ }
    });
    const at = Date.now();
    saveApiSettings({ lastScan: at });
    return { ok: true, bySku, missing, at, host: client.host };
  } catch (e) {
    return { error: e.message || String(e), status: e.status || 0 };
  } finally {
    scanning = false;
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
    v.webContents.on("did-navigate", (_e, url) => report(url));
    v.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => {
      if (isMainFrame) report(url);
    });
  }
  win.contentView.addChildView(v);
  return v;
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

// ---- app lifecycle ---------------------------------------------------------
// Own taskbar identity (icon grouping, notifications) instead of Electron's.
app.setAppUserModelId("com.imrantursun.walmart-listing-browser");

app.whenReady().then(() => {
  dataFile = path.join(app.getPath("userData"), "items.json");
  uiFile = path.join(app.getPath("userData"), "ui.json");
  apiFile = path.join(app.getPath("userData"), "api.json");
  const savedZoom = loadUi().paneZoom;
  if (Number.isFinite(savedZoom)) paneZoom = Math.min(1.5, Math.max(0.4, savedZoom));

  ipcMain.handle("items:list", () => loadItems());
  ipcMain.handle("items:save", (_e, items) => saveItems(Array.isArray(items) ? items : []));
  ipcMain.handle("listing:show", (_e, { itemId, bounds, mode }) => paneShow(itemId, bounds, mode));
  ipcMain.handle("listing:hide", () => paneHide());
  ipcMain.handle("listing:zoom", (_e, dir) => paneZoomBy(dir));
  ipcMain.handle("listing:openExternal", (_e, itemId) =>
    shell.openExternal(`https://www.walmart.com/ip/${encodeURIComponent(itemId)}`));
  ipcMain.handle("clip:read", () => clipboard.readText());
  ipcMain.handle("clip:write", (_e, t) => { clipboard.writeText(String(t ?? "")); return true; });
  ipcMain.handle("sheet:import", () => importSheet());
  ipcMain.handle("sheet:export", (_e, payload) => exportSheet(payload));
  ipcMain.handle("sheet:exportRepricer", (_e, payload) => exportRepricer(payload));
  ipcMain.handle("api:getSettings", () => publicApiSettings());
  ipcMain.handle("api:saveSettings", (_e, patch) => saveApiSettings(patch));
  ipcMain.handle("api:test", (_e, override) => testApi(override));
  ipcMain.handle("api:scanBuyBox", (_e, skus) => scanBuyBox(skus));
  ipcMain.handle("api:openDocs", () => shell.openExternal("https://developer.walmart.com/us-marketplace/reference/pricinginsights"));
  ipcMain.handle("api:openKeys", () => shell.openExternal("https://developer.walmart.com/account/generate-key"));

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
