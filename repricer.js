// Walmart "Repricer Bulk Upload" file builder (spec v1.1).
//
// Fills in the official template shipped at templates/repricer-template.xlsx —
// the exact file the user downloaded from Seller Center — so the output keeps
// its formatting (fonts, column widths, header fills), its hidden attribute
// sheet, and the version line byte-for-byte. Only the data rows are added.
//
// Data entry begins at row 7, columns D (SKU) and E (Repricer Strategy), with
// F (Minimum) and G (Maximum) Seller Allowed Price. External-product-id columns
// (H, I) are left as the template has them.

const path = require("path");

// Default strategy assigned to every product unless a caller overrides it.
// Must match the name on the Repricer page in Seller Center exactly.
const DEFAULT_STRATEGY = "IMRAN BUY BOX";

const SHEET_NAME = "Repricer Bulk Upload";
const DATA_START_ROW = 7;
const TEMPLATE_PATH = path.join(__dirname, "templates", "repricer-template.xlsx");

// Normalize incoming rows to { sku, min, max }, deduplicating by SKU (keep
// first occurrence) and dropping blanks — the repricer is keyed on SKU, so a
// product with no SKU can't be included. `min`/`max` are optional numbers; a
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

// Returns an xlsx Buffer for the filled repricer file, or throws.
// `rows` is an array of { sku, min?, max? }.
async function buildRepricerBuffer(ExcelJS, rows, strategy, templatePath) {
  const clean = cleanRows(rows);
  const strat = String(strategy ?? "").trim() || DEFAULT_STRATEGY;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath || TEMPLATE_PATH);
  const ws = wb.getWorksheet(SHEET_NAME);
  if (!ws) throw new Error(`Template is missing the "${SHEET_NAME}" sheet.`);
  clean.forEach((row, i) => {
    const r = DATA_START_ROW + i;
    ws.getCell(`D${r}`).value = row.sku;              // SKU
    ws.getCell(`E${r}`).value = strat;                // Repricer Strategy
    if (row.min != null) ws.getCell(`F${r}`).value = row.min;  // Minimum Seller Allowed Price
    if (row.max != null) ws.getCell(`G${r}`).value = row.max;  // Maximum Seller Allowed Price
  });
  return wb.xlsx.writeBuffer();
}

module.exports = { buildRepricerBuffer, cleanRows, DEFAULT_STRATEGY, DATA_START_ROW, TEMPLATE_PATH };
