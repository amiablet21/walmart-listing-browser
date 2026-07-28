// Walmart Listing Browser — Electron main process.
// Keeps a local list of { sku, itemId } rows and loads the live walmart.com
// listing for the selected row into a docked browser pane on the right.
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Menu, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");

// ---- tiny JSON store (userData/items.json) --------------------------------
let dataFile = null;
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
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const panes = { customer: null, seller: null };
let activePane = null;   // which pane the renderer currently wants shown
let customerItem = null; // itemId loaded in the customer pane
let paneZoom = 0.7;
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
  paneZoom = dir === 0 ? 0.7 : Math.min(1.3, Math.max(0.4, Math.round((paneZoom + dir * 0.05) * 100) / 100));
  for (const v of Object.values(panes)) {
    try { v?.webContents.setZoomFactor(paneZoom); } catch { /* view gone */ }
  }
  return paneZoom;
}

// ---- app lifecycle ---------------------------------------------------------
// Own taskbar identity (icon grouping, notifications) instead of Electron's.
app.setAppUserModelId("com.imrantursun.walmart-listing-browser");

app.whenReady().then(() => {
  dataFile = path.join(app.getPath("userData"), "items.json");

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

  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
