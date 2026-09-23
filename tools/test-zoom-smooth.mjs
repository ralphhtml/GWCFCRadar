#!/usr/bin/env node
/*
 * Zooming in was very laggy and the tiles never seemed to arrive. A held
 * scroll applied a full zoom on every animation frame: 2 seconds of scroll
 * fired 66 zoomends and started 3,605 tile loads, of which 32 finished. The
 * wheel now zooms the way a pinch does: the map is moved while the fingers
 * move, settles once per whole level crossed, and commits once at the end.
 *
 *     node tools/test-zoom-smooth.mjs
 *
 * Uses the real Leaflet build and real wheel events.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) { console.log('playwright is not installed, skipping'); process.exit(0); }

// A 1x1 grey PNG for every tile.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
const TILE = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.from([0, 90, 90, 90]))), chunk('IEND', Buffer.alloc(0))]);

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (/\.(png|jpg|jpeg|webp)(\?|$)/i.test(url) || /tile|wms|\/\d+\/\d+\/\d+/i.test(url)) {
    await new Promise(r => setTimeout(r, 60));
    return route.fulfill({ contentType: 'image/png', body: TILE, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(5000);
ok('the page boots clean', errs.length === 0, errs[0]);

// Scroll up at the map's centre for `ms`, `px` per event every 8 ms.
const scroll = (ms, px, at) => p.evaluate(async ({ ms, px, at }) => {
  const out = { zoomend: 0, moveend: 0, maxScale: 1, tileStarts: 0, tileLoads: 0 };
  const onZ = () => out.zoomend++, onM = () => out.moveend++;
  map.on('zoomend', onZ); map.on('moveend', onM);
  const grids = [];
  map.eachLayer(l => { if (l instanceof L.GridLayer) grids.push(l); });
  const ts = () => out.tileStarts++, tl = () => out.tileLoads++;
  grids.forEach(l => { l.on('tileloadstart', ts); l.on('tileload', tl); });
  const el = map.getContainer(), rc = el.getBoundingClientRect();
  const x = rc.left + at[0], y = rc.top + at[1];
  const under = map.containerPointToLatLng([at[0], at[1]]);
  const z0 = map.getZoom(), t0 = performance.now();
  while (performance.now() - t0 < ms) {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -px, deltaMode: 0, clientX: x, clientY: y,
      bubbles: true, cancelable: true }));
    // The biggest stretch any tile level is under right now.
    grids.forEach(l => {
      for (const k in (l._levels || {})) {
        const s = map.getZoomScale(map.getZoom(), Number(k));
        if (s > out.maxScale && l._levels[k].el.children.length) out.maxScale = s;
      }
    });
    await new Promise(r => setTimeout(r, 8));
  }
  const zoomendDuring = out.zoomend;
  await new Promise(r => setTimeout(r, 400));             // the settle, and the commit
  const back = map.latLngToContainerPoint(under);
  grids.forEach(l => { l.off('tileloadstart', ts); l.off('tileload', tl); });
  map.off('zoomend', onZ); map.off('moveend', onM);
  const res = { ...out, zoomendDuring, z0, z1: map.getZoom(), drift: Math.hypot(back.x - at[0], back.y - at[1]),
           held: grids.filter(l => l.options.updateWhenZooming === false && !l.__alwaysQuiet).length,
           tileZoom: grids.filter(l => l._tileZoom !== undefined)
             .map(l => [l._tileZoom, l._clampZoom(Math.round(map.getZoom()))]) };
  return JSON.stringify(res);
}, { ms, px, at }).then(r => JSON.parse(r));

console.log('\n1. a short scroll: follows the fingers, one zoomend, tiles for where you stopped');
{
  await p.evaluate(() => { map.setView([37.5, -96], 5, { animate: false }); map.eachLayer(l => {
    if (l instanceof L.GridLayer && l.options.updateWhenZooming === false) l.__alwaysQuiet = true; }); });
  await p.waitForTimeout(600);
  const r = await scroll(800, 4, [900, 300]);
  const levels = r.z1 - r.z0;
  ok(`the whole scroll became zoom (${levels.toFixed(2)} levels, none dropped)`, levels > 1.5, JSON.stringify(r));
  ok('no zoomend fires while the fingers are still moving, beyond one per whole level',
     r.zoomendDuring <= Math.ceil(levels) + 1, r.zoomendDuring + ' for ' + levels.toFixed(2));
  ok('and it settles with exactly one more when they stop', r.zoomend === r.zoomendDuring + 1,
     r.zoomend + ' vs ' + r.zoomendDuring);
  ok('the point under the cursor stays under the cursor', r.drift < 3, r.drift.toFixed(2) + ' px');
  ok('almost every tile asked for is a tile shown', r.tileStarts > 0 && r.tileLoads / r.tileStarts > 0.8,
     r.tileLoads + ' of ' + r.tileStarts);
  ok('the tile layers end on the level you stopped at (or their own deepest)', r.tileZoom.every(([z, want]) => z === want),
     JSON.stringify(r.tileZoom) + ' at ' + r.z1.toFixed(2));
  ok('and every layer loads tiles normally again afterwards', r.held === 0, r.held);
}

console.log('\n2. a long fast scroll: nothing stretched into a smear, nothing flooding');
{
  await p.evaluate(() => { map.setView([37.5, -96], 4, { animate: false }); });
  await p.waitForTimeout(600);
  const r = await scroll(1500, 12, [640, 400]);
  const levels = r.z1 - r.z0;
  ok(`it crossed many levels (${levels.toFixed(1)})`, levels > 8, JSON.stringify(r));
  ok('no tile level was ever stretched past 4x', r.maxScale <= 4.01, r.maxScale.toFixed(1));
  ok('zoomends stay near one per level, not one per frame', r.zoomend <= Math.ceil(levels) + 2,
     r.zoomend + ' for ' + levels.toFixed(1));
  ok('tile loads started stay in the hundreds, not thousands', r.tileStarts < 1200, r.tileStarts);
}

console.log('\n3. nothing threw');
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
