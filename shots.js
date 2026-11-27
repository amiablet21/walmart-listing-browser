// Screenshots of a listing's seller list, taken in the off-screen worker view.
//
//   kind "panel"  — the "Compare all sellers" panel, open on the listing
//   kind "page"   — Walmart's all-sellers page (/product/<id>/sellers)
//   kind "buybox" — the listing's buy box (one seller, or out of stock)
//
// A list longer than the view is captured in one piece by making the page's
// viewport as tall as the list (a device-metrics override: the off-screen
// view itself can't be resized, it always takes the window's size). When that
// isn't possible the list is scrolled and the slices are stitched together.
// Nothing here changes the page beyond scrolling it.
const { nativeImage } = require("electron");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_HEIGHT = 12000; // px of page height one screenshot may cover

// Finds what to capture and marks the scrolling element (data-wlb-scroll) so
// the scroll steps can find it again. Returns sizes in CSS pixels:
//   { rect: {x,y,w,h}, scroll: {x,y,w,h, scrollH, clientH} | null, vw, vh, win }
// `win` means the page itself scrolls (the all-sellers page).
const GEOM_SCRIPT = (kind) => `(() => {
  const kind = ${JSON.stringify(kind)};
  const vw = window.innerWidth, vh = window.innerHeight;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  document.querySelectorAll("[data-wlb-scroll]").forEach((e) => e.removeAttribute("data-wlb-scroll"));
  if (kind === "page") {
    const docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    return { rect: { x: 0, y: 0, w: vw, h: Math.min(docH, vh) }, scroll: { x: 0, y: 0, w: vw, h: vh, scrollH: docH, clientH: vh }, vw, vh, win: true };
  }
  if (kind === "panel") {
    let root = document.querySelector("[data-wlb-panel]")
      || [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="seller" i][class*="panel" i], [data-testid*="allSellers" i], aside[class*="seller" i]')]
        .find((el) => el.getClientRects().length && /Sold (?:and|&) shipped by|Sold by/i.test(el.innerText || ""));
    if (!root) return null;
    // The dialog can be a wrapper as large as the window (its dimmed backdrop
    // included): step down to the panel itself, the part that holds every seller.
    const sold = /Sold (?:and|&) shipped by|Sold by/gi;
    const count = (el) => ((el.innerText || "").match(sold) || []).length;
    const total = count(root);
    for (let i = 0; i < 10 && root.getBoundingClientRect().width > vw * 0.7; i++) {
      const kid = [...root.children].find((c) => c.getClientRects().length && count(c) === total);
      if (!kid) break;
      root = kid;
    }
    let best = null;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.scrollHeight - el.clientHeight < 4 || el.clientHeight < 60) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    if (best) { best.setAttribute("data-wlb-scroll", "1"); best.scrollTo({ top: 0, behavior: "instant" }); }
    return { rect: box(root), scroll: best ? { ...box(best), scrollH: best.scrollHeight, clientH: best.clientHeight } : null, vw, vh, win: false };
  }
  // buy box: the listing's right-hand column — price, Add to cart, "Sold and
  // shipped by". Found by walking up from something that is always in it to
  // the widest ancestor that is still one column wide. (The element Walmart
  // labels as the add-to-cart section is only the button's strip, which is how
  // the first live pictures came out 80 px tall.) The page was put back at its
  // top, inner scrolling included, and left to settle before this runs.
  const band = Math.max(640, vw * 0.36);
  const vis = (e) => !!e && e.getClientRects().length > 0;
  const anchors = [
    document.querySelector('[data-testid="add-to-cart-section"]'),
    [...document.querySelectorAll("button")].find((b) => vis(b) && /^add to cart$/i.test((b.textContent || "").trim()) && b.getBoundingClientRect().left > vw * 0.4),
    document.querySelector('[itemprop="price"]'), document.querySelector('span[data-seo-id="hero-price"]'), document.querySelector('[data-testid="price-wrap"]'),
    [...document.querySelectorAll("span, div, p")].find((e) => vis(e) && e.children.length <= 2 && /^Sold (?:and|&) shipped by/i.test((e.textContent || "").trim())),
  ].filter(vis);
  let col = null;
  for (const a of anchors) {
    for (let e = a; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      const w = e.getBoundingClientRect().width;
      if (w > band) break;
      if (w >= 260) col = e;
    }
    if (col) break;
  }
  const whole = { rect: { x: 0, y: 0, w: vw, h: vh }, scroll: null, vw, vh, win: false, whole: true }; // no column found: the top of the page
  if (!col) return whole;
  const r = box(col);
  if (r.h < 120 || r.y + r.h <= 0) return whole;
  // a column with its own scrolling is captured like the sellers panel
  let inner = null;
  for (const el of [col, ...col.querySelectorAll("*")]) {
    if (el.scrollHeight - el.clientHeight < 4 || el.clientHeight < 120) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
    if (!inner || el.scrollHeight > inner.scrollHeight) inner = el;
  }
  if (inner) { inner.setAttribute("data-wlb-scroll", "1"); return { rect: r, scroll: { ...box(inner), scrollH: Math.min(inner.scrollHeight, 2400), clientH: inner.clientHeight }, vw, vh, win: false }; }
  // The column's box can run far below what is in it, and sponsored cards
  // follow the buy box: end the picture a little below the seller line (or,
  // without one, at the last thing actually drawn in the column).
  let bottom = r.y;
  for (const e of col.querySelectorAll("button, a, span, p, img, svg, input, label, h1, h2, h3, li")) {
    const b = e.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && b.bottom > bottom) bottom = b.bottom;
  }
  const soldEl = [...col.querySelectorAll("span, div, p")].find((e) => vis(e) && e.children.length <= 3 && /^Sold (?:(?:and|&) shipped )?by/i.test((e.textContent || "").trim()));
  if (soldEl) bottom = Math.min(bottom, soldEl.getBoundingClientRect().bottom + 190);
  bottom = Math.min(bottom + 12, r.y + r.h + 8);
  const top = Math.max(0, r.y - 8);
  return { rect: { x: Math.max(0, r.x - 8), y: top, w: r.w + 16, h: Math.max(120, Math.min(bottom, top + 2400) - top) }, scroll: null, vw, vh, win: false };
})()`;
const SCROLL_SCRIPT = (y, win) => `(() => {
  if (${win ? "true" : "false"}) { window.scrollTo({ top: ${y}, left: 0, behavior: "instant" }); return window.scrollY; }
  const el = document.querySelector("[data-wlb-scroll]"); if (!el) return -1;
  el.scrollTo({ top: ${y}, behavior: "instant" }); return el.scrollTop;
})()`;

const run = (v, js) => v.webContents.executeJavaScript(js, true).catch(() => null);

// A view-space rectangle, whole pixels, kept inside the viewport.
function clip(r, vw, vh) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const w = Math.min(vw, Math.ceil(r.x + r.w)) - x, h = Math.min(vh, Math.ceil(r.y + r.h)) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}
// On macOS the off-screen view's own surface comes back blank (a white strip
// with only the page's floating button on it), so the picture is asked of the
// page's renderer instead, through the debugger. Other systems keep
// capturePage, which is known to work there. WLB_CDP_SHOTS=1 forces this path.
const VIA_DEBUGGER = process.platform === "darwin" || process.env.WLB_CDP_SHOTS === "1";
async function grabViaDebugger(v, rect) {
  const dbg = v.webContents.debugger;
  const mine = !dbg.isAttached();
  try {
    if (mine) dbg.attach("1.3");
    // the debugger's rectangle is measured from the top of the document, not of the view
    const at = (await run(v, "({ x: window.scrollX, y: window.scrollY })")) || { x: 0, y: 0 };
    const res = await Promise.race([
      dbg.sendCommand("Page.captureScreenshot", { format: "png", clip: { x: rect.x + at.x, y: rect.y + at.y, width: rect.width, height: rect.height, scale: 1 } }),
      wait(8000).then(() => null),
    ]);
    if (!res?.data) return null;
    const buf = Buffer.from(res.data, "base64");
    const px = nativeImage.createFromBuffer(buf).getSize().width; // real pixels: 2x on a Retina screen
    const img = nativeImage.createFromBuffer(buf, { scaleFactor: Math.max(1, Math.round((px / Math.max(1, rect.width)) * 100) / 100) });
    return img && !img.isEmpty() ? img : null;
  } catch { return null; }
  finally { if (mine) { try { dbg.detach(); } catch { /* already detached */ } } }
}
let viaDebugger = VIA_DEBUGGER; // flipped for one retry when a picture comes out blank
async function grab(v, rect) {
  if (viaDebugger && rect) {
    const img = await grabViaDebugger(v, rect);
    if (img) return img;
  }
  const img = await v.webContents.capturePage(rect || undefined);
  return img && !img.isEmpty() ? img : null;
}
// Raw pixels of an image plus its real pixel size (the capture can be at 2x).
function pixels(img) {
  const size = img.getSize();
  const data = img.toBitmap();
  const ratio = Math.sqrt(data.length / 4 / Math.max(1, size.width * size.height)) || 1;
  const w = Math.round(size.width * ratio), h = Math.round(data.length / 4 / Math.max(1, w));
  return { data, w, h, ratio };
}
// Stack pixel slices of one width into a single PNG.
function stack(slices) {
  const w = slices[0].w;
  const rows = slices.filter((s) => s.w === w && s.h > 0);
  const h = rows.reduce((n, s) => n + s.h, 0);
  const out = Buffer.concat(rows.map((s) => s.data.subarray(0, s.w * s.h * 4)));
  return nativeImage.createFromBitmap(out, { width: w, height: h }).toPNG();
}
const cropRows = (p, from, to) => ({ data: p.data.subarray(from * p.w * 4, to * p.w * 4), w: p.w, h: to - from });

// One capture with the viewport made tall enough for the whole list.
async function captureTall(v, kind, g) {
  const extra = g.scroll ? g.scroll.scrollH - g.scroll.clientH : 0;
  const height = Math.min(MAX_HEIGHT, Math.ceil(g.vh + extra + 40));
  if (g.vh + extra + 40 > MAX_HEIGHT) return null; // too long for one image: stitch what fits
  const dbg = v.webContents.debugger;
  let attached = false;
  try {
    if (dbg.isAttached()) return null; // dev tools are open on the view: leave it alone
    dbg.attach("1.3");
    attached = true;
    await Promise.race([
      dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: g.vw, height, deviceScaleFactor: 0, mobile: false }),
      wait(4000).then(() => { throw new Error("no answer"); }),
    ]);
    let g2 = null;
    for (let i = 0; i < 6; i++) { // the page lays out again, and long lists can load more rows
      await wait(450);
      g2 = await run(v, GEOM_SCRIPT(kind));
      if (g2 && (!g2.scroll || g2.scroll.scrollH - g2.scroll.clientH <= 2)) break;
    }
    if (!g2 || (g2.scroll && g2.scroll.scrollH - g2.scroll.clientH > 2)) return null;
    await wait(250);
    const rect = clip(kind === "page" ? { x: 0, y: 0, w: g2.vw, h: g2.scroll.scrollH } : g2.rect, g2.vw, g2.vh);
    const img = rect && await grab(v, rect);
    return img ? img.toPNG() : null;
  } catch { return null; }
  finally {
    if (attached) {
      try { await Promise.race([dbg.sendCommand("Emulation.clearDeviceMetricsOverride"), wait(3000)]); } catch { /* view gone */ }
      try { dbg.detach(); } catch { /* already detached */ }
      await wait(300);
    }
  }
}

// Scroll the list a screenful at a time and stitch the slices.
async function captureStitched(v, kind, g) {
  const s = g.scroll;
  // slices span the panel's full width, so its title strip stacks on top of them
  const area = clip(g.win ? { x: s.x, y: s.y, w: s.w, h: s.h } : { x: g.rect.x, y: s.y, w: g.rect.w, h: s.h }, g.vw, g.vh);
  if (!area) return null;
  const slices = [];
  if (!g.win) { // what sits above the list (the panel's title), once
    const head = clip({ x: g.rect.x, y: g.rect.y, w: g.rect.w, h: s.y - g.rect.y }, g.vw, g.vh);
    const img = head && head.height > 4 && head.width === area.width ? await grab(v, head) : null;
    if (img) slices.push(pixels(img));
  }
  const step = area.height;
  const total = Math.min(s.scrollH, MAX_HEIGHT);
  for (let y = 0, n = 0; y < total && n < 60; y += step, n++) {
    const at = await run(v, SCROLL_SCRIPT(y, g.win));
    if (at == null || at < 0) break;
    await wait(380);
    const img = await grab(v, area);
    if (!img) break;
    const p = pixels(img);
    // the last screenful can't scroll a whole step: drop the rows already captured
    const overlap = Math.max(0, Math.min(p.h - 1, Math.round((y - at) * p.ratio)));
    slices.push(overlap ? cropRows(p, overlap, p.h) : p);
    if (at + step >= s.scrollH - 1) break;
  }
  await run(v, SCROLL_SCRIPT(0, g.win));
  return slices.length ? stack(slices) : null;
}

// A picture that is almost all white: nothing was drawn where the list should be.
function mostlyBlank(png) {
  try {
    const p = pixels(nativeImage.createFromBuffer(png));
    const step = Math.max(1, Math.floor(Math.sqrt((p.w * p.h) / 40000)));
    let seen = 0, ink = 0;
    for (let y = 0; y < p.h; y += step) for (let x = 0; x < p.w; x += step) {
      const i = (y * p.w + x) * 4;
      seen++;
      if (p.data[i] < 235 || p.data[i + 1] < 235 || p.data[i + 2] < 235) ink++;
    }
    return seen > 0 && ink / seen < 0.015;
  } catch { return false; }
}
// What the page says about the thing being photographed (kept with a blank picture, for fixing the reader).
const DIAG_SCRIPT = `(() => {
  const el = document.querySelector("[data-wlb-panel]") || document.querySelector('[role="dialog"]');
  const chain = [];
  for (let e = el; e && e !== document.documentElement && chain.length < 8; e = e.parentElement) {
    const c = getComputedStyle(e), r = e.getBoundingClientRect();
    chain.push({ tag: e.tagName, role: e.getAttribute("role"), testid: e.getAttribute("data-testid"), opacity: c.opacity, visibility: c.visibility, display: c.display, transform: c.transform, position: c.position, bg: c.backgroundColor, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  }
  return { found: !!el, text: el ? (el.innerText || "").replace(/\\s+/g, " ").slice(0, 300) : null, chain,
    animations: document.getAnimations ? document.getAnimations().length : null, visibility: document.visibilityState, focus: document.hasFocus(),
    dpr: window.devicePixelRatio, vw: window.innerWidth, vh: window.innerHeight, scrollY: window.scrollY, url: location.href };
})()`;
// Bring every running animation to its end (a panel sliding or fading in that never got its frames).
const SETTLE_SCRIPT = `(() => {
  if (!document.getElementById("wlb-noanim")) { const s = document.createElement("style"); s.id = "wlb-noanim"; s.textContent = "*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}"; document.head.appendChild(s); }
  for (const a of document.getAnimations ? document.getAnimations() : []) { try { a.finish(); } catch (e) {} }
  return true;
})()`;

// → { png: Buffer, kind, how } or null. A blank picture is retried with the
// page's animations finished, then with the other way of taking it; if it is
// still blank it comes back marked { blank, debug, fullPng } so the caller can
// keep the evidence.
async function captureShot(v, kind) {
  const first = await captureOnce(v, kind);
  if (!first || !mostlyBlank(first.png)) return first;
  const diag = await run(v, DIAG_SCRIPT);
  await run(v, SETTLE_SCRIPT);
  await wait(600);
  const second = await captureOnce(v, kind);
  if (second && !mostlyBlank(second.png)) return { ...second, how: second.how + "+settled" };
  viaDebugger = !viaDebugger;
  let third = null;
  try { third = await captureOnce(v, kind); } finally { viaDebugger = !viaDebugger; }
  if (third && !mostlyBlank(third.png)) return { ...third, how: third.how + "+other" };
  let fullPng = null;
  try { const img = await v.webContents.capturePage(); if (img && !img.isEmpty()) fullPng = img.toPNG(); } catch { /* view gone */ }
  return { ...(second || first), blank: true, fullPng,
    debug: { platform: process.platform, viaDebugger, kind, how: (second || first).how, before: diag, after: await run(v, DIAG_SCRIPT), geometry: await run(v, GEOM_SCRIPT(kind)) } };
}
async function captureOnce(v, kind) {
  try {
    if (!v || v.webContents.isDestroyed()) return null;
    // The page must be still before it is measured. Walmart scrolls smoothly,
    // so a jump to the top is still moving a moment later, and a rectangle
    // measured mid-scroll lands on whatever is there once it stops (the site
    // header, in the first live screenshots). Jump instantly, then wait until
    // the scroll position stops changing.
    // Inner scrolling counts too: looking for the sellers link scrolls the
    // listing's right-hand column inside itself.
    if (kind !== "panel") await run(v, `(() => { for (const e of document.querySelectorAll("*")) if (e.scrollTop > 0) e.scrollTo({ top: 0, behavior: "instant" }); window.scrollTo({ top: 0, left: 0, behavior: "instant" }); })()`);
    for (let i = 0, last = -1; i < 12; i++) {
      await wait(200);
      const y = await run(v, "window.scrollY");
      if (y === last) break;
      last = y;
    }
    await wait(350); // sticky parts finish sliding back into place
    const g = await run(v, GEOM_SCRIPT(kind));
    if (!g) return null;
    // a "page" this long is a whole listing, not a seller list: not worth a picture
    if (kind === "page" && g.scroll.scrollH > g.vh * 5) return null;
    const extra = g.scroll ? g.scroll.scrollH - g.scroll.clientH : 0;
    if (extra <= 2 && (kind === "page" || g.rect.y + g.rect.h <= g.vh + 2)) {
      const img = await grab(v, clip(g.rect, g.vw, g.vh));
      return img ? { png: img.toPNG(), kind, how: "single" } : null;
    }
    if (!g.scroll) { // a tall buy box: make the viewport tall enough for it
      g.scroll = { x: 0, y: 0, w: g.vw, h: g.vh, scrollH: Math.ceil(g.rect.y + g.rect.h), clientH: g.vh };
      const tall = await captureTall(v, kind, g);
      if (tall) return { png: tall, kind, how: "tall" };
      const img = await grab(v, clip(g.rect, g.vw, g.vh));
      return img ? { png: img.toPNG(), kind, how: "single" } : null;
    }
    const tall = await captureTall(v, kind, g);
    if (tall) return { png: tall, kind, how: "tall" };
    const g3 = (await run(v, GEOM_SCRIPT(kind))) || g; // sizes are back to normal after the override
    const png = g3.scroll ? await captureStitched(v, kind, g3) : null;
    return png ? { png, kind, how: "stitched" } : null;
  } catch (e) {
    console.error("Screenshot failed:", e);
    return null;
  }
}

module.exports = { captureShot, captureStitched, GEOM_SCRIPT };
