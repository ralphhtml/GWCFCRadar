#!/usr/bin/env node
/*
 * Every radar product for the MRRL radars, their full reach, and a broadcast
 * sweep as big as the picture.
 *
 *     node tools/test-mrrl-products.mjs
 *
 * The MRRL radars publish only Level 2, so the Level 3 products are worked
 * out from the volume (src/parse/derived.js, run in the radar worker):
 * composite reflectivity, echo tops, VIL, hydrometeor class, storm relative
 * velocity and rainfall. Checked: the math on its own (beam height, column
 * values, the classifier, the wind fit behind storm motion, rain rate); the
 * built worker turning a real-format volume (tools/mrrl_synth.py) into each
 * product; and in the page, with the parsing server faked, the Level 3 menu
 * drawing every product for an MRRL radar under the right product code, at
 * the full 2000 km reach, the Time Machine being honest about the feed's
 * short memory, and the sweep sized to what was drawn.
 */

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('\n1. the pieces');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['src/parse/derived.js', 'src/parse/radar_worker.js', 'tools/test-mrrl-products.mjs'];
  ok('no em dashes in the new code or this test',
     !files.some(f => readFileSync(join(ROOT, f), 'utf8').includes(EM)) && !PAGE.includes(EM));
  const bundle = readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8');
  ok('the built worker carries the derived products', bundle.includes('process-multi') && bundle.includes('ETOP'));
  ok('an MRRL radar is drawn to 2000 km', /const MRRL_RANGE_KM = 2000;/.test(PAGE));
  ok('and its noise is filtered, on every decode path', /noise_filter: mrrl \}/.test(PAGE)
     && /noise_filter: _isMrrlSite\(who\)/.test(PAGE) && /noise_filter: true \}/.test(PAGE));
  ok('an oversampled sweep is thinned, a NEXRAD one is not', bundle.includes('THIN_RADIALS') && bundle.includes('thinSweep'));
  ok('the unfold is applied in one pass over the sweep, not one per region',
     /const unwrap = regionTracker\.unwrapNumber;/.test(readFileSync(join(ROOT, 'src/parse/dealias.js'), 'utf8')));
  ok('a repeat decode of the same volume skips the unpacking', bundle.includes('_plainCache'));
  ok('an MRRL pill starts its volume downloading when pointed at', /if \(s\.mrrl\) \{ _mrrlWarm\(s\.id\); return; \}/.test(PAGE));
  ok('every Level 3 product has an MRRL route', ['reflectivity', 'velocity', 'corrcoeff', 'diffrefl', 'kdp',
     'srvelocity', 'hydroclass', 'hydrohybrid', 'echotops', 'vil', 'composite', 'onehour', 'stormtotal']
     .every(k => new RegExp(`\\n  ${k}: +\\{ layer: '`).test(PAGE)));
}

console.log('\n2. the math');
{
  const D = await import(pathToFileURL(join(ROOT, 'src/parse/derived.js')).href);
  ok('a 0.5 degree beam is about 2.6 km up at 150 km (four thirds earth)',
     near(D.beamHeightKm(150, 0.5), 2.62, 0.1), D.beamHeightKm(150, 0.5));
  ok('and the ground under it is a little short of the slant range', near(D.groundKm(150, 0.5), 149.9, 0.2));
  const col = [{ h: 1, z: 30 }, { h: 4, z: 55 }, { h: 9, z: 25 }, { h: 12, z: 12 }];
  ok('composite is the strongest echo in the column', D.columnValue('CREF', col) === 55);
  ok('echo top is the highest 18 dBZ, in kft', near(D.columnValue('ETOP', col), 9 * 3.28084, 1e-6));
  const vil = D.columnValue('DVIL', col);
  ok('VIL of a 55 dBZ core is a real storm number', vil > 10 && vil < 40, vil);
  ok('drizzle has no VIL', D.columnValue('DVIL', [{ h: 1, z: 15 }, { h: 3, z: 12 }]) === null);
  ok('the classifier: hail, heavy rain, light rain, graupel, snow, bugs',
     D.classify(62, 0.2, 0.93, 2) === 110 && D.classify(47, 2, 0.98, 1) === 70 && D.classify(25, 0.5, 0.99, 1) === 60
     && D.classify(45, 0, 0.97, 6) === 90 && D.classify(25, 0.2, 0.99, 6) === 40 && D.classify(15, 4, 0.5, 0.5) === 10);
  // A uniform 20 m/s westerly seen by a Doppler cut: the fit finds it, and
  // the storm motion is three quarters of it, thirty degrees to the right.
  const radials = [];
  for (let az = 0; az < 360; az += 1) {
    const v = new Float32Array(240);
    for (let g = 0; g < 240; g++) v[g] = 20 * Math.sin(az * Math.PI / 180) * Math.cos(0.5 * Math.PI / 180);
    radials.push({ az, fg: 2, gs: 0.25, v });
  }
  const m = D.estimateStormMotion({ radials, angle: 0.5 });
  const c = Math.cos(Math.PI / 6);
  ok('storm motion from a westerly is 15 m/s, turned 30 degrees right',
     near(m.u, 15 * c, 0.05) && near(m.v, -15 * 0.5, 0.05), JSON.stringify(m));
  ok('rain rate follows Z = 300 R^1.4, capped for hail', near(D.rainRate(40), 12.2, 0.2)
     && D.rainRate(70) === D.rainRate(53) && D.rainRate(5) === 0);
}

console.log('\n2b. the noise filter');
{
  const D = await import(pathToFileURL(join(ROOT, 'src/parse/derived.js')).href);
  // 400 gates of 250 m. Receiver noise: the same power at every range, so
  // dBZ = constant + 20 log10(r), with a little jitter. Rain: a real shape.
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const radial = (fn) => ({ first_gate: 2, gate_size: 0.25, moment_data: Array.from({ length: 400 }, (_, g) => fn(2 + g * 0.25)) });
  const noise = radial((r) => -30 + 20 * Math.log10(r) + (rnd() - 0.5) * 3);
  const noiseWithCell = radial((r) => (r > 50 && r < 60 ? 45 : -30 + 20 * Math.log10(r) + (rnd() - 0.5) * 3));
  const rain = radial((r) => 25 + 10 * Math.sin(r / 9) + (rnd() - 0.5) * 3);
  const thresholded = radial((r) => (r > 40 && r < 55 ? 30 : null));
  const m = D.noiseMask([noise, noiseWithCell, rain, thresholded]);
  const kept = (i, a, b) => { const r = [noise, noiseWithCell, rain, thresholded][i]; let n = 0, t = 0;
    r.moment_data.forEach((v, g) => { const km = 2 + g * 0.25; if (km < a || km > b || !Number.isFinite(v)) return; t++; if (!m[i] || !m[i][g]) n++; }); return t ? n / t : 0; };
  ok('a flat noise radial is found and all of it dropped', m[0] && kept(0, 0, 100) === 0, kept(0, 0, 100));
  ok('a real 45 dBZ cell inside a noise radial survives', kept(1, 51, 59) === 1 && kept(1, 70, 100) === 0, `${kept(1, 51, 59)} ${kept(1, 70, 100)}`);
  ok('rain is not flat noise and is left alone', m[2] === null);
  ok('a radial the radar already thresholded is left alone', m[3] === null);
  const vel = (fn) => ({ first_gate: 2, gate_size: 0.25, moment_data: Array.from({ length: 400 }, (_, g) => fn(g)) });
  const random = vel(() => (rnd() * 2 - 1) * 6.5), smooth = vel((g) => 5 * Math.sin(g / 40));
  const f1 = D.velocityNoiseFlags(random, 6.7), f2 = D.velocityNoiseFlags(smooth, 6.7);
  ok('random velocity is flagged, a smooth wind is not', f1.filter(x => x === 1).length > 350 && f2.every(x => x === 0));
  const strongRef = [{ first_gate: 2, gate_size: 0.25, moment_data: new Array(400).fill(50) }];
  ok('turbulent velocity inside a strong echo (a couplet, a hail core) is always kept',
     D.cleanVelocityNoise([random], 6.7, strongRef)[0].moment_data.every(Number.isFinite));
  const specks = [0, 1, 2].map((i) => ({ first_gate: 2, gate_size: 0.25, moment_data: new Array(400).fill(null) }));
  specks[1].moment_data[200] = 20;
  specks[1].moment_data.fill(30, 100, 140);
  const ds = D.despeckle(specks);
  ok('a lone speck goes, a real stretch of echo stays', ds[1].moment_data[200] === null && ds[1].moment_data[120] === 30);
}

console.log('\n3. the built worker, on a real-format volume');
const DIR = mkdtempSync(join(tmpdir(), 'mrrlp-'));
execFileSync('python3', [join(ROOT, 'tools/mrrl_synth.py'), join(DIR, 'BOO_'), 'BOO_', '54.0', '10.05', 'bz']);
execFileSync('python3', [join(ROOT, 'tools/mrrl_synth.py'), join(DIR, '1852'), '1852', '21.03', '-86.85']);
{
  let last = null;
  const saveLog = console.log;
  globalThis.self = { postMessage: (msg) => { last = msg; } };
  console.log = () => {};
  (0, eval)(readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8'));
  const vol = () => { const b = readFileSync(join(DIR, 'BOO_')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  const run = (layer) => { last = null; self.onmessage({ data: { type: 'process', arrayBuffer: vol(), layer, options: { range_limit_km: 2000 } } }); return last; };
  const vals = (msg) => { const out = []; if (!msg || !msg.meshData) { console.error('  (no mesh: ' + JSON.stringify(msg).slice(0, 200) + ')'); return out; } for (let i = 8; i < msg.meshData.length; i += 9) if (Number.isFinite(msg.meshData[i])) out.push(msg.meshData[i]); return out; };
  const R = {};
  for (const L of ['REF', 'CREF', 'ETOP', 'HCLS', 'ACC']) R[L] = run(L);
  last = null;
  self.onmessage({ data: { type: 'process-multi', buffers: [vol(), vol()], options: {} } });
  R.MULTI = last;
  console.log = saveLog;
  const ref = vals(R.REF), cref = vals(R.CREF), etop = vals(R.ETOP), hc = vals(R.HCLS), acc = vals(R.ACC);
  ok('composite from one tilt is that tilt: the same 35 dBZ ring', cref.length > 1000
     && cref.every(v => v === 35) && cref.length === ref.length, `${cref.length} vs ${ref.length}`);
  ok('echo tops: the beam height over the ring, well under 10 kft', etop.length > 1000
     && Math.min(...etop) > 0 && Math.max(...etop) < 10, `${Math.min(...etop)}..${Math.max(...etop)}`);
  ok('hydrometeor class without dual polarization says so, not a made-up picture',
     R.HCLS.type === 'error' && /does not send differential reflectivity/.test(R.HCLS.message)
     && JSON.stringify(R.HCLS.moments) === '["reflect"]', JSON.stringify(R.HCLS).slice(0, 160));
  const D = await import(pathToFileURL(join(ROOT, 'src/parse/derived.js')).href);
  const fiveMin = D.rainRate(35) * 5 / 60;
  ok('one volume of rain is five minutes of 35 dBZ rain', acc.length > 1000 && acc.every(v => near(v, fiveMin, 1e-3)),
     `${acc[0]} vs ${fiveMin}`);
  // (Several different scans adding up was proven on real KTLX volumes: three
  // scans, 26 minutes, up to 3 mm; too big to check in here.)
  ok('the same scan handed over twice is counted once, as five minutes', R.MULTI.type === 'result'
     && R.MULTI.metadata.accumVolumes === 1 && R.MULTI.metadata.accumMinutes === 5
     && vals(R.MULTI).every(v => near(v, D.rainRate(35) * 5 / 60, 1e-3)), JSON.stringify(R.MULTI.metadata || R.MULTI));
}

console.log('\n4. in the page');
writeFileSync(join(DIR, 'sites.json'), JSON.stringify({ sites: [
  { id: 'BOO_', lat: 54.0, lon: 10.05, height_m: 100 }, { id: '1852', lat: 21.03, lon: -86.85, height_m: 100 }] }));
const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
const NOW = Date.now();
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  const u = new URL(url);
  if (u.host === 'pi.test' && u.pathname.startsWith('/mrrl/')) {
    const h = { 'Access-Control-Allow-Origin': '*' };
    const site = u.searchParams.get('site');
    if (u.pathname === '/mrrl/sites.json') return route.fulfill({ headers: h, contentType: 'application/json', body: readFileSync(join(DIR, 'sites.json')) });
    // Two hours of volumes, five minutes apart.
    if (u.pathname === '/mrrl/list') return route.fulfill({ headers: h, contentType: 'application/json', body: JSON.stringify({ site,
      volumes: Array.from({ length: 24 }, (_, i) => ({ name: `${site}_${i}.ar2v`, t: NOW - (23 - i) * 300000, size: 1 })) }) });
    if (u.pathname === '/mrrl/vol') return route.fulfill({ headers: h, contentType: 'application/octet-stream', body: readFileSync(join(DIR, site)) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(async () => {
  const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none';
  _hdBase = 'http://pi.test';
  _buildNexradSiteMarkers(); await _mrrlLoad();
  map.setView([54, 10], 7, { animate: false });
  // Record what each draw was asked for.
  window._seen = [];
  const rm = _renderMesh, wp = _workerProcess, wm = _workerProcessMulti;
  _renderMesh = function (result, product, station) { _seen.push({ drawn: product, station }); return rm.apply(this, arguments); };
  _workerProcess = function (buf, layer, opt) { _seen.push({ layer, range: opt && opt.range_limit_km }); return wp.apply(this, arguments); };
  _workerProcessMulti = function (bufs, opt) { _seen.push({ layer: 'ACC', vols: bufs.length, range: opt && opt.range_limit_km }); return wm.apply(this, arguments); };
  window._toasts = [];
  const st = showToast; showToast = function (m) { _toasts.push(String(m)); return st.apply(this, arguments); };
});
const pick = (product, at) => p.evaluate(async ([product, at]) => {
  _seen.length = 0; _toasts.length = 0;
  _radarSource = 'l3'; _prProduct = product;
  if (at == null) await _siteView(NEXRAD_STATIONS.find(x => x.id === 'mr-boo_'));
  else await _tmStationShow('mr-boo_', product, at);
  return { seen: _seen.slice(), toasts: _toasts.slice(), bucket: _prBucketSite, overlay: !!_l3Overlay,
           time: document.getElementById('anim-time').textContent };
}, [product, at]);
{
  const want = { reflectivity: ['REF', 'ref'], composite: ['CREF', 'ncr'], echotops: ['ETOP', 'eet'] };
  for (const [prod, [layer, code]] of Object.entries(want)) {
    const r = await pick(prod);
    const w = r.seen.find(x => x.layer), d = r.seen.find(x => x.drawn);
    ok(`Level 3 ${prod} on an MRRL radar: worked out as ${layer}, drawn as ${code}, to 2000 km`,
       w && w.layer === layer && w.range === 2000 && d && d.drawn === code && d.station === 'mr-boo_' && r.overlay,
       JSON.stringify(r));
  }
  let r = await pick('onehour');
  let w = r.seen.find(x => x.layer);
  ok('1-hour rain adds up the last hour of volumes (12 of them)', w && w.layer === 'ACC' && w.vols === 12
     && r.seen.some(x => x.drawn === 'daa'), JSON.stringify(r));
  ok('and the clock says how many minutes of rain it is', /min of rain/.test(r.time), r.time);
  r = await pick('stormtotal');
  w = r.seen.find(x => x.layer);
  ok('storm total adds up every volume the feed holds', w && w.vols === 24 && r.seen.some(x => x.drawn === 'dta'), JSON.stringify(w));
  r = await pick('hydroclass');
  ok('no dual polarization: said plainly, nothing wrong drawn',
     r.toasts.some(t => t === 'BOO does not send Hydro. Class. It sends reflectivity.')
     && !r.seen.some(x => x.drawn), JSON.stringify(r.toasts));
  const menu = await p.evaluate(() => [..._l3AvailKnown('MR-BOO_') || []].sort().join(','));
  ok('the Level 3 menu offers exactly what this radar can make (reflectivity only here)',
     menu === 'composite,echotops,onehour,reflectivity,stormtotal,vil', menu);
  r = await pick('composite', NOW - 40 * 60000);
  ok('the Time Machine reads the feed at the moment asked', r.seen.some(x => x.drawn === 'ncr') && /ARCHIVE/.test(r.time), JSON.stringify(r));
  r = await pick('composite', NOW - 5 * 86400000);
  ok('and says plainly there is no older archive', r.toasts.some(t => /no older archive/.test(t)), JSON.stringify(r.toasts));
}

console.log('\n5. the broadcast sweep reaches as far as the data');
{
  const r = await p.evaluate(async () => {
    localStorage.setItem('gwcfc_sweep', '1');
    _radarSource = 'l3'; _prProduct = 'reflectivity';
    await _siteView(NEXRAD_STATIONS.find(x => x.id === 'mr-boo_'));
    _sweepSync();
    const mrrl = { site: _sweepFor, km: _sweepKmNow, px: _sweepRadiusPx(_sweepMarker.getLatLng()) };
    // What 60 km is in pixels here, the edge of the synthetic ring.
    const ll = _sweepMarker.getLatLng();
    const east = 60000 / (111320 * Math.cos(ll.lat * Math.PI / 180));
    mrrl.px60 = Math.abs(map.latLngToLayerPoint(L.latLng(ll.lat, ll.lng + east)).x - map.latLngToLayerPoint(ll).x);
    // An American radar with nothing drawn by the page yet: its product's range.
    _prOn = false; _prBucketSite = null; _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'ktlx';
    _sweepSync();
    const us = { site: _sweepFor, km: _sweepKmNow };
    currentProduct = 'vel'; _velStation = 'ktlx'; _sweepSync();
    us.vel = _sweepKmNow;
    return { mrrl, us };
  });
  ok('an MRRL radar\'s beam reaches the edge of its picture (about 60 km)',
     r.mrrl.site === 'mr-boo_' && near(r.mrrl.km, 60, 4) && near(r.mrrl.px, r.mrrl.px60, r.mrrl.px60 * 0.08), JSON.stringify(r.mrrl));
  ok('an American radar reaches 460 km, and 300 km on velocity', r.us.site === 'ktlx' && r.us.km === 460 && r.us.vel === 300,
     JSON.stringify(r.us));
}
ok('no page errors along the way', errs.length === 0, errs.join(' | '));

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
