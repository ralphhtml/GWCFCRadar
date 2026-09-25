#!/usr/bin/env node
/*
 * The map wraps round the world (tester: "map panning is hard-locked at the
 * East/West edges (180 degrees), preventing continuous scrolling across the
 * Pacific").
 *
 *     node tools/test-world-wrap.mjs
 *
 * Checked: the map pans past 180 in both directions; tiles keep coming past
 * the date line; and markers, shapes and pictures on the far side of the date
 * line are drawn on the copy of the world in view, not 360 degrees away.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
ok('no hard east/west wall any more', !/maxBounds: \[\[-90, -180\], \[90, 180\]\]/.test(PAGE) && /worldCopyJump: true/.test(PAGE));
ok('every tile layer wraps', /L\.GridLayer\.addInitHook\(function \(\) \{ this\.options\.noWrap = false; \}\);/.test(PAGE));
ok('no em dashes', !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const tiles = [];
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  const m = u.match(/\/(\d+)\/(\d+)\/(\d+)(?:@2x)?\.(?:png|jpg|webp|pbf)/);
  if (m) tiles.push([+m[1], +m[2], +m[3]]);
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);

console.log('\n2. panning across the date line');
const r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  map.setView([20, 160], 4, { animate: false });
  await wait(300);
  // Pan east across 180 in steps, the way a drag would.
  for (let i = 0; i < 8; i++) { map.panBy([150, 0], { animate: false }); await wait(60); }
  const east = map.getCenter();
  map.setView([20, -170], 4, { animate: false });
  await wait(300);
  for (let i = 0; i < 8; i++) { map.panBy([-150, 0], { animate: false }); await wait(60); }
  const west = map.getCenter();
  return { east: [east.lat, east.lng], west: [west.lat, west.lng] };
});
ok('the map pans east past 180', r.east[1] < -150 || r.east[1] > 180, JSON.stringify(r));
ok('and west past -180', r.west[1] > 150 || r.west[1] < -180, JSON.stringify(r));

console.log('\n3. the far side of the date line is drawn in view');
const v = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const guam = L.marker([13.4, 144.8]).addTo(map);
  const box = L.polygon([[10, 170], [20, 170], [20, 178], [10, 178]]).addTo(map);
  const dot = L.circleMarker([15, 175], { radius: 6 }).addTo(map);
  const pic = L.imageOverlay('data:image/gif;base64,R0lGODlhAQABAAAAACw=', [[5, 165], [25, 179]]).addTo(map);
  const inView = (pt) => pt.x > -50 && pt.x < 1250 && pt.y > -50 && pt.y < 850;
  const where = () => {
    const o = map.containerPointToLayerPoint([0, 0]);
    const gm = L.DomUtil.getPosition(guam._icon).subtract(o);
    const bx = box._pxBounds.getCenter().subtract(o);
    const dt = dot._point.subtract(o);
    const im = L.DomUtil.getPosition(pic._image).subtract(o);
    return { guam: inView(gm), box: inView(bx), dot: inView(dt), pic: inView(im) };
  };
  // From Hawaii's side of the line, looking west across it.
  map.setView([18, -175], 4, { animate: false }); await wait(400);
  const fromEast = where();
  // And from Asia's side, looking east.
  map.setView([18, 170], 4, { animate: false }); await wait(400);
  const fromWest = where();
  // A long pan from the Americas all the way round to the West Pacific.
  map.setView([20, -120], 4, { animate: false }); await wait(300);
  for (let i = 0; i < 14; i++) { map.panBy([-300, 0], { animate: false }); await wait(50); }
  const c = map.getCenter();
  const afterPan = where();
  return { fromEast, fromWest, afterPan, centre: c.lng };
});
ok('from Hawaii looking west: the marker, the shape, the dot and the picture are all there',
   v.fromEast.guam && v.fromEast.box && v.fromEast.dot && v.fromEast.pic, JSON.stringify(v.fromEast));
ok('and from the Asian side too', v.fromWest.guam && v.fromWest.box && v.fromWest.dot && v.fromWest.pic, JSON.stringify(v.fromWest));
ok('after a long pan all the way round the Pacific', v.afterPan.box && v.afterPan.dot, JSON.stringify(v));

const xs = new Set(tiles.filter(t => t[0] === 4).map(t => t[1]));
ok('tiles are fetched on both sides of the date line (x 0 and 15 at zoom 4)', xs.has(0) && xs.has(15), [...xs].sort((a, b) => a - b).join(','));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
