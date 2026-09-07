// Walmart "Repricer Bulk Upload" file builder (spec v1.1).
//
// Fills the official Seller Center template shipped at
// templates/repricer-template.xlsx by editing the .xlsx zip in place. Rows 1-6,
// the hidden attribute sheet, the workbook defined names, and the data
// validations are all left untouched; only data rows (7+) are added, written
// exactly the way Excel writes them — text via the shared-strings table with the
// column's style index, numbers with the numeric column style. Matching Excel's
// output is what Seller Center's validator requires (inline strings / unstyled
// cells were rejected with "missing attribute metadata").
//
// Columns: D = SKU, E = Repricer Strategy, F = Minimum, G = Maximum Seller
// Allowed Price. Data begins at row 7.

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

// Default strategy assigned to every product unless a caller overrides it.
// Must match the name on the Repricer page in Seller Center exactly.
const DEFAULT_STRATEGY = "IMRAN BUY BOX";

const SHEET_NAME = "Repricer Bulk Upload";
const DATA_START_ROW = 7;
const FALLBACK_SHEET_PATH = "xl/worksheets/sheet2.xml";
const SHARED_STRINGS_PATH = "xl/sharedStrings.xml";
const TEMPLATE_PATH = path.join(__dirname, "templates", "repricer-template.xlsx");

// Style indexes used by the template's data columns (from its <cols>): D and E
// use cellXf 1, F and G use cellXf 2.
const STYLE_TEXT = 1;
const STYLE_NUM = 2;

// Normalize incoming rows to { sku, min, max }, deduplicating by SKU (keep
// first occurrence) and dropping blanks — the repricer is keyed on SKU. min/max
// are optional numbers; a missing or invalid one is left blank.
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
  const sheetEntry = zip.file(sheetPath);
  const sstEntry = zip.file(SHARED_STRINGS_PATH);
  if (!sheetEntry || !sstEntry) throw new Error("Template is missing a required part.");

  if (clean.length) {
    // 1) Add our text values to the shared-strings table, interning duplicates.
    let sst = await sstEntry.async("string");
    const head = /<sst[^>]*\bcount="(\d+)"[^>]*\buniqueCount="(\d+)"/.exec(sst);
    let count = head ? parseInt(head[1], 10) : 0;
    let unique = head ? parseInt(head[2], 10) : 0;
    const map = new Map();
    const added = [];
    const intern = (s) => {
      if (!map.has(s)) { map.set(s, unique + added.length); added.push(s); }
      return map.get(s);
    };
    const stratIdx = intern(strat);
    const skuIdx = clean.map((row) => intern(row.sku));
    const newSi = added.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("");
    sst = sst.replace("</sst>", newSi + "</sst>");
    // count = total string-cell references (2 per row: SKU + strategy);
    // uniqueCount = number of <si> entries.
    sst = sst
      .replace(/(<sst[^>]*\bcount=")\d+(")/, `$1${count + clean.length * 2}$2`)
      .replace(/(<sst[^>]*\buniqueCount=")\d+(")/, `$1${unique + added.length}$2`);
    zip.file(SHARED_STRINGS_PATH, sst);

    // 2) Add the data rows to the worksheet, referencing those shared strings.
    let xml = await sheetEntry.async("string");
    const rowsXml = clean.map((row, i) => {
      const r = DATA_START_ROW + i;
      const cells = [
        `<c r="D${r}" s="${STYLE_TEXT}" t="s"><v>${skuIdx[i]}</v></c>`,
        `<c r="E${r}" s="${STYLE_TEXT}" t="s"><v>${stratIdx}</v></c>`,
      ];
      if (row.min != null) cells.push(`<c r="F${r}" s="${STYLE_NUM}"><v>${row.min}</v></c>`);
      if (row.max != null) cells.push(`<c r="G${r}" s="${STYLE_NUM}"><v>${row.max}</v></c>`);
      return `<row r="${r}" spans="1:9">${cells.join("")}</row>`;
    }).join("");
    xml = xml.replace("</sheetData>", rowsXml + "</sheetData>");
    const lastRow = DATA_START_ROW + clean.length - 1;
    xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:I${lastRow}"/>`);
    zip.file(sheetPath, xml);
  }

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

module.exports = { buildRepricerBuffer, cleanRows, DEFAULT_STRATEGY, DATA_START_ROW, TEMPLATE_PATH };
