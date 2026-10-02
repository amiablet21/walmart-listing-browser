// Account Manager "Item & Partner Level Comm Break" file builder.
//
// Fills the Account Manager's own template (templates/incentive-template.xlsx)
// so the export opens exactly like the sheet they sent: same two worksheets
// ("Item & Partner Level Comm Break" + "Condition Codes"), headers, column
// widths, fonts, number formats and frozen header row. Only the data rows are
// replaced; the template's placeholder rows (an instruction note and sample
// dates) are removed.
//
// Columns (sheet 1):
//   A Marketplace Country   B Base ID            C Item ID
//   D Item Condition Code   E Partner ID         F Regular Commission Rate
//   G Avg. Units Sold Before Incentive (90d)     H Avg. Price Before Incentive (90d)
//   I Incentive Start Date  J Incentive End Date K Incentive Commission Rate
//   L Expected Unit Sales During Incentive       M Price During Incentive
// Only what the app knows is written: country, Item ID, condition code,
// partner ID, both commission rates, both prices, and the incentive dates.
// Base ID and the two unit-sales columns are left blank for the Account Manager.

const fs = require("fs");
const path = require("path");

const TEMPLATE_PATH = path.join(__dirname, "templates", "incentive-template.xlsx");
const SHEET_NAME = "Item & Partner Level Comm Break";
const MARKETPLACE_COUNTRY = "US";
const COLS = 13;

// Partner ID the Account Manager uses for this seller account.
const DEFAULT_PARTNER_ID = "10001467995";
// Item Condition Code 1 = "New" (see the template's Condition Codes sheet).
const DEFAULT_CONDITION_CODE = 1;

// Keep rows that carry an Item ID, deduplicated on Item ID (first wins).
function cleanRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const itemId = String(row?.itemId ?? "").trim();
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    const num = (v) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    out.push({
      itemId,
      regCom: num(row?.regCom),
      incCom: num(row?.incCom),
      before: num(row?.before),
      during: num(row?.during),
    });
  }
  return out;
}

// "2026-05-01" → Date (UTC, so Excel shows the calendar day as typed);
// endOfDay puts it at 23:59:59 like the template's sample end dates.
function parseDate(s, endOfDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const d = endOfDay
    ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59))
    : new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Item IDs and Partner IDs are digit strings; store them as numbers so Excel
// right-aligns them like the Account Manager's sheet (they fit well within
// Excel's 15 significant digits).
const idCell = (s) => (/^\d{1,15}$/.test(s) ? Number(s) : s);

// Returns an xlsx Buffer for the filled template, or throws.
// rows: [{ itemId, regCom, incCom, before, during }]
// opts: { partnerId, conditionCode, startDate ("YYYY-MM-DD"), endDate, templatePath }
async function buildIncentiveBuffer(rows, opts = {}) {
  const ExcelJS = require("exceljs");
  const clean = cleanRows(rows);
  const partnerId = String(opts.partnerId ?? "").trim() || DEFAULT_PARTNER_ID;
  const condRaw = Number(opts.conditionCode);
  const conditionCode = Number.isInteger(condRaw) && condRaw >= 1 && condRaw <= 13 ? condRaw : DEFAULT_CONDITION_CODE;
  const startDate = parseDate(opts.startDate);
  const endDate = parseDate(opts.endDate, true);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(opts.templatePath || TEMPLATE_PATH);
  const ws = wb.getWorksheet(SHEET_NAME) || wb.worksheets[0];
  if (!ws) throw new Error("Template is missing the incentive worksheet.");

  // Per-column data-row style, taken from the template's first plain
  // placeholder row (row 3: no note text, just the sample dates).
  const styleRow = ws.getRow(3);
  const styles = [];
  for (let c = 1; c <= COLS; c++) styles.push(JSON.parse(JSON.stringify(styleRow.getCell(c).style || {})));

  // Drop every placeholder row below the header. (spliceRows is a no-op on
  // rows that only carry styles and dates, so trim the row array directly and
  // fall back to blanking the cells if that internal ever changes.)
  if (Array.isArray(ws._rows)) ws._rows.splice(1);
  else for (let r = ws.rowCount; r >= 2; r--) ws.getRow(r).eachCell({ includeEmpty: true }, (c) => { c.value = null; });

  clean.forEach((row, i) => {
    const r = ws.getRow(i + 2);
    const values = [
      MARKETPLACE_COUNTRY,        // A Marketplace Country
      null,                       // B Base ID
      idCell(row.itemId),         // C Item ID
      conditionCode,              // D Item Condition Code
      idCell(partnerId),          // E Partner ID
      row.regCom,                 // F Regular Commission Rate
      null,                       // G Avg. Units Sold Before Incentive
      row.before,                 // H Avg. Price Before Incentive
      startDate,                  // I Incentive Start Date
      endDate,                    // J Incentive End Date
      row.incCom,                 // K Incentive Commission Rate
      null,                       // L Expected Unit Sales During Incentive
      row.during,                 // M Price During Incentive
    ];
    values.forEach((v, c) => {
      const cell = r.getCell(c + 1);
      cell.style = JSON.parse(JSON.stringify(styles[c]));
      if (v != null) cell.value = v;
    });
    // Rates show two decimals like the Account Manager's sheet (6.00 / 3.00).
    r.getCell(6).numFmt = "0.00";
    r.getCell(11).numFmt = "0.00";
    r.commit();
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildIncentiveBuffer, cleanRows, DEFAULT_PARTNER_ID, DEFAULT_CONDITION_CODE, SHEET_NAME, TEMPLATE_PATH };
