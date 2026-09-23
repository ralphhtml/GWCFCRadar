#!/usr/bin/env node
/*
 * Pinching out on a phone: the map should never shrink into a small
 * rectangle floating in empty space.
 *
 *     node tools/test-pinch-backdrop.mjs
 *
 * A phone is emulated and a real two-finger pinch is sent through the
 * DevTools protocol. Map tiles are faked with a delay, the way a real network
 * answers: the sharp basemap is green, the coarse backdrop (three zoom levels
 * lower) is orange, so a screenshot shows which one is filling each spot.
 * Checked: the backdrop sits under the basemap and follows its style; it is
 * three levels coarser and covers far more than the screen with a handful of
 * tiles; mid-pinch every edge of the screen shows map (backdrop) instead of
 * the empty background, and the same pinch without the backdrop does not.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
ok('a backdrop under the basemap, wired when the map is made',
   PAGE.includes('function _wireBasemapBackdrop') && /_wireBasemapBackdrop\(\);/.test(PAGE));
ok('no em dashes in the new code or this test',
   !PAGE.slice(PAGE.indexOf('// -- BASEMAP BACKDROP'), PAGE.indexOf('// -- INIT MAP --')).includes(String.fromCharCode(0x2014))
   && !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// A flat 256 px PNG of one colour, made here so the test needs no files.
function png(r, g, b) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = buf => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + 256 * 3); for (let i = 0; i < 256; i++) { row[1 + i * 3] = r; row[2 + i * 3] = g; row[3 + i * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const GREEN = png(40, 140, 60), ORANGE = png(230, 140, 40);

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });

async function run(withBackdrop) {
  const ctx = await b.newContext({ viewport: { width: 412, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
  await p.route('**://**', async r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('leaflet') && u.endsWith('.js'))
      return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css'))
      return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    if (/maptiler/.test(u)) {
      await new Promise(res => setTimeout(res, 350));      // a real network takes a moment
      const z = Number(u.split('?')[0].split('/').slice(-3)[0]);
      return r.fulfill({ body: z <= 4 ? ORANGE : GREEN, contentType: 'image/png' }).catch(() => {});
    }
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  if (!withBackdrop) await p.evaluate(() => { _basemapBackdrop.setOpacity(0); });
  await p.evaluate(() => {
    // The first-visit pickers and the changelog dim the page; out of the way.
    document.querySelectorAll('#mode-modal').forEach(x => x.remove());
    try { _clClose(); } catch (e) {}
    map.setView([40, -84], 7, { animate: false });
  });
  await p.waitForTimeout(2500);
  const out = { errs };
  out.rest = await p.evaluate(() => {
    const bd = _basemapBackdrop;
    if (!bd || !map.hasLayer(bd)) return null;
    const base = Object.values(mapTileLayers).find(l => map.hasLayer(l));
    return { tz: bd._getZoomForUrl(), n: Object.keys(bd._tiles).length, sameUrl: bd._url === base._url,
             paneZ: Number(map.getPane('backdropPane').style.zIndex), tileZ: Number(getComputedStyle(map.getPane('tilePane')).zIndex) };
  });
  const cdp = await ctx.newCDPSession(p);
  const tp = (id, x, y) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 });
  const cx = 206, cy = 400, d0 = 150, d1 = 30, steps = 12;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, cx - d0, cy), tp(2, cx + d0, cy)] });
  for (let s = 1; s <= steps; s++) {
    const d = d0 + (d1 - d0) * s / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(1, cx - d, cy), tp(2, cx + d, cy)] });
    await p.waitForTimeout(40);
  }
  // Mid-gesture, fingers still down: what fills the edges of the screen?
  const shot = await p.screenshot();
  out.edges = await p.evaluate(async (b64) => {
    const img = new Image();
    await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    // Spots inside the map, clear of the side buttons and the bars.
    return [[110, 110], [300, 110], [110, 620], [300, 620], [206, 150], [206, 400]].map(([px, py]) => {
      const d = x.getImageData(px, py, 1, 1).data;
      return d[0] > 180 && d[1] > 100 && d[2] < 90 ? 'backdrop' : (d[1] > 120 && d[0] < 90 ? 'sharp' : 'empty');
    });
  }, shot.toString('base64'));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(2000);
  out.after = await p.evaluate(() => {
    const bd = _basemapBackdrop;
    const z = map.getZoom();
    const res = bd ? { z, tz: bd._getZoomForUrl(), n: Object.keys(bd._tiles).length } : null;
    // Another basemap style: the backdrop follows it.
    if (bd) {
      const cur = Object.values(mapTileLayers).find(l => map.hasLayer(l));
      map.removeLayer(cur); mapTileLayers.dark.addTo(map);
      res.follows = bd._url === mapTileLayers.dark._url && map.hasLayer(bd);
      map.removeLayer(mapTileLayers.dark);
      res.goneWithBase = !map.hasLayer(bd);
      cur.addTo(map);
      res.back = map.hasLayer(bd) && bd._url === cur._url;
    }
    return res;
  });
  await ctx.close();
  return out;
}

console.log('\n2. without the backdrop (the old behaviour), for comparison');
const before = await run(false);
ok('mid-pinch the edges of the screen are empty', before.edges.slice(0, 5).every(e => e === 'empty'), before.edges.join(','));

console.log('\n3. with the backdrop');
const r = await run(true);
ok('the page boots clean', r.errs.length === 0, r.errs[0]);
ok('the backdrop is on, under the basemap, in the same style',
   r.rest && r.rest.sameUrl && r.rest.paneZ < r.rest.tileZ, JSON.stringify(r.rest));
ok('three zoom levels coarser, and only a handful of tiles', r.rest && r.rest.tz === 4 && r.rest.n <= 30, JSON.stringify(r.rest));
ok('mid-pinch every edge of the screen shows map, not empty space',
   r.edges.slice(0, 5).every(e => e === 'backdrop'), r.edges.join(','));
ok('and the middle is still the sharp map', r.edges[5] === 'sharp', r.edges.join(','));
ok('after the pinch it refreshes for the new zoom, still a handful of tiles',
   r.after && r.after.tz === Math.max(0, Math.round(r.after.z) - 3) && r.after.n <= 30, JSON.stringify(r.after));
ok('it follows a basemap switch, leaves with the basemap, and comes back with it',
   r.after && r.after.follows && r.after.goneWithBase && r.after.back, JSON.stringify(r.after));

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
