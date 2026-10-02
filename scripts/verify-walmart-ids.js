#!/usr/bin/env node
/**
 * verify-walmart-ids.js
 *
 * Cross-checks every SKU / Item ID pair in a spreadsheet against your
 * Walmart Marketplace catalog, using the official Marketplace API.
 *
 * For each row it asks Walmart:
 *   1. "What Item ID does this SKU have?"        GET /v3/items/{sku}
 *   2. "Which SKU owns this Item ID?"            GET /v3/items/{itemId}?productIdType=ITEM_ID
 *      (only when step 1 can't confirm the pair)
 * and reports MATCH / MISMATCH / SKU_NOT_FOUND / ITEM_ID_NOT_FOUND, plus
 * whether the listing is actually live (publishedStatus / lifecycleStatus),
 * which is the usual reason a search on walmart.com comes up empty.
 *
 * Usage:
 *   node scripts/verify-walmart-ids.js <sheet.xlsx|sheet.csv> [options]
 *
 * Options:
 *   --client-id <id>         Walmart API Client ID      (or env WALMART_CLIENT_ID)
 *   --client-secret <secret> Walmart API Client Secret  (or env WALMART_CLIENT_SECRET)
 *   --out <file.xlsx|.csv>   Where to write the report  (default: <input>-verified.xlsx)
 *   --sheet <name>           Worksheet to read          (default: first sheet)
 *   --concurrency <n>        Parallel API calls         (default: 4)
 *   --dry-run                Parse the sheet and list the rows, no API calls
 *   --verbose                Log every API call
 *   --help
 *
 * Credentials are read from (first match wins): command-line flags,
 * environment variables, then a `.walmart-api.json` file in the project
 * root or your home directory:  { "clientId": "...", "clientSecret": "..." }
 * Get them from Seller Center → Settings → API Key Management
 * (https://developer.walmart.com/ → "My Account").
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const API_BASE = process.env.WALMART_API_BASE || 'https://marketplace.walmartapis.com';
const SVC_NAME = 'Walmart Marketplace';

// ---------------------------------------------------------------- CLI args

function parseArgs(argv) {
  const opts = { concurrency: 4, dryRun: false, verbose: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value after ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--client-id': opts.clientId = next(); break;
      case '--client-secret': opts.clientSecret = next(); break;
      case '--out': opts.out = next(); break;
      case '--sheet': opts.sheet = next(); break;
      case '--concurrency': opts.concurrency = Math.max(1, parseInt(next(), 10) || 4); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--verbose': case '-v': opts.verbose = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
        opts.positional.push(a);
    }
  }
  return opts;
}

function usage() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log(m ? m[1].replace(/^ \* ?/gm, '') : 'See script header for usage.');
}

// ------------------------------------------------------------- credentials

function loadCredentials(opts) {
  let clientId = opts.clientId || process.env.WALMART_CLIENT_ID;
  let clientSecret = opts.clientSecret || process.env.WALMART_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const candidates = [
      path.join(process.cwd(), '.walmart-api.json'),
      path.join(__dirname, '..', '.walmart-api.json'),
      path.join(os.homedir(), '.walmart-api.json'),
    ];
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        clientId = clientId || j.clientId || j.client_id;
        clientSecret = clientSecret || j.clientSecret || j.client_secret;
        if (clientId && clientSecret) break;
      } catch (e) {
        throw new Error(`Could not parse ${file}: ${e.message}`);
      }
    }
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      'Walmart API credentials not found.\n' +
      '  Pass --client-id / --client-secret, set WALMART_CLIENT_ID / WALMART_CLIENT_SECRET,\n' +
      '  or create .walmart-api.json: { "clientId": "...", "clientSecret": "..." }\n' +
      '  (Seller Center → Settings → API Key Management)'
    );
  }
  return { clientId, clientSecret };
}

// ------------------------------------------------------------ sheet input

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    if (v instanceof Date) return v.toISOString();
    return String(v).trim();
  }
  if (typeof v === 'number') {
    // Item IDs are up to ~11 digits; keep them as plain integers, never 1.8e10.
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  return String(v).trim();
}

function normHeader(s) {
  return cellText(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SKU_HEADERS = new Set(['sku', 'sellersku', 'skuid', 'partnersku']);
const ITEM_HEADERS = new Set(['itemid', 'walmartitemid', 'item', 'wmitemid', 'itemnumber']);

function pickColumns(headerRow) {
  let skuCol = -1, itemCol = -1;
  headerRow.forEach((h, idx) => {
    const n = normHeader(h);
    if (skuCol < 0 && SKU_HEADERS.has(n)) skuCol = idx;
    if (itemCol < 0 && ITEM_HEADERS.has(n)) itemCol = idx;
  });
  const hasHeader = skuCol >= 0 || itemCol >= 0;
  if (skuCol < 0) skuCol = 0;   // app convention: A = SKU
  if (itemCol < 0) itemCol = 1; // app convention: B = Item ID
  return { skuCol, itemCol, hasHeader };
}

function rowsFromMatrix(matrix) {
  if (!matrix.length) return [];
  const { skuCol, itemCol, hasHeader } = pickColumns(matrix[0]);
  const out = [];
  matrix.forEach((cells, i) => {
    if (i === 0 && hasHeader) return;
    const sku = cellText(cells[skuCol]);
    const itemId = cellText(cells[itemCol]).replace(/\.0+$/, '');
    if (!sku && !itemId) return;
    // Skip a header-looking first row even when its labels aren't recognised.
    if (i === 0 && !/^\d+$/.test(itemId) && /id/i.test(itemId)) return;
    out.push({ row: i + 1, sku, itemId });
  });
  return out;
}

async function readSheet(file, sheetName) {
  const ext = path.extname(file).toLowerCase();
  const wb = new ExcelJS.Workbook();
  let ws;
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    ws = await wb.csv.readFile(file, ext === '.tsv' ? { parserOptions: { delimiter: '\t' } } : undefined);
  } else {
    await wb.xlsx.readFile(file);
    ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
    if (!ws) throw new Error(`Worksheet "${sheetName}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`);
  }
  const matrix = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values.slice(1); // exceljs is 1-based
    matrix.push(vals.map((v) => v));
  });
  return rowsFromMatrix(matrix);
}

// --------------------------------------------------------------- API client

class WalmartClient {
  constructor({ clientId, clientSecret, verbose }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.verbose = verbose;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.calls = 0;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = (async () => {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const res = await fetch(`${API_BASE}/v3/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'WM_SVC.NAME': SVC_NAME,
          'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
        },
        body: 'grant_type=client_credentials',
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Token request failed (HTTP ${res.status}). Check your Client ID / Secret.\n${text.slice(0, 500)}`);
      }
      const j = JSON.parse(text);
      this.token = j.access_token;
      this.tokenExpiresAt = Date.now() + (Number(j.expires_in) || 900) * 1000;
      if (this.verbose) console.error(`[auth] token ok, expires in ${j.expires_in}s`);
      return this.token;
    })();
    try { return await this.tokenPromise; } finally { this.tokenPromise = null; }
  }

  /** GET an API path; returns { status, json }. Retries 429/5xx/network with backoff. */
  async get(pathname, attempt = 0) {
    const token = await this.getToken();
    this.calls++;
    let res, text;
    try {
      res = await fetch(`${API_BASE}${pathname}`, {
        headers: {
          Accept: 'application/json',
          'WM_SEC.ACCESS_TOKEN': token,
          'WM_SVC.NAME': SVC_NAME,
          'WM_QOS.CORRELATION_ID': crypto.randomUUID(),
        },
      });
      text = await res.text();
    } catch (e) {
      if (attempt < 4) { await sleep(1000 * 2 ** attempt); return this.get(pathname, attempt + 1); }
      throw e;
    }
    if (this.verbose) console.error(`[api] GET ${pathname} -> ${res.status}`);
    if (res.status === 401 && attempt < 1) { this.token = null; return this.get(pathname, attempt + 1); }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = res.status === 429 ? 5000 * (attempt + 1) : 1000 * 2 ** attempt;
      if (this.verbose) console.error(`[api] ${res.status}, retrying in ${wait}ms`);
      await sleep(wait);
      return this.get(pathname, attempt + 1);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, json };
  }

  /** Look up one item. Returns the ItemResponse object, null if not found, or throws. */
  async getItem(id, productIdType) {
    const q = productIdType ? `?productIdType=${encodeURIComponent(productIdType)}` : '';
    const { status, json } = await this.get(`/v3/items/${encodeURIComponent(id)}${q}`);
    if (status === 404) return null;
    if (status !== 200) {
      const msg = extractError(json) || `HTTP ${status}`;
      // Walmart returns 400 "item not found" style errors for some bad ids.
      if (/not\s*found|does not exist|no item|invalid item/i.test(msg)) return null;
      throw new Error(msg);
    }
    const items = json && (json.ItemResponse || json.itemResponse || json.items || []);
    if (Array.isArray(items)) return items[0] || null;
    return items || null;
  }
}

function extractError(json) {
  if (!json) return '';
  const errs = json.errors || (json.error && (Array.isArray(json.error) ? json.error : [json.error])) || json.ErrorList;
  if (Array.isArray(errs) && errs.length) {
    return errs.map((e) => (typeof e === 'string' ? e : [e.code, e.description || e.message || e.info].filter(Boolean).join(': '))).join('; ');
  }
  if (json.raw) return String(json.raw).slice(0, 300);
  return '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- checking

const S = {
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  SKU_NOT_FOUND: 'SKU_NOT_FOUND',
  ITEM_ID_NOT_FOUND: 'ITEM_ID_NOT_FOUND',
  BOTH_NOT_FOUND: 'BOTH_NOT_FOUND',
  MISSING_INPUT: 'MISSING_INPUT',
  ERROR: 'ERROR',
};

function liveNote(item) {
  if (!item) return '';
  const pub = item.publishedStatus || '';
  const life = item.lifecycleStatus || '';
  const notes = [];
  if (life && life !== 'ACTIVE') notes.push(`lifecycle ${life}`);
  if (pub && pub !== 'PUBLISHED') notes.push(`${pub.toLowerCase().replace(/_/g, ' ')}`);
  if (Array.isArray(item.unpublishedReasons?.reason) && item.unpublishedReasons.reason.length) {
    notes.push(item.unpublishedReasons.reason.join(' | '));
  } else if (Array.isArray(item.unpublishedReasons) && item.unpublishedReasons.length) {
    notes.push(item.unpublishedReasons.join(' | '));
  }
  return notes.length ? `Not live on walmart.com: ${notes.join('; ')}` : '';
}

async function checkRow(client, r) {
  const result = {
    row: r.row, sku: r.sku, itemId: r.itemId,
    walmartItemId: '', skuForItemId: '', published: '', lifecycle: '', productName: '',
    status: '', note: '',
  };
  if (!r.sku || !r.itemId) {
    result.status = S.MISSING_INPUT;
    result.note = !r.sku ? 'SKU cell is empty' : 'Item ID cell is empty';
    return result;
  }

  try {
    const bySku = await client.getItem(r.sku, 'SKU');
    if (bySku) {
      result.walmartItemId = cellText(bySku.itemId);
      result.published = bySku.publishedStatus || '';
      result.lifecycle = bySku.lifecycleStatus || '';
      result.productName = bySku.productName || '';
    }

    const skuMatches = bySku && result.walmartItemId && result.walmartItemId === r.itemId;
    let byItem = null;
    if (!skuMatches) {
      byItem = await client.getItem(r.itemId, 'ITEM_ID');
      if (byItem) result.skuForItemId = byItem.sku || '';
    }

    if (skuMatches) {
      result.status = S.MATCH;
    } else if (bySku && byItem) {
      if ((byItem.sku || '').toLowerCase() === r.sku.toLowerCase()) {
        // Same item reached both ways; Walmart just didn't echo itemId on the SKU lookup.
        result.status = S.MATCH;
        result.walmartItemId = result.walmartItemId || cellText(byItem.itemId) || r.itemId;
        if (!result.published) { result.published = byItem.publishedStatus || ''; result.lifecycle = byItem.lifecycleStatus || ''; result.productName = byItem.productName || ''; }
      } else {
        result.status = S.MISMATCH;
        result.note = `SKU "${r.sku}" is Item ID ${result.walmartItemId || '?'}; Item ID ${r.itemId} belongs to SKU "${byItem.sku}"`;
      }
    } else if (bySku && !byItem) {
      result.status = S.ITEM_ID_NOT_FOUND;
      result.note = result.walmartItemId
        ? `SKU exists but its Item ID is ${result.walmartItemId}; Item ID ${r.itemId} is not in your catalog`
        : `SKU exists; Item ID ${r.itemId} is not in your catalog`;
    } else if (!bySku && byItem) {
      result.status = S.SKU_NOT_FOUND;
      result.published = byItem.publishedStatus || '';
      result.lifecycle = byItem.lifecycleStatus || '';
      result.productName = byItem.productName || '';
      result.note = `SKU "${r.sku}" not in your catalog; Item ID ${r.itemId} belongs to SKU "${byItem.sku}"`;
    } else {
      result.status = S.BOTH_NOT_FOUND;
      result.note = 'Neither the SKU nor the Item ID exists in your Walmart catalog';
    }

    const live = liveNote(bySku || byItem);
    if (live) result.note = result.note ? `${result.note}. ${live}` : live;
  } catch (e) {
    result.status = S.ERROR;
    result.note = e.message;
  }
  return result;
}

async function runPool(items, concurrency, fn, onDone) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      onDone && onDone(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ----------------------------------------------------------------- output

const COLUMNS = [
  ['row', 'Sheet Row', 10],
  ['sku', 'SKU', 28],
  ['itemId', 'Item ID (sheet)', 16],
  ['walmartItemId', 'Item ID (Walmart, for this SKU)', 20],
  ['skuForItemId', 'SKU (Walmart, for this Item ID)', 28],
  ['status', 'Status', 18],
  ['published', 'Published Status', 18],
  ['lifecycle', 'Lifecycle', 12],
  ['productName', 'Product Name (Walmart)', 50],
  ['note', 'Note', 80],
];

async function writeReport(results, outFile) {
  const ext = path.extname(outFile).toLowerCase();
  if (ext === '.csv') {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [COLUMNS.map((c) => esc(c[1])).join(',')];
    for (const r of results) lines.push(COLUMNS.map((c) => esc(r[c[0]])).join(','));
    fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
    return;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Verification');
  ws.columns = COLUMNS.map(([key, header, width]) => ({ key, header, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const fills = {
    [S.MATCH]: 'FFD9EAD3',
    [S.MISMATCH]: 'FFF4CCCC',
    [S.SKU_NOT_FOUND]: 'FFF4CCCC',
    [S.ITEM_ID_NOT_FOUND]: 'FFF4CCCC',
    [S.BOTH_NOT_FOUND]: 'FFF4CCCC',
    [S.MISSING_INPUT]: 'FFFFF2CC',
    [S.ERROR]: 'FFFFF2CC',
  };
  for (const r of results) {
    const row = ws.addRow(r);
    const fill = fills[r.status];
    if (fill) row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    if (r.status === S.MATCH && /Not live/.test(r.note)) {
      row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    }
    // Keep Item IDs as text so Excel doesn't turn them into 1.8E+10.
    for (const k of ['itemId', 'walmartItemId']) row.getCell(k).numFmt = '@';
  }
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + COLUMNS.length)}1` };
  await wb.xlsx.writeFile(outFile);
}

function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// ------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.positional.length) { usage(); process.exit(opts.help ? 0 : 1); }

  const input = path.resolve(opts.positional[0]);
  if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);

  const rows = await readSheet(input, opts.sheet);
  if (!rows.length) throw new Error('No SKU / Item ID rows found. Expected a "SKU" column and an "Item ID" column (or SKU in column A, Item ID in column B).');
  console.log(`Read ${rows.length} rows from ${path.basename(input)}`);

  if (opts.dryRun) {
    console.log('\nDry run - rows that would be checked:\n');
    console.log(pad('Row', 5), pad('SKU', 30), 'Item ID');
    for (const r of rows) console.log(pad(r.row, 5), pad(r.sku, 30), r.itemId);
    const dupSku = findDupes(rows.map((r) => r.sku.toLowerCase()));
    const dupItem = findDupes(rows.map((r) => r.itemId));
    if (dupSku.length) console.log(`\nDuplicate SKUs in sheet: ${dupSku.join(', ')}`);
    if (dupItem.length) console.log(`Duplicate Item IDs in sheet: ${dupItem.join(', ')}`);
    const badIds = rows.filter((r) => r.itemId && !/^\d{6,15}$/.test(r.itemId));
    if (badIds.length) console.log(`Item IDs that don't look like Walmart item numbers: ${badIds.map((r) => `${r.itemId} (row ${r.row})`).join(', ')}`);
    return;
  }

  const creds = loadCredentials(opts);
  const client = new WalmartClient({ ...creds, verbose: opts.verbose });
  await client.getToken(); // fail fast on bad credentials

  console.log(`Checking against Walmart Marketplace API (${opts.concurrency} at a time)...\n`);
  let done = 0;
  const results = await runPool(rows, opts.concurrency, (r) => checkRow(client, r), (res) => {
    done++;
    const flag = res.status === S.MATCH ? (/Not live/.test(res.note) ? '~' : ' ') : '!';
    console.log(`${flag} [${pad(done, 3)}/${rows.length}] ${pad(res.sku, 30)} ${pad(res.itemId, 13)} ${pad(res.status, 18)} ${res.note}`);
  });

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const notLive = results.filter((r) => r.status === S.MATCH && /Not live/.test(r.note)).length;

  console.log('\nSummary');
  console.log('-------');
  for (const k of Object.values(S)) if (counts[k]) console.log(`${pad(k, 20)} ${counts[k]}`);
  if (notLive) console.log(`${pad('(match, not live)', 20)} ${notLive}`);
  console.log(`${pad('API calls', 20)} ${client.calls}`);

  const outFile = opts.out
    ? path.resolve(opts.out)
    : path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-verified.xlsx`);
  await writeReport(results, outFile);
  console.log(`\nReport written to ${outFile}`);

  const problems = results.filter((r) => r.status !== S.MATCH).length;
  process.exitCode = problems ? 2 : 0;
}

function findDupes(list) {
  const seen = new Set(), dup = new Set();
  for (const v of list) { if (!v) continue; if (seen.has(v)) dup.add(v); seen.add(v); }
  return [...dup];
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
