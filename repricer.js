// Walmart "Repricer Bulk Upload" file builder (spec v1.1).
//
// Rebuilds the official template from scratch — the version line, the header
// block, and the hidden attribute sheet Seller Center's uploader keys off —
// then writes one data row per SKU, each assigned a repricer strategy. Doing
// it this way means no binary .xlsx has to be bundled: the exact layout lives
// here as data.
//
// Data entry begins at row 7, columns D (SKU) and E (Repricer Strategy). The
// remaining columns (min/max price, external product id) are left blank, which
// matches "just SKU and strategy" — note that Walmart won't actually reprice an
// item until it also has a Minimum and Maximum Seller Allowed Price.

const VERSION_LINE =
  "Version=1.1,repricerstrategy,repricer_bulk_upload,en,external,Repricer Bulk Upload";

// The strategy assigned to every product unless a caller overrides it. Must
// match the name on the Repricer page in Seller Center exactly (case/space
// sensitive) — "IMRAN BUY BOX" is confirmed present in the account's template.
const DEFAULT_STRATEGY = "IMRAN BUY BOX";

// The hidden "Hidden_repricer_bulk_upload" sheet, verbatim from the template.
// Row 19 ("data_row:6") tells the uploader data begins on the next-after-6 row
// of the visible sheet; rows 21-26 are the account's valid strategy names.
const HIDDEN_ROWS = [
  ["Attribute Name", "SKU", "Repricer Strategy", "Minimum Seller Allowed Price", "Maximum Seller Allowed Price", "External Product ID Type", "External Product ID", "External Product Identifier"],
  ["Attribute XML Name", "sku", "repricerStrategy", "minimumSellerAllowedPrice", "maximumSellerAllowedPrice", "externalProductIdType", "externalProductId", "externalProductIdentifier"],
  ["Requirement Level", "Required", "Required", "Conditionally Required", "Conditionally Required", "Required", "Required", "Recommended"],
  ["Data Type", "String", "String", "Decimal", "Decimal", "String", "String", null],
  ["Member XML", null, null, null, null, null, null, null],
  ["Container XML", null, null, null, null, "externalProductIdentifier", "externalProductIdentifier", null],
  ["XSD Group Name", null, null, null, null, null, null, null],
  ["JSON Path", null, null, null, null, null, null, null],
  ["Is Multiselect", "N", "N", "N", "N", "N", "N", "Y"],
  ["Is Deletable", null, null, null, null, null, null, null],
  ["Strip Values", null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ["data_row:6", null, null, null, null, null, null, null],
  ["Repricer Bulk Upload", null, null, null, null, null, null, null],
  ["valid values", null, "No Strategy/Delete from Repricer", null, null, "ASIN", null, null],
  [null, null, "Pause Item in Strategy", null, null, null, null, null],
  [null, null, "Walmart Match Buy Box Price (Default)", null, null, null, null, null],
  [null, null, "Walmart Match Competitive Price (Default)", null, null, null, null, null],
  [null, null, "Walmart Suggested Strategy (Default)", null, null, null, null, null],
  [null, null, "IMRAN BUY BOX", null, null, null, null, null],
];

// Visible "Repricer Bulk Upload" sheet header block. Only the master cell of
// each merged range is set here; the merges are applied after.
const VISIBLE_HEADER = {
  A1: VERSION_LINE,
  D2: "SKU",                                                                    // merged D2:D5
  E2: "Required",
  F2: "Required for all strategies (except No Strategy/Delete from Repricer)",  // merged F2:G2
  H2: "Optional",                                                              // merged H2:I2
  H3: "External Product Identifier (externalProductIdentifier) (+)",           // merged H3:I3
  E4: "Repricer Strategy",
  F4: "Minimum Seller Allowed Price",
  G4: "Maximum Seller Allowed Price",
  H4: "External Product ID Type",
  I4: "External Product ID",
  E5: "repricerStrategy",
  F5: "minimumSellerAllowedPrice",
  G5: "maximumSellerAllowedPrice",
  H5: "externalProductIdType",
  I5: "externalProductId",
  D6: "Alphanumeric, 50 characters - The string of letters and/or numbers a partner uses to identify the item. EDI users must not exceed 15 characters for this field. Walmart includes this value in all communications regarding item information such as orders. Example: TRVAL28726",
  E6: "Alphanumeric, 75 characters - The Repricing strategy that you wish to assign to your items. Select from the drop-down or copy and paste the Strategy Name from the Repricer page in Seller Center. This field is case and space sensitive - please ensure that the name matches exactly as it appears on the Repricer page. Select \"No Strategy/Delete from Repricer\" to remove your items from a currently mapped strategy.",
  F6: "Decimal, 16 characters - Your offer's floor/lowest price at which you are willing to sell it for. You must set a valid minimum seller allowed price for repricer to take action. Note: The Repricer will not overwrite existing MAP price rules applied through the Price & Promotions Spec. Example: 23.99",
  G6: "Decimal, 16 characters - Your offer's ceiling/highest price at which you are willing to sell it for. You must set a valid maximum seller allowed price for repricer to take action. Example: 49.99",
  H6: "Closed List - Optional. ASIN is the Amazon Standard Identification Number. It is the unique 10-digit sequence of letters and/or numbers",
  I6: "Alphanumeric, 10 characters - Optional. Provide the ID for your “External Product ID Type”. Example: B002Z36VJE",
};

const MERGES = ["D2:D5", "F2:G2", "H2:I2", "H3:I3"];
const DATA_START_ROW = 7;

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
    const num = (v) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : null);
    out.push({ sku, min: num(row?.min), max: num(row?.max) });
  }
  return out;
}

// Returns an xlsx Buffer for the filled repricer file, or throws.
// `rows` is an array of { sku, min?, max? }.
async function buildRepricerBuffer(ExcelJS, rows, strategy) {
  const clean = cleanRows(rows);
  const strat = String(strategy ?? "").trim() || DEFAULT_STRATEGY;
  const wb = new ExcelJS.Workbook();

  const hidden = wb.addWorksheet("Hidden_repricer_bulk_upload");
  HIDDEN_ROWS.forEach((cells, i) => {
    const row = hidden.getRow(i + 1);
    cells.forEach((val, c) => { if (val != null) row.getCell(c + 1).value = val; });
  });
  hidden.state = "hidden";

  const ws = wb.addWorksheet("Repricer Bulk Upload");
  for (const [addr, val] of Object.entries(VISIBLE_HEADER)) ws.getCell(addr).value = val;
  MERGES.forEach((m) => ws.mergeCells(m));
  clean.forEach((row, i) => {
    const r = DATA_START_ROW + i;
    ws.getCell(`D${r}`).value = row.sku;              // SKU
    ws.getCell(`E${r}`).value = strat;                // Repricer Strategy
    if (row.min != null) ws.getCell(`F${r}`).value = row.min;  // Minimum Seller Allowed Price
    if (row.max != null) ws.getCell(`G${r}`).value = row.max;  // Maximum Seller Allowed Price
  });

  return wb.xlsx.writeBuffer();
}

module.exports = { buildRepricerBuffer, cleanRows, DEFAULT_STRATEGY, VERSION_LINE, DATA_START_ROW };
