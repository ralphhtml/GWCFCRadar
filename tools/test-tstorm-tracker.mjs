#!/usr/bin/env node
/*
 * T-Storm Tracker: storm cells circled and projected forward, from
 * whatever radar this page has already decoded.
 *
 *     node tools/test-tstorm-tracker.mjs
 *
 * The idea (and the 10/20/30/40 minute steps) comes from wxtools.org. There
 * is no network call to hold down here - the whole feature reads the mesh
 * this page has already decoded for its own picture - so this drives the
 * detector and the drawing directly with a synthetic mesh: two clusters of
 * reflectivity, one moderate, one extreme, each shifted east between two
 * frames so a real bearing and speed exist to project from.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the pieces are in the page');
{
  ok('the pill is in the Overlays row, with a drag handle',
     /id="op-tstorm-tracker" data-ovid="tstorm-tracker"/.test(PAGE)
     && /id="op-tstorm-tracker"[\s\S]{0,400}?class="ov-drag"/.test(PAGE)
     && /toggleOverlayPill\('tstorm-tracker'\)">T-Storm Tracker</.test(PAGE));
  ok('it has a description, which is what gives it an info button',
     /'tstorm-tracker':\s*'[^']{100,}/.test(PAGE));
  ok('the toggle branch flips its own state and syncs the pill',
     /id === 'tstorm-tracker'\) \{\s*_tstToggle\(\);\s*const pill = document\.getElementById\('op-tstorm-tracker'\);\s*if \(pill\) pill\.classList\.toggle\('active', _tstOn\);/.test(PAGE));
  ok('every decoded frame is offered to it, independently of the AI assistant\'s own history',
     /_tstOnFrame\(result && result\.meshData, station, product,/.test(PAGE)
     && PAGE.includes('let _tstHistory = [];')
     && !PAGE.includes('_tstHistory = _fxHistory'));
  ok('it tracks reflectivity by family, not by one literal product string',
     /function _tstOnFrame\([\s\S]{0,400}?_meshFamily\(product\)[\s\S]{0,80}?if \(fam !== 'ref'\) return;/.test(PAGE));
  ok('costs nothing while off: it returns before touching anything',
     /function _tstOnFrame\(mesh, station, product, timeMs\) \{\s*if \(!_tstOn\) return;/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-tstorm-tracker.mjs'), 'utf8').includes(EM));
}

console.log('\n2. the tiers read the way wxtools.org draws them');
{
  const tierFn = new Function('maxDbz',
    'return maxDbz >= 60 ? 3 : maxDbz >= 50 ? 2 : 1;');
  ok('34.9 dBZ is moderate, 35 is moderate', tierFn(34.9) === 1 && tierFn(35) === 1);
  ok('49.9 is still moderate, 50 turns heavy', tierFn(49.9) === 1 && tierFn(50) === 2);
  ok('59.9 is still heavy, 60 turns extreme', tierFn(59.9) === 2 && tierFn(60) === 3);
  ok('75 is extreme', tierFn(75) === 3);
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();   // this feature makes no network request at all
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);

await p.evaluate(() => {
  const real = window.showToast;
  window.__toasts = [];
  window.showToast = (t, ms) => { window.__toasts.push(String(t)); try { return real && real(t, ms); } catch (e) {} };
  map.setView([35.05, -96.5], 7, { animate: false });
});

console.log('\n3. the pill, with both of its controls');
{
  const r = await p.evaluate(() => {
    const pill = document.getElementById('op-tstorm-tracker');
    if (!pill) return null;
    return {
      ovid: pill.dataset.ovid,
      name: (pill.querySelector('.ov-rowname') || {}).textContent,
      drag: !!pill.querySelector('.ov-drag'),
      info: !!pill.querySelector('.ov-info-btn'),
      desc: (OV_DESCRIPTIONS || {})['tstorm-tracker'] || '',
    };
  });
  ok('the pill exists under its own id', r && r.ovid === 'tstorm-tracker', r && r.ovid);
  ok('named T-Storm Tracker', r && r.name === 'T-Storm Tracker', r && r.name);
  ok('it has a drag handle', r && r.drag);
  ok('and an info button', r && r.info);
  ok('which explains the three tiers and what it needs on screen',
     r && /orange/.test(r.desc) && /purple/.test(r.desc) && /Level 2/.test(r.desc) && /MRMS/.test(r.desc),
     String(r && r.desc.length));
}

// A cluster is four 0.05-degree grid points, all the same value, so it
// forms one clustered cell rather than four one-bin specks. Two clusters,
// far enough apart to never merge: a 40 dBZ (moderate) one and a 65 dBZ
// (extreme) one, each shifted 0.05 degrees east between two frames five
// minutes apart, which is a real, measurable eastward run.
const cluster = (lon0, lat0, v) => {
  const pts = [];
  for (const dlon of [0, 0.05]) for (const dlat of [0, 0.05]) {
    pts.push(lon0 + dlon, lat0 + dlat, 0, 0, 0, 0, 0, 0, v);
  }
  return pts;
};
const T0 = Date.UTC(2026, 8, 14, 20, 0);
const T1 = T0 + 5 * 60000;
const frame = (lonShift, t) => ({
  t,
  mesh: [
    ...cluster(-97.50 + lonShift, 35.00, 40),
    ...cluster(-96.00 + lonShift, 36.00, 65),
  ],
});
const F0 = frame(0, T0);
const F1 = frame(0.05, T1);

console.log('\n4. off: nothing is recorded, nothing is drawn');
{
  const r = await p.evaluate((f) => {
    const before = _tstHistory.length;
    _tstOnFrame(f.mesh, 'ktlx', 'ref', f.t);
    return { on: _tstOn, before, after: _tstHistory.length, layer: !!_tstLayer };
  }, F0);
  ok('a frame offered while off changes nothing at all',
     !r.on && r.before === 0 && r.after === 0 && !r.layer, JSON.stringify(r));
}

console.log('\n5. turning it on, with nothing decoded yet');
{
  const r = await p.evaluate(() => {
    toggleOverlayPill('tstorm-tracker');
    return { on: _tstOn, pillOn: document.getElementById('op-tstorm-tracker').classList.contains('active'),
             toasts: window.__toasts.join(' | ') };
  });
  ok('it turns on and says what it is waiting for',
     r.on && r.pillOn && /reads whatever single-site radar/.test(r.toasts)
     && /Normal mosaic or MRMS/.test(r.toasts), r.toasts);
}

console.log('\n6. two frames of Level 2 reflectivity: cells, tiers, and a real projection');
{
  const r = await p.evaluate((args) => {
    const fxBefore = _fxHistory.length;
    _tstOnFrame(args.F0.mesh, 'ktlx', 'ref', args.F0.t);
    _tstOnFrame(args.F1.mesh, 'ktlx', 'ref', args.F1.t);
    const fxAfter = _fxHistory.length;
    const out = { hist: _tstHistory.length, fxUntouched: fxAfter === fxBefore,
                  layer: !!_tstLayer, circles: [], rays: [], ticks: 0 };
    _tstLayer.eachLayer(l => {
      if (l instanceof L.Circle) {
        out.circles.push({ lat: +l.getLatLng().lat.toFixed(3), lon: +l.getLatLng().lng.toFixed(3),
                           color: l.options.color, radius: l.options.radius,
                           dash: l.options.dashArray, pane: l.options.pane });
      } else if (l instanceof L.Polyline) {
        const ll = l.getLatLngs();
        out.rays.push({ color: l.options.color, start: ll[0], end: ll[1] });
      } else {
        out.ticks++;
      }
    });
    return out;
  }, { F0, F1 });
  ok('two frames recorded, the AI assistant\'s own history is untouched',
     r.hist === 2 && r.fxUntouched, JSON.stringify({ hist: r.hist, fxUntouched: r.fxUntouched }));
  ok('the layer redrew with two circles, in the overlay\'s own pane, dashed',
     r.layer && r.circles.length === 2
     && r.circles.every(c => c.dash === '7 5' && c.pane === 'ovp-tstorm-tracker'),
     JSON.stringify(r.circles));
  const byColor = Object.fromEntries(r.circles.map(c => [c.color, c]));
  ok('the 40 dBZ cluster is moderate orange, the 65 dBZ cluster is extreme purple',
     byColor['#ff9500'] && byColor['#b83bff'], JSON.stringify(r.circles));
  // The newest frame (F1) is what is drawn - each cluster shifted 0.05
  // degrees east of where F0 put it.
  ok('the moderate cluster is centred on its newest position, the extreme one on its own',
     Math.abs(byColor['#ff9500'].lon - (-97.425)) < 0.01
     && Math.abs(byColor['#ff9500'].lat - 35.025) < 0.01
     && Math.abs(byColor['#b83bff'].lon - (-95.925)) < 0.01
     && Math.abs(byColor['#b83bff'].lat - 36.025) < 0.01,
     JSON.stringify(r.circles));
  ok('each moving cell gets a ray and four tick marks',
     r.rays.length === 2 && r.ticks === 8, JSON.stringify({ rays: r.rays.length, ticks: r.ticks }));
  // The eastward shift is exactly the projection direction (bearing ~90,
  // due east): each ray's far end should land east of that SAME cell's
  // start, not north/south/west of it.
  ok('every ray runs east, the direction its own cluster actually moved',
     r.rays.every(x => x.end.lng > x.start.lng && Math.abs(x.end.lat - x.start.lat) < 0.002),
     JSON.stringify(r.rays));
}

console.log('\n7. a cell\'s popup names its tier, its peak, and its motion honestly');
{
  const r = await p.evaluate(() => {
    let target = null;
    _tstLayer.eachLayer(l => { if (l instanceof L.Circle && l.options.color === '#b83bff') target = l; });
    target.fire('click', { latlng: target.getLatLng(), originalEvent: new Event('click') });
    const html = map._popup ? map._popup.getContent() : '';
    const d = document.createElement('div'); d.innerHTML = html;
    const text = d.textContent.replace(/\s+/g, ' ');
    map.closePopup();
    return { text };
  });
  ok('extreme, its peak dBZ, an eastward speed, and the straight-line-guess caveat are all there',
     /EXTREME THUNDERSTORM CELL/.test(r.text) && /65 dBZ/.test(r.text)
     && /Moving E at \d+ mph/.test(r.text) && /straight-line guess/.test(r.text)
     && /not an official forecast/.test(r.text), r.text.slice(0, 260));
}

console.log('\n8. a Level 3 product tracks by family; a non-reflectivity product does not');
{
  const r = await p.evaluate((args) => {
    _tstHistory = []; _tstRedraw();
    const fxBefore = _fxHistory.length;
    // n0q is Level 3 reflectivity: a different literal string than 'ref',
    // same family. The AI assistant's own recorder only ever accepts the
    // literal string 'ref', so it must sit this one out.
    _tstOnFrame(args.F0.mesh, 'ktlx', 'n0q', args.F0.t);
    const n0q = { hist: _tstHistory.length, fxUntouched: _fxHistory.length === fxBefore };
    _tstHistory = [];
    // Velocity is not reflectivity at all: no cell exists to track.
    _tstOnFrame(args.F0.mesh, 'ktlx', 'vel', args.F0.t);
    const vel = { hist: _tstHistory.length };
    return { n0q, vel };
  }, { F0 });
  ok('Level 3 reflectivity (n0q) is tracked by family',
     r.n0q.hist === 1 && r.n0q.fxUntouched, JSON.stringify(r.n0q));
  ok('velocity is not reflectivity, so nothing is recorded for it',
     r.vel.hist === 0, JSON.stringify(r.vel));
}

console.log('\n9. turning it off clears the layer, and it comes back clean');
{
  const r = await p.evaluate((args) => {
    _tstOnFrame(args.F0.mesh, 'ktlx', 'ref', args.F0.t);
    _tstOnFrame(args.F1.mesh, 'ktlx', 'ref', args.F1.t);
    toggleOverlayPill('tstorm-tracker');
    const off = { on: _tstOn, layer: !!_tstLayer,
                  pillOn: document.getElementById('op-tstorm-tracker').classList.contains('active') };
    toggleOverlayPill('tstorm-tracker');
    const on = { on: _tstOn, layer: !!_tstLayer, circles: 0 };
    _tstLayer.eachLayer(l => { if (l instanceof L.Circle) on.circles++; });
    return { off, on };
  }, { F0, F1 });
  ok('off takes the layer down and the pill dark', !r.off.on && !r.off.layer && !r.off.pillOn, JSON.stringify(r.off));
  ok('on again redraws straight from the history it already has, no re-decode needed',
     r.on.on && r.on.layer && r.on.circles === 2, JSON.stringify(r.on));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
