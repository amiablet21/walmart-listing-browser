// Walmart "Repricer Bulk Upload" file builder (spec v1.1).
//
// Fills the official Seller Center template shipped at
// templates/repricer-template.xlsx by editing the worksheet XML *in place*
// inside the .xlsx zip. Every other part of the file — the hidden attribute
// sheet, the workbook's defined names, the data-validation dropdowns and the
// extLst metadata Walmart's uploader requires — is passed through byte-for-byte.
//
// (An earlier version rebuilt the workbook through a spreadsheet library, which
// silently dropped that metadata and made Seller Center reject the upload with
// "missing attribute metadata in 'Repricer Bulk Upload' tab". Editing the raw
// XML avoids that entirely.)
//
// Data entry begins at row 7: D = SKU, E = Repricer Strategy, F = Minimum and
// G = Maximum Seller Allowed Price. Columns H/I are left as the template has them.

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

// Default strategy assigned to every product unless a caller overrides it.
// Must match the name on the Repricer page in Seller Center exactly.
const DEFAULT_STRATEGY = "IMRAN BUY BOX";

const SHEET_NAME = "Repricer Bulk Upload";
const DATA_START_ROW = 7;
const FALLBACK_SHEET_PATH = "xl/worksheets/sheet2.xml";
const TEMPLATE_PATH = path.join(__dirname, "templates", "repricer-template.xlsx");

// Normalize incoming rows to { sku, min, max }, deduplicating by SKU (keep
// first occurrence) and dropping blanks — the repricer is keyed on SKU, so a
// product with no SKU can't be included. min/max are optional numbers; a
// missing or invalid one is left blank in the file.
function cleanRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const sku = String(row?.sku ?? "").trim();
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    out.push({ sku, min: num(row?.min), max: num(row?.max) });
  }
  return out;
}

const xmlEscape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Inline string cell (avoids touching the shared-strings table).
const cellStr = (ref, val) =>
  `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
const cellNum = (ref, val) => `<c r="${ref}"><v>${Number(val)}</v></c>`;

function rowXml(r, row, strat) {
  const cells = [cellStr(`D${r}`, row.sku), cellStr(`E${r}`, strat)];
  if (row.min != null) cells.push(cellNum(`F${r}`, row.min));
  if (row.max != null) cells.push(cellNum(`G${r}`, row.max));
  return `<row r="${r}" spans="1:9">${cells.join("")}</row>`;
}

// Find the worksheet XML path for the visible "Repricer Bulk Upload" sheet by
// resolving its r:id through the workbook rels; falls back to sheet2.xml.
async function resolveSheetPath(zip) {
  try {
    const wb = await zip.file("xl/workbook.xml").async("string");
    const name = SHEET_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sheet = new RegExp(`<sheet[^>]*name="${name}"[^>]*r:id="([^"]+)"`).exec(wb);
    const rid = sheet && sheet[1];
    if (rid) {
      const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
      const rel = new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)
        || new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels);
      if (rel && rel[1]) return "xl/" + rel[1].replace(/^\/?xl\//, "").replace(/^\//, "");
    }
  } catch { /* fall through */ }
  return FALLBACK_SHEET_PATH;
}

// Returns an xlsx Buffer for the filled repricer file, or throws.
// `rows` is an array of { sku, min?, max? }.
async function buildRepricerBuffer(rows, strategy, templatePath) {
  const clean = cleanRows(rows);
  const strat = String(strategy ?? "").trim() || DEFAULT_STRATEGY;
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath || TEMPLATE_PATH));
  const sheetPath = await resolveSheetPath(zip);
  const entry = zip.file(sheetPath);
  if (!entry) throw new Error(`Template is missing ${sheetPath}.`);

  let xml = await entry.async("string");
  if (clean.length) {
    const body = clean.map((row, i) => rowXml(DATA_START_ROW + i, row, strat)).join("");
    xml = xml.replace("</sheetData>", body + "</sheetData>");
    const lastRow = DATA_START_ROW + clean.length - 1;
    xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:I${lastRow}"/>`);
  }
  zip.file(sheetPath, xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { buildRepricerBuffer, cleanRows, DEFAULT_STRATEGY, DATA_START_ROW, TEMPLATE_PATH };
