#!/usr/bin/env node
/*
 * Right-click, Radar: the picture is on the map in under a millisecond.
 *
 *     node tools/test-rightclick-instant.mjs
 *
 * Opening the menu starts the nearest radar loading and, once its picture is
 * in hand, unpacks it into one ready image and map layer. The click then only
 * places that layer; the menus, site pills and loop are done a frame later.
 * The order used to be the other way round, and the picture landed 40 to 80
 * ms after the click even when it was already cached.
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
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  // A finished KOKX picture in the cache, as a warm-up would leave it.
  const cv = document.createElement('canvas'); cv.width = 1600; cv.height = 1600;
  const g = cv.getContext('2d');
  for (let i = 0; i < 4000; i++) { g.fillStyle = `hsl(${i % 360},80%,50%)`; g.fillRect(Math.random() * 1600, Math.random() * 1600, 9, 9); }
  const img = { url: cv.toDataURL('image/png'), leafletBounds: [[38.8, -75.6], [43.0, -70.2]], timeIso: new Date().toISOString() };
  currentProduct = 'ref';
  _l3PicPut('kokx', 'ref', null, img, { metadata: {} }, null);
  _cmOpen({ latlng: L.latLng(40.9, -72.9), originalEvent: null });
  await wait(400);
  const out = { ready: !!(_cmReady && _cmReady.layer && _cmReady.el.complete) };
  const c = performance.now();
  _cmGoRadar();
  out.clickMs = performance.now() - c;
  out.upAtOnce = !!(_cmPreview && map.hasLayer(_cmPreview));
  out.sameSite = _cmPreview && _cmPreview.getBounds().getCenter().distanceTo(L.latLng(40.9, -72.9)) < 50000;
  await wait(2000);
  out.standInGone = !_cmPreview;
  out.realUp = !!(_l3Overlay && map.hasLayer(_l3Overlay) && _l3Overlay._url === img.url);
  out.site = _l2Site; out.src = _radarSource;
  // The placement alone, several times over.
  const times = [];
  for (let k = 0; k < 7; k++) {
    _cmReadyPrep('kokx'); await wait(150);
    const t = performance.now(); _cmPreviewShow({ id: 'kokx' }); times.push(performance.now() - t);
    _cmPreviewDrop();
  }
  times.sort((a, b) => a - b);
  out.median = times[3];
  // Turning the radar off takes a stand-in with it.
  _cmReadyPrep('kokx'); await wait(150); _cmPreviewShow({ id: 'kokx' });
  _disableL3();
  out.offClears = !_cmPreview;
  return out;
});
ok('opening the menu readies the picture and its map layer', r.ready, JSON.stringify(r));
ok('the picture is on the map the moment Radar is clicked', r.upAtOnce && r.sameSite, JSON.stringify(r));
ok(`placing it takes under a millisecond (median ${r.median.toFixed(2)} ms)`, r.median < 1, JSON.stringify(r));
ok(`the whole click returns fast (${r.clickMs.toFixed(2)} ms)`, r.clickMs < 10, JSON.stringify(r));
ok('the normal load takes over with the same picture and the stand-in goes', r.standInGone && r.realUp, JSON.stringify(r));
ok('KOKX is the Level 2 site afterwards', r.site === 'kokx' && r.src === 'l2', JSON.stringify(r));
ok('switching the radar off removes a stand-in', r.offClears, JSON.stringify(r));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
