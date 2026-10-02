<div align="center">
  <img src="build/icon.png" width="96" alt="Walmart Listing Browser icon" />
  <h1>Walmart Listing Browser</h1>
  <p><b>Spreadsheet-style incentive price list with live Walmart listing browsing.</b></p>
  <p><b>⬇ Download the latest installer:</b> <a href="../../releases/latest"><b>macOS (.dmg)</b></a> · <a href="../../releases/latest"><b>Windows (.exe)</b></a></p>
</div>

![Walmart Listing Browser](docs/screenshot.png)

Keep an incentive price sheet on the left, and click any row to see its **live walmart.com listing** docked on the right — no tab-juggling between a spreadsheet and a browser.

## Features

- **Spreadsheet UI** — editable cells, formula bar, formulas (`=D2-C2`), Ctrl+F find, sortable columns, drag-to-reorder rows, custom columns.
- **Live listing pane** — the real walmart.com product page for the selected row, docked beside the sheet, with zoom and prev/next navigation.
- **Walmart Listing ⇄ Seller Center toggle** — flip the pane between the customer-facing listing and a free-browsing Seller Center session (sign in once; loads once; row clicks never disturb it).
- **Row auto-jump** — browse to another listing or variant inside the pane and the sheet selects that row automatically.
- **Import** — pull rows in from `.xlsx` / `.csv` / `.tsv`, or paste straight from Google Sheets with Ctrl+V; optional per-row commission columns are picked up by header name.
- **Export** — the regular sheet (live formulas), or the 11-column incentive template the Walmart rep uploads, prefilled with partner details and per-row commission rates.
- **Auto-computed columns** — `$ Change` and `% Change` recompute from Before / During prices.
- **Local-first** — everything is stored in a local JSON file; no accounts, no server.

## Getting started

```bash
npm install
npm start
```

### Build the Windows installer

```bash
npm run dist
```

The branded NSIS installer lands in `dist/Walmart Listing Browser Setup <version>.exe`.

### Build the macOS app

Run this **on a Mac** (a `.dmg` can only be built on macOS):

```bash
npm install
npm run dist:mac
```

The disk image lands in `dist/Walmart Listing Browser-<version>.dmg`. Open it and
drag the app into **Applications** — from then on it's a normal double-click app.
It isn't code-signed, so the first launch shows an "unidentified developer"
warning: right-click the app → **Open** → **Open**, and macOS remembers it.

## Import format

The first four columns of your sheet, in this order (a header row is fine — it's skipped):

| A | B | C | D |
|---|---|---|---|
| SKU | Item ID | Before Price | During Incentive |

Only SKU and Item ID are required; extra columns (`$ Change`, `% Change`, …) are ignored on import and recomputed in-app.

Optionally add `Regular Commission` and `During Incentive Commission` columns (any position — they're matched by header name). Rows without them default to 6% / 2%; the values fill the commission rates in the "For Walmart rep" export.

## Verify SKU ⇄ Item ID pairs against Walmart (command line)

A listing that "never shows up" when you search walmart.com is usually one of
three things: the SKU and Item ID in the sheet don't belong to each other, one
of them isn't in your catalog at all, or the item exists but isn't live
(unpublished / retired). `npm run verify` checks every row of a sheet against
your own Walmart catalog through the official **Marketplace API** and tells you
which it is.

**One-time setup**

1. In Seller Center go to **Settings → API Key Management** (or
   [developer.walmart.com → My Account](https://developer.walmart.com/)) and
   create / copy a **Client ID** and **Client Secret** with read access to Items.
2. Save them in a file named `.walmart-api.json` in this project folder (it's
   git-ignored, so it never gets committed):

   ```json
   { "clientId": "YOUR-CLIENT-ID", "clientSecret": "YOUR-CLIENT-SECRET" }
   ```

   Alternatively pass `--client-id` / `--client-secret` on the command line, or
   set the `WALMART_CLIENT_ID` / `WALMART_CLIENT_SECRET` environment variables.

**Run it** (Windows Command Prompt or PowerShell, macOS Terminal — same command):

```bash
npm run verify -- "C:\path\to\incentive-list.xlsx"
```

Any `.xlsx` or `.csv` works, including the app's own exports: it looks for a
`SKU` column and an `Item ID` column by header, falling back to columns A and B.
Add `--dry-run` to just list the rows it would check without calling the API.

Each row prints as it's checked, then a summary, and a colour-coded report is
written next to the input as `<name>-verified.xlsx` (`--out report.csv` for CSV):

| Status | Meaning |
|---|---|
| `MATCH` | Walmart agrees: that SKU is that Item ID. If the note says *Not live on walmart.com*, the pair is right but the listing is unpublished / retired — that's why searching finds nothing. |
| `MISMATCH` | Both exist in your catalog but belong to different items. The note gives the SKU's real Item ID and the Item ID's real SKU so you can fix the sheet. |
| `SKU_NOT_FOUND` | The SKU isn't in your catalog; the note says which SKU the Item ID actually belongs to. |
| `ITEM_ID_NOT_FOUND` | The SKU exists, but that Item ID isn't in your catalog; the note gives the SKU's real Item ID. |
| `BOTH_NOT_FOUND` | Neither identifier is in your Walmart catalog. |
| `MISSING_INPUT` / `ERROR` | Empty cell, or the API returned an error for that row (see note). |

The exit code is `0` when every row matches and `2` otherwise, so it can gate a
batch script. Rate limits and token expiry are handled automatically; a
165-row sheet takes roughly a minute.

## Tech notes

- Electron 33, plain HTML/CSS/JS renderer (no framework).
- The listing pane is a `WebContentsView` — walmart.com refuses to render into a `<webview>`, so a window-grade view is docked over the layout instead.
- `exceljs` powers `.xlsx` import/export.
- Icon assets live in [`build/`](build/) — `icon.svg` is the master; `icon.png` / `icon.ico` are rasterized from it.

---

<div align="center"><sub>© 2026 Imran Tursun · Internal tool — not affiliated with or endorsed by Walmart Inc.</sub></div>
