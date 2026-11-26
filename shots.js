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
    const root = document.querySelector('[role="dialog"]') || document.querySelector('[data-testid*="seller" i][class*="panel" i], [data-testid*="allSellers" i], aside[class*="seller" i]');
    if (!root) return null;
    let best = null;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.scrollHeight - el.clientHeight < 4 || el.clientHeight < 60) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    if (best) { best.setAttribute("data-wlb-scroll", "1"); best.scrollTop = 0; }
    return { rect: box(root), scroll: best ? { ...box(best), scrollH: best.scrollHeight, clientH: best.clientHeight } : null, vw, vh, win: false };
  }
  // buy box: the price's column in the listing's right rail
  window.scrollTo(0, 0);
  let el = document.querySelector('[data-testid="add-to-cart-section"], [data-testid*="buy-box" i], [data-testid*="buybox" i], [data-seo-id*="buy-box" i]');
  if (!el) {
    let p = document.querySelector('[itemprop="price"], span[data-seo-id="hero-price"], [data-testid="price-wrap"]');
    for (let i = 0; p && i < 12; i++) {
      const r = p.getBoundingClientRect();
      if (r.width >= 260 && r.width <= 620 && r.height >= 220) { el = p; break; }
      p = p.parentElement;
    }
  }
  if (!el) return { rect: { x: 0, y: 0, w: vw, h: vh }, scroll: null, vw, vh, win: false, whole: true };
  const r = box(el);
  return { rect: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), w: r.w + 16, h: r.h + 16 }, scroll: null, vw, vh, win: false };
})()`;
const SCROLL_SCRIPT = (y, win) => `(() => {
  if (${win ? "true" : "false"}) { window.scrollTo(0, ${y}); return window.scrollY; }
  const el = document.querySelector("[data-wlb-scroll]"); if (!el) return -1;
  el.scrollTop = ${y}; return el.scrollTop;
})()`;

const run = (v, js) => v.webContents.executeJavaScript(js, true).catch(() => null);

// A view-space rectangle, whole pixels, kept inside the viewport.
function clip(r, vw, vh) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const w = Math.min(vw, Math.ceil(r.x + r.w)) - x, h = Math.min(vh, Math.ceil(r.y + r.h)) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}
async function grab(v, rect) {
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

// → { png: Buffer, kind, how: "single" | "tall" | "stitched" } or null.
async function captureShot(v, kind) {
  try {
    if (!v || v.webContents.isDestroyed()) return null;
    const g = await run(v, GEOM_SCRIPT(kind));
    if (!g) return null;
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
