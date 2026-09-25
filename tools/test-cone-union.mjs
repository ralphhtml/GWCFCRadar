#!/usr/bin/env node
/*
 * Storm cones on tight turns: no fold-over.
 *
 *     node tools/test-cone-union.mjs
 *
 * The cone's outline was the track pushed out sideways by the cone's width
 * on each side. On a turn tighter than the cone is wide the inside edge
 * crosses back over itself and the fill folds (a notch or bow tie, as on the
 * Honolulu cone in the tester's report). Such a track now gets the merged
 * shape of all its uncertainty circles; a gentle track keeps the exact
 * outline it always had.
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

const check = (pts) => p.evaluate((pts) => {
  map.setView([20, -155], 5, { animate: false });
  const t = _scBuildTrack(pts.map(q => L.latLng(q[0], q[1])), null, 'multi');
  const ring = t.ring.map(q => L.latLng(q));
  const inside = (ll) => _ptInPoly(ll.lat, ll.lng, ring);
  // Every centre point inside the outline; and every point of the outline
  // on the edge of the union of circles (within a couple of grid cells).
  const N = t.center.length - 1;
  const r = t.center.map((_, i) => t.capRadiusMiles * (i / N) * 1609.344);
  const centresIn = t.center.slice(3).every(c => inside(L.latLng(c)));
  let worst = 0;
  ring.forEach(q => {
    let d = Infinity;
    for (let i = 0; i < t.center.length; i++) d = Math.min(d, map.distance(q, t.center[i]) - r[i]);
    worst = Math.max(worst, Math.abs(d));
  });
  return { n: ring.length, crosses: _scRingSelfIntersects(ring), centresIn, worstKm: worst / 1000,
           capKm: t.capRadiusMiles * 1.609, segs: N };
}, pts);

console.log('\n1. a hairpin, like the Honolulu cone');
let r = await check([[18.5, -154.5], [19.8, -155.6], [20.8, -156.2], [21.3, -157.2], [21.6, -158.8], [20.9, -160.3]]);
ok('the traced outline does not cross itself', r.crosses === false, JSON.stringify(r));
ok('every point of the track is inside it', r.centresIn, JSON.stringify(r));
ok('and it runs along the edge of the uncertainty circles', r.worstKm < r.capKm * 0.08, JSON.stringify(r));

console.log('\n2. a track that doubles straight back');
r = await check([[15, -150], [18, -152], [20, -155], [18, -157], [15, -155]]);
ok('no fold, no bow tie', r.crosses === false && r.centresIn, JSON.stringify(r));

console.log('\n3. a gentle track keeps its exact outline');
r = await check([[15, -150], [17, -152], [19, -154.5]]);
ok('the original outline, point for point (3N+1 points)', r.n === 3 * r.segs + 1 && r.crosses === false, JSON.stringify(r));

console.log('\n4. drawn on the map');
const drawn = await p.evaluate(() => {
  const t = _scBuildTrack([[18.5, -154.5], [19.8, -155.6], [20.8, -156.2], [21.3, -157.2], [21.6, -158.8], [20.9, -160.3]].map(q => L.latLng(q[0], q[1])), null, 'multi');
  _scTrack = t; _scRenderCone();
  return { ok: !!_scPolygon && Math.abs(_scPolygon.getLatLngs()[0].length - t.ring.length) <= 1, n: _scPolygon && _scPolygon.getLatLngs()[0].length, want: t.ring.length };
});
ok('the cone renders from the traced outline', drawn.ok, JSON.stringify(drawn));
await p.screenshot({ path: process.env.SHOT || '/tmp/cone-union.png' });
ok('no page errors', errs.length === 0, errs.join(' | '));
ok('no em dashes', !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
