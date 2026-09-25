#!/usr/bin/env node
/*
 * Alerts on a heavy day, the case a DevTools trace of an iPhone crash
 * pointed at: renderAlerts held the main thread for 2.5 seconds, and most of
 * the time went on projecting and clipping alert coordinates.
 *
 *     node tools/test-alert-weight.mjs
 *
 * Checked, with the NWS zones API faked to return survey-detailed outlines
 * (3,000 points a zone): each zone shape is thinned once when it arrives,
 * staying within a few hundred metres of the original; every alert is ONE
 * shape on the map now, with the black casing drawn by the renderer straight
 * under the coloured line instead of by a second copy of every polygon; the
 * whole render is several times faster than the old way; and the warning
 * pulse sits out a pan or zoom instead of repainting mid-gesture.
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
ok('no second casing layer in renderAlerts any more',
   !/const casing = L\.geoJSON/.test(PAGE.slice(PAGE.indexOf('function renderAlerts('), PAGE.indexOf('// Storm-motion vectors'))));
ok('zone outlines are thinned as they arrive', /if \(d\.geometry\) return _simplifyGeometry\(d\.geometry\);/.test(PAGE));
ok('no em dashes in the new code or this test',
   !PAGE.slice(PAGE.indexOf('let _alertsCanvasR'), PAGE.indexOf('async function _fetchZoneGeometry')).includes(String.fromCharCode(0x2014))
   && !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// A wobbly zone outline: a circle with a fine coastline-like ripple, 3,000
// points, the kind of detail the zones API really returns.
function zoneGeom(cLat, cLng) {
  const ring = [];
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2;
    const r = 0.35 + 0.01 * Math.sin(a * 90) + 0.004 * Math.sin(a * 700);
    ring.push([+(cLng + r * Math.cos(a) * 1.3).toFixed(6), +(cLat + r * Math.sin(a)).toFixed(6)]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js'))
    return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css'))
    return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  const m = u.match(/api\.weather\.gov\/zones\/forecast\/([A-Z]{2}Z(\d{3}))/);
  if (m) {
    const k = Number(m[2]);
    return r.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ geometry: zoneGeom(30 + (k % 6) * 2.2, -100 + Math.floor(k / 6) * 2.2) }) });
  }
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
ok('the page boots clean', errs.length === 0, errs[0]);

const RAW = zoneGeom(30, -100);

console.log('\n2. zone outlines are thinned once, faithfully');
{
  const r = await p.evaluate(async (raw) => {
    const feats = Array.from({ length: 60 }, (_, i) => ({ type: 'Feature', geometry: null,
      properties: { id: 'z' + i, event: 'Heat Advisory', areaDesc: 'Zone ' + i,
        geocode: { UGC: ['TXZ' + String(i).padStart(3, '0')] } } }));
    await _fillMissingAlertGeometry(feats);
    const g = feats[0].geometry;
    const ring = g.coordinates[0][0];
    // How far does the thinned outline stray from the original? Distance from
    // each original point to the nearest thinned segment, in degrees.
    const segDist = (px, py, a, b2) => {
      const dx = b2[0] - a[0], dy = b2[1] - a[1], l2 = dx * dx + dy * dy;
      let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
    };
    let worst = 0;
    for (let i = 0; i < raw.coordinates[0].length; i += 7) {
      const [px, py] = raw.coordinates[0][i];
      let best = Infinity;
      for (let j = 0; j + 1 < ring.length; j++) best = Math.min(best, segDist(px, py, ring[j], ring[j + 1]));
      worst = Math.max(worst, best);
    }
    window.__feats = feats;
    return { before: raw.coordinates[0].length, after: ring.length, closed: ring[0].join() === ring[ring.length - 1].join(),
             worst, all: feats.every(f => f.geometry) };
  }, RAW);
  ok('every zone got its shape', r.all);
  ok(`3,001 points became a few hundred (${r.after})`, r.after < r.before / 4, JSON.stringify(r));
  ok(`and it stays within about 350 m of the original (${(r.worst * 111).toFixed(2)} km)`, r.worst < 0.0035, r.worst);
  ok('the ring is still closed', r.closed);
  const small = await p.evaluate(() => {
    const tri = { type: 'Polygon', coordinates: [[[-97, 35], [-96.9, 35.1], [-96.8, 35], [-97, 35]]] };
    return _simplifyGeometry(tri).coordinates[0] === tri.coordinates[0];
  });
  ok('a drawn warning polygon (a handful of points) passes through untouched', small);
}

console.log('\n3. one shape per alert, casing drawn underneath by the renderer');
{
  const r = await p.evaluate(() => {
    activeLayers.flood = activeLayers.tornado = activeLayers.tstm = true;
    const feats = window.__feats;
    // The old way, for comparison: every shape built twice, full detail.
    const raw = feats.map(f => f);
    const t0 = performance.now();
    renderAlerts(feats);
    const tNew = performance.now() - t0;
    const groups = alertsLayer.getLayers();
    const main = groups[0];
    const shapes = main.getLayers();
    // Watch one redraw: the casing is stroked black, wider, just before the colour.
    const ctx = _alertsCanvas()._ctx;
    const strokes = [];
    const orig = ctx.stroke;
    ctx.stroke = function (...a) { strokes.push([this.strokeStyle, this.lineWidth]); return orig.apply(this, a); };
    _alertsCanvas()._redraw && (_alertsCanvas()._redrawBounds = null, _alertsCanvas()._redraw());
    ctx.stroke = orig;
    return { tNew, groupCount: groups.length, shapes: shapes.length, casingOpt: shapes[0].options.casing,
             strokes: strokes.slice(0, 4), ids: Object.keys(_alertLayerById).length };
  });
  ok('one shape per alert (60), not two', r.shapes === 60 && r.groupCount === 2, JSON.stringify(r));
  ok('clicks and flashing still find every alert by id', r.ids === 60, r.ids);
  ok('each outline is stroked twice: black and wider first, then its colour',
     r.strokes.length >= 2 && r.strokes[0][0] === '#000000' && r.strokes[0][1] === r.strokes[1][1] + 2 && r.strokes[1][0] !== '#000000',
     JSON.stringify(r.strokes));
  const cmp = await p.evaluate((rawGeom) => {
    // The same 60 alerts the old way: full-detail shapes, built twice.
    const feats = window.__feats.map((f, i) => ({ ...f, geometry: rawGeom }));
    const run = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
    const tOld = run(() => {
      const a = L.geoJSON({ type: 'FeatureCollection', features: feats }, { pane: 'alertsPane', renderer: _alertsCanvas(), interactive: false }).addTo(map);
      const c = L.geoJSON({ type: 'FeatureCollection', features: feats }, { pane: 'alertsPane', renderer: _alertsCanvas() }).addTo(map);
      map.removeLayer(a); map.removeLayer(c);
    });
    const tNew = run(() => renderAlerts(window.__feats));
    return { tOld, tNew };
  }, RAW);
  ok(`several times less work than the old way (${cmp.tOld.toFixed(0)} ms before, ${cmp.tNew.toFixed(0)} ms now)`,
     cmp.tNew * 3 < cmp.tOld, JSON.stringify(cmp));
}

console.log('\n4. the warning pulse sits out a gesture');
{
  const r = await p.evaluate(async () => {
    const feats = [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-97, 35], [-96.5, 35.4], [-96, 35], [-97, 35]]] },
      properties: { id: 'tw1', event: 'Tornado Warning', areaDesc: 'Somewhere', sent: new Date().toISOString(),
        expires: new Date(Date.now() + 3600e3).toISOString() } }];
    _alertFlashCfg.scope = 'all';
    renderAlerts(feats);
    const lyr = _alertLayerById.tw1;
    let n = 0;
    const orig = lyr.setStyle.bind(lyr);
    lyr.setStyle = (s) => { n++; return orig(s); };
    map.fire('movestart');
    await new Promise(res => setTimeout(res, 500));
    const during = n;
    map.fire('moveend');
    await new Promise(res => setTimeout(res, 500));
    return { during, after: n - during };
  });
  ok('no restyles while the map is moving', r.during === 0, JSON.stringify(r));
  // The pulse no longer restyles at all: a white copy fades on the
  // compositor (see _alertFlashCanvas), so there is nothing to pick back up
  // and nothing repainted per frame, moving or not.
  ok('and none afterwards either: the pulse is a CSS fade, not a restyle', r.after === 0
     && await p.evaluate(() => { const pn = map.getPane('alertFlashPane');
       return !!pn && pn.querySelectorAll('canvas').length === 1
         && getComputedStyle(pn).animationName === 'gw-alert-pulse'; }), JSON.stringify(r));
}

ok('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
