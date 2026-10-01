<div align="center">
  <img src="build/icon.png" width="96" alt="Walmart Listing Browser icon" />
  <h1>Walmart Listing Browser</h1>
  <p><b>Spreadsheet-style incentive price list with live Walmart listing browsing.</b></p>
  <p><b>⬇ Download the latest installer:</b> <a href="../../releases/latest"><b>macOS (.dmg)</b></a> · <a href="../../releases/latest"><b>Windows (.exe)</b></a></p>
</div>

![Walmart Listing Browser](docs/screenshot.png)

Keep an incentive price sheet on the left, and click any row to see its **live walmart.com listing** docked on the right — no tab-juggling between a spreadsheet and a browser.

## Features

- **Spreadsheet UI** — editable cells, formulas (`=D2-C2`), always-on search bar (Ctrl+F), sortable columns, drag-to-reorder rows, custom columns.
- **Live listing pane** — the real walmart.com product page for the selected row, docked beside the sheet, with zoom and prev/next navigation.
- **Buy-box suggestion** — after a listing loads, Walmart's current price appears as a ghost value in the selected row's During Incentive cell (with a % Change preview while the row is blank, or as a small tag next to an existing price). Press Enter on that cell or click the tag to use it; it's then an ordinary value you can still edit. This keeps working with the pane closed: the listing loads off-screen and the cell shows a spinner while it reads. Hover a During cell that has a buy box for a card with the price, when it was read, the cheapest sellers (your own store marked YOU once you name it), your During vs the buy box, and a Use button.
- **Scan buy boxes** — one toolbar button walks every listing through the off-screen Walmart view (one at a time, images and media skipped, a third of a second apart), remembers each buy box on its row, and shows suggestions on every row. Rows read in the last 24 h are skipped, so a scan after a restart only visits what's missing or stale (Shift+click to re-read everything). Click again to stop; the button then offers **Resume** (continue where it left off) with a **Start over** beside it. **Apply N suggestions** then writes all pending During / Before values in one undoable step, so you approve first and check after.
- **Before-price suggestion** — when a row has a During price but no Before, the Before cell ghosts the smallest .99 price at least 4.1% above it (Walmart needs ≥4% off for the commission break); Enter accepts. Existing Before values are never changed, but any row under 4% gets an amber % Change cell.
- **Closable pane** — the × in the pane header closes the right side so the sheet takes the full window; "Show listing pane" in the toolbar brings it back (remembered between launches).
- **Walmart Listing ⇄ Seller Center toggle** — flip the pane between the customer-facing listing and a free-browsing Seller Center session (sign in once; loads once; row clicks never disturb it).
- **Row auto-jump** — browse to another listing or variant inside the pane and the sheet selects that row automatically.
- **Import** — pull rows in from `.xlsx` / `.csv` / `.tsv`, or paste straight from Google Sheets with Ctrl+V; optional per-row commission columns are picked up by header name.
- **Auto-update** — the app checks the latest GitHub Release on launch (and every few hours). Windows downloads and installs the new version in-app; macOS shows a Download button for the new `.dmg` (unsigned builds can't replace themselves). Click the version tag next to the title to check by hand.
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

The branded NSIS installer lands in `dist/Walmart-Listing-Browser-Setup-<version>.exe`.

### Build the macOS app

Run this **on a Mac** (a `.dmg` can only be built on macOS):

```bash
npm install
npm run dist:mac
```

The disk image lands in `dist/Walmart-Listing-Browser-<version>-universal.dmg`. Open it and
drag the app into **Applications** — from then on it's a normal double-click app.
It isn't code-signed, so the first launch shows an "unidentified developer"
warning: right-click the app → **Open** → **Open**, and macOS remembers it.

## Import format

The first four columns of your sheet, in this order (a header row is fine — it's skipped):

| A | B | C | D |
|---|---|---|---|
| SKU | Item ID | Before Price | During Incentive |

Only SKU is required — Item ID and prices can be left blank. Extra columns (`$ Change`, `% Change`, …) are ignored on import and recomputed in-app.

Need a starting point? The import dialog has a **Download a blank template** link that saves an `.xlsx` with these headers and an example row.

Optionally add `Regular Commission` and `During Incentive Commission` columns (any position — they're matched by header name). Rows without them default to 6% / 2%; the values fill the commission rates in the "For Walmart rep" export.

## Tech notes

- Electron 33, plain HTML/CSS/JS renderer (no framework).
- The listing pane is a `WebContentsView` — walmart.com refuses to render into a `<webview>`, so a window-grade view is docked over the layout instead.
- `exceljs` powers `.xlsx` import/export.
- Icon assets live in [`build/`](build/) — `icon.svg` is the master; `icon.png` / `icon.ico` are rasterized from it.

---

<div align="center"><sub>© 2026 Imran Tursun · Internal tool — not affiliated with or endorsed by Walmart Inc.</sub></div>
