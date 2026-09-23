#!/usr/bin/env node
/*
 * iOS memory: map tiles and markers placed with 2D transforms, hidden radar
 * frames out of rendering.
 *
 *     node tools/test-ios-flat-tiles.mjs
 *
 * WebKit gives every element with a 3D transform its own GPU surface, and
 * Leaflet places every tile and marker with translate3d: on a 3x iPhone each
 * tile is a 2.4 MB texture, for every tile of every layer. That is the
 * "Can't open this page" crash. Checked on an emulated iPhone: every tile and
 * marker is placed flat (translate, not translate3d), still in the right
 * spot, after load, a pan and a zoom; the tiles still cover the screen; the
 * map pane keeps its 3D transform so a pan slides one picture; hidden layers
 * (opacity 0, the radar loop's waiting frames) are display:none. And on a
 * desktop nothing changes.
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
ok('tiles and markers are flattened on iOS only', /if \(_isIOS\) _iosFlatTiles\(\);/.test(PAGE));
ok('no em dashes in the new code or this test',
   !PAGE.slice(PAGE.indexOf('// -- iOS: tiles and markers placed flat'), PAGE.indexOf('// -- INIT MAP --')).includes(String.fromCharCode(0x2014))
   && !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

function png(r, g, b) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = buf => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const tt = Buffer.concat([Buffer.from(t), d]); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tt)); return Buffer.concat([l, tt, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(256, 0); ih.writeUInt32BE(256, 4); ih[8] = 8; ih[9] = 2;
  const row = Buffer.alloc(769); for (let i = 0; i < 256; i++) { row[1 + i * 3] = r; row[2 + i * 3] = g; row[3 + i * 3] = b; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(256).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}
const G = png(40, 140, 60);
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });

async function open(ios) {
  const ctx = await b.newContext(ios
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    if (r.request().resourceType() === 'image' && /maptiler|tile|mesonet|wms/i.test(u)) return r.fulfill({ body: G, contentType: 'image/png' });
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5000);
  return { ctx, p, errs };
}

const probe = (p) => p.evaluate(() => {
  const tiles = [...document.querySelectorAll('.leaflet-tile')];
  const markers = [...document.querySelectorAll('.leaflet-marker-icon')];
  const is3d = e => /translate3d/.test(e.style.transform || '');
  // Does the basemap's visible level still cover the screen?
  const size = map.getSize();
  const base = Object.values(mapTileLayers).find(l => map.hasLayer(l));
  const lvl = base && base._container && [...base._container.querySelectorAll('.leaflet-tile-container')].pop();
  let covered = 0, samples = 0;
  if (lvl) {
    const rects = [...lvl.querySelectorAll('.leaflet-tile')].map(t => t.getBoundingClientRect());
    const mc = map.getContainer().getBoundingClientRect();
    for (let x = 10; x < size.x; x += 60) for (let y = 10; y < size.y; y += 60) {
      samples++;
      const px = mc.left + x, py = mc.top + y;
      if (rects.some(r => px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) covered++;
    }
  }
  // A tile sits where its coordinates say.
  let placed = true;
  if (base) {
    for (const k in base._tiles) {
      const t = base._tiles[k];
      const want = base._getTilePos(t.coords);
      const m = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/.exec(t.el.style.transform);
      if (!m || Math.abs(+m[1] - want.x) > 0.5 || Math.abs(+m[2] - want.y) > 0.5) { placed = false; break; }
    }
  }
  const hiddenLayers = [...document.querySelectorAll('.leaflet-pane .leaflet-layer')].filter(l => /opacity: 0;/.test(l.getAttribute('style') || ''));
  return { tiles: tiles.length, tiles3d: tiles.filter(is3d).length, markers: markers.length, markers3d: markers.filter(is3d).length,
           cover: samples ? covered / samples : 0, placed, pane3d: /translate3d/.test(map.getPane('mapPane').style.transform || ''),
           hidden: hiddenLayers.length, hiddenNone: hiddenLayers.filter(l => getComputedStyle(l).display === 'none').length };
});

console.log('\n2. an iPhone');
{
  const { ctx, p, errs } = await open(true);
  await p.evaluate(() => { L.marker([37.5, -96]).addTo(map); map.setView([37.5, -96], 5, { animate: false }); });
  await p.waitForTimeout(1500);
  let r = await probe(p);
  ok('the page boots clean', errs.length === 0, errs[0]);
  ok(`every tile is placed flat (${r.tiles} tiles, ${r.tiles3d} in 3D)`, r.tiles > 0 && r.tiles3d === 0, JSON.stringify(r));
  ok('and every marker', r.markers > 0 && r.markers3d === 0, JSON.stringify(r));
  ok('each tile sits exactly where its coordinates say', r.placed);
  ok('the tiles cover the screen', r.cover > 0.97, r.cover.toFixed(2));
  ok('the map pane keeps its 3D transform, so a pan slides one picture', r.pane3d);
  ok('hidden layers (the radar loop\'s waiting frames) are out of rendering', r.hidden === r.hiddenNone, `${r.hiddenNone} of ${r.hidden}`);
  await p.evaluate(() => { map.panBy([300, 200], { animate: false }); map.setZoom(7, { animate: false }); });
  await p.waitForTimeout(1500);
  r = await probe(p);
  ok('after a pan and a zoom, the new tiles and moved markers are still flat', r.tiles3d === 0 && r.markers3d === 0, JSON.stringify(r));
  ok('still in place and still covering the screen', r.placed && r.cover > 0.97, JSON.stringify(r));
  await ctx.close();
}

console.log('\n3. a desktop');
{
  const { ctx, p } = await open(false);
  await p.waitForTimeout(500);
  const r = await probe(p);
  ok('nothing changes: tiles keep translate3d', r.tiles > 0 && r.tiles3d === r.tiles, JSON.stringify(r));
  ok('and hidden layers stay visibility-hidden, not removed', r.hiddenNone === 0, JSON.stringify(r));
  await ctx.close();
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
