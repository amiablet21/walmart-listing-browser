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
// Reads the first four columns: SKU, Item ID, Before Price, During Incentive.
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
  ws.eachRow((row) => rows.push([1, 2, 3, 4].map((c) => cellText(row.getCell(c)))));
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
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: "Export spreadsheet",
    defaultPath: `incentive-list-${stamp}.xlsx`,
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
      head.forEach((_, i) => { ws.getColumn(i + 1).width = i === 0 ? 26 : 15; });
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

// ---- docked live-listing pane ---------------------------------------------
// A WebContentsView (window-grade browser, unlike <webview> which walmart.com
// refuses to render into) positioned over the right side of the window. The
// renderer sends the region's bounds.
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
let paneView = null;
let paneItem = null;
let paneZoom = 0.7;
let paneWanted = false;  // whether the renderer currently wants the pane visible
let paneLoading = false; // true only while WE are loading a new item (not walmart's own background loads)

function ensurePane() {
  if (paneView) return paneView;
  paneView = new WebContentsView({
    webPreferences: {
      partition: "persist:listing",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  paneView.webContents.setUserAgent(CHROME_UA);
  paneView.webContents.on("dom-ready", () => {
    try { paneView.webContents.setZoomFactor(paneZoom); } catch { /* view gone */ }
  });
  // Ctrl+scroll (or trackpad pinch) over the listing zooms it, like a browser.
  paneView.webContents.on("zoom-changed", (_e, dir) => {
    paneZoomBy(dir === "in" ? 1 : -1);
  });
  // Loading screen: an HTML overlay can't cover the native view, so while a
  // NEW item is loading the view hides and the renderer shows a spinner.
  // Only loads we initiate count — walmart.com fires loading events constantly
  // (ads, iframes) and reacting to those made the pane flicker mid-use.
  paneView.webContents.on("did-start-loading", () => {
    if (!paneLoading) return;
    try { win?.webContents.send("listing:loading", true); } catch { /* window gone */ }
    if (paneWanted) paneView.setVisible(false);
  });
  paneView.webContents.on("did-stop-loading", () => {
    if (!paneLoading) return;
    paneLoading = false;
    try { win?.webContents.send("listing:loading", false); } catch { /* window gone */ }
    if (paneWanted) paneView.setVisible(true);
  });
  attachContextMenu(paneView.webContents);
  paneView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) paneView.webContents.loadURL(url);
    return { action: "deny" };
  });
  win.contentView.addChildView(paneView);
  return paneView;
}

function paneShow(itemId, b) {
  const v = ensurePane();
  paneWanted = true;
  v.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height)),
  });
  v.setVisible(true);
  if (paneItem !== itemId) {
    paneItem = itemId;
    paneLoading = true;
    v.webContents.loadURL(`https://www.walmart.com/ip/${encodeURIComponent(itemId)}`);
  }
  return true;
}
function paneHide() {
  paneWanted = false;
  if (paneView) paneView.setVisible(false);
  return true;
}
function paneZoomBy(dir) {
  paneZoom = dir === 0 ? 0.7 : Math.min(1.3, Math.max(0.4, Math.round((paneZoom + dir * 0.05) * 100) / 100));
  try { paneView?.webContents.setZoomFactor(paneZoom); } catch { /* view gone */ }
  return paneZoom;
}

// ---- app lifecycle ---------------------------------------------------------
// Own taskbar identity (icon grouping, notifications) instead of Electron's.
app.setAppUserModelId("com.imrantursun.walmart-listing-browser");

app.whenReady().then(() => {
  dataFile = path.join(app.getPath("userData"), "items.json");

  ipcMain.handle("items:list", () => loadItems());
  ipcMain.handle("items:save", (_e, items) => saveItems(Array.isArray(items) ? items : []));
  ipcMain.handle("listing:show", (_e, { itemId, bounds }) => paneShow(itemId, bounds));
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
