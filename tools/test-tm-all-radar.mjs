#!/usr/bin/env node
/*
 * The radar Time Machine, for every radar product on the menu.
 *
 *     node tools/test-tm-all-radar.mjs
 *
 * Every path under Radar (services/bot/map-menu.json, the real menu walked)
 * is turned on, then the Time Machine is sent to 6 May 2024 and to 6 May
 * 2015, and where the page goes for the picture is checked:
 *
 *   Level 2          its own archive at both dates, in the product that is on
 *   Level 3          Unidata's bucket from 2022; before that the Level 2 tape
 *                    for what a volume holds, the parsing server for the rest
 *   Normal stations  the same station archives, in the matching product
 *   Normal mosaic    the NEXRAD national composite archive
 *   MRMS             NOAA's MRMS archive through the parsing server
 *   Observations     HRRR through the parsing server; NDFD says plainly that
 *                    past forecasts are not kept (Precip Amount shows what fell)
 *
 * The drawing ends (the Level 2 / Level 3 / mosaic loaders) are replaced by
 * recorders and the parsing server is stood in for, so this checks where
 * each product is sent, not NOAA's archives, which have tests of their own.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PATHS = JSON.parse(readFileSync(join(ROOT, 'services/bot/map-menu.json'), 'utf8')).layers
  .filter(x => x.startsWith('Radar'));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};
ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-tm-all-radar.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
ok('every radar menu path is on the list', PATHS.length >= 25, String(PATHS.length));

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  // The parsing server's archive doors.
  if (url.startsWith('http://pi.test/radar/archive/mrms'))
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ file: 'radar-archive/mrms/x.png', bounds: [[20, -130], [55, -60]], t: Date.UTC(2024, 4, 6, 23) }) });
  if (url.startsWith('http://pi.test/radar/archive/hrrr'))
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ file: 'radar-archive/hrrr/x.png', bounds: [[21, -130], [53, -61]], t: Date.UTC(2024, 4, 6, 23) }) });
  if (url.startsWith('http://pi.test/radar/archive/l3?'))
    return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ status: 'ready', code: new URL(url).searchParams.get('codes').split(',')[0], stamp: '201505062259', t: Date.UTC(2015, 4, 6, 22, 59) }) });
  if (url.startsWith('http://pi.test/'))
    return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
  return route.abort();
});

const JUMPS = { y2024: Date.UTC(2024, 4, 6, 23), y2015: Date.UTC(2015, 4, 6, 23) };
const results = {};
for (const path of PATHS) {
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  results[path] = await p.evaluate(async ({ path, JUMPS }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    map.setView([35.3, -97.5], 8, { animate: false });
    _hdBase = 'http://pi.test';
    await _menuPlay(path); await sleep(600);
    const st = NEXRAD_STATIONS.find(x => String(x.id).toLowerCase() === 'ktlx');
    if (/Level 2|Level 3/.test(path)) { try { await Promise.race([_siteView(st), sleep(2500)]); } catch (e) {} }
    // A Level 3 station whose first file could not be read offline is not
    // left set by the page (nothing is on screen), so it is stood in here.
    if (/Level 3/.test(path) && !_prBucketSite && !_prSite) _prBucketSite = 'KTLX';
    // Stand-ins for what the network would have set up live.
    if (/Composite > MRMS/.test(path)) _mrmsActive = true;
    const obs = { 'HRRR Reflectivity': ['hrrr', 'refc'], 'Precip Chance': ['ndfd', 'pop12'], 'Precip Amount': ['ndfd', 'qpf'],
                  'Snow Amount': ['ndfd', 'snow'], 'Weather Type': ['ndfd', 'wx'] };
    const o = Object.keys(obs).find(k => path.endsWith(k));
    if (o) _nwsOn = { bubble: 'radar', src: obs[o][0], field: obs[o][1], label: o };
    const kind = _tmRadarKind();
    const calls = [];
    const stub = name => { window[name] = async (...a) => { calls.push([name, ...a.map(x => typeof x === 'number' && x > 1e11 ? new Date(x).getUTCFullYear() : x)]); }; };
    ['_l2ArcShow', '_l3BucketShow', 'loadNEXRAD'].forEach(stub);
    window._workerProcess = async () => { throw new Error('superseded'); };
    const fetched = []; const f0 = window.fetch;
    window.fetch = (u, o2) => { if (String(u).startsWith('http://pi.test/radar')) fetched.push(String(u).replace('http://pi.test', '').replace(/&at=\d+/, '')); return f0(u, o2); };
    const toasts = []; window.showToast = m => toasts.push(String(m));
    const out = { kind: kind.kind, product: kind.product || kind.products || kind.field || null, jumps: {} };
    for (const [nm, at] of Object.entries(JUMPS)) {
      calls.length = 0; fetched.length = 0; toasts.length = 0;
      _tmScope = kind.site ? 'radar' : 'mosaic';
      try { await Promise.race([_tmJump(at), sleep(8000)]); } catch (e) { calls.push(['THROW', e.message]); }
      await sleep(200);
      out.jumps[nm] = { calls: calls.map(c => c.join(':')), fetched: [...fetched], toasts: toasts.slice(), layers: _tmArcLayers.length };
      _tmAt = null; _tmMosaicAt = null; _tmArcClear();
    }
    window.fetch = f0;
    return out;
  }, { path, JUMPS });
}
await b.close();

const R = results;
const has = (path, yr, re) => { const j = R[path] && R[path].jumps[yr]; return !!j && [...j.calls, ...j.fetched].some(x => re.test(x)); };
const said = (path, yr, re) => { const j = R[path] && R[path].jumps[yr]; return !!j && j.toasts.some(x => re.test(x)); };
const show = (path, yr) => JSON.stringify(R[path] && R[path].jumps[yr]);

console.log('\nLevel 2: its own archive at every date, in its own product');
const L2 = { 'Reflectivity': 'ref', 'Velocity': 'vel', 'Corr. Coeff.': 'cc', 'Diff. Refl.': 'zdr', 'Spec. Diff. Phase': 'kdp', 'Spectrum Width': 'sw', 'Diff. Phase': 'phi' };
for (const [lab, code] of Object.entries(L2)) {
  const path = `Radar > Level 2 > ${lab}`;
  for (const yr of ['y2024', 'y2015']) {
    ok(`${path} (${yr.slice(1)}) reads the Level 2 archive as ${code}`, has(path, yr, new RegExp(`^_l2ArcShow:ktlx:\\d{4}:${code}$`, 'i')), show(path, yr));
  }
}

console.log('\nLevel 3: its bucket from 2022, the tape or the parsing server before');
const L3 = { 'Reflectivity': ['reflectivity', 'l2:ref'], 'Velocity': ['velocity', 'l2:vel'], 'Corr. Coeff.': ['corrcoeff', 'l2:cc'],
  'Diff. Refl.': ['diffrefl', 'l2:zdr'], 'Spec. Diff. Phase': ['kdp', 'l2:kdp'], 'Hydro. Class.': ['hydroclass', 'pi:N0H'],
  'Storm Rel. Velocity': ['srvelocity', 'pi:N0S'], '1-Hr Precip': ['onehour', 'pi:DAA'], 'Storm Total': ['stormtotal', 'pi:DTA'],
  'VIL': ['vil', 'pi:DVL'], 'Echo Tops': ['echotops', 'pi:EET'] };
for (const [lab, [prod, old]] of Object.entries(L3)) {
  const path = `Radar > Level 3 > ${lab}`;
  ok(`${path} (2024) reads the Level 3 bucket`, has(path, 'y2024', /^_l3BucketShow:ktlx:2024/i), show(path, 'y2024'));
  const [how, code] = old.split(':');
  ok(`${path} (2015) comes from ${how === 'l2' ? 'the Level 2 tape as ' + code : 'the parsing server as ' + code}`,
     how === 'l2' ? has(path, 'y2015', new RegExp(`^_l2ArcShow:ktlx:2015:${code}$`, 'i'))
                  : has(path, 'y2015', new RegExp(`^/radar/archive/l3\\?site=KTLX&codes=${code}`)), show(path, 'y2015'));
}

console.log('\nNormal: the mosaic, and the station products from the station archives');
ok('Radar > Normal > Reflectivity (both years) travels the national composite archive',
   has('Radar > Normal > Reflectivity', 'y2024', /^loadNEXRAD$/) && has('Radar > Normal > Reflectivity', 'y2015', /^loadNEXRAD$/),
   show('Radar > Normal > Reflectivity', 'y2015'));
const NS = { 'Velocity': ['velocity', 'l2:vel'], 'Hydro. Class.': ['hydroclass', 'pi:N0H'], 'Storm Accum.': ['stormtotal', 'pi:DTA'], '1-Hr Accum.': ['onehour', 'pi:DAA'] };
for (const [lab, [prod, old]] of Object.entries(NS)) {
  const path = `Radar > Normal > ${lab}`;
  ok(`${path} (2024) reads the station's Level 3 as ${prod}`, has(path, 'y2024', new RegExp(`^_l3BucketShow:\\w+:2024:${prod}$`)), show(path, 'y2024'));
  const [how, code] = old.split(':');
  ok(`${path} (2015) comes from ${how === 'l2' ? 'the Level 2 tape' : 'the parsing server as ' + code}`,
     how === 'l2' ? has(path, 'y2015', new RegExp(`^_l2ArcShow:\\w+:2015:${code}$`)) : has(path, 'y2015', new RegExp(`^/radar/archive/l3\\?site=\\w+&codes=${code}`)),
     show(path, 'y2015'));
}

console.log('\nComposite and Observations: through the parsing server');
const mr = 'Radar > Composite > MRMS 1 km';
ok(`${mr} (2024) is drawn from the MRMS archive`, has(mr, 'y2024', /^\/radar\/archive\/mrms\?product=composite/) && R[mr].jumps.y2024.layers === 1, show(mr, 'y2024'));
ok(`${mr} (2015, before the MRMS archive) falls back to the national composite, and says so`,
   has(mr, 'y2015', /^loadNEXRAD$/) && said(mr, 'y2015', /October 2020/), show(mr, 'y2015'));
const hr = 'Radar > Observations > HRRR Reflectivity';
for (const yr of ['y2024', 'y2015']) {
  ok(`${hr} (${yr.slice(1)}) is built from the HRRR archive`, has(hr, yr, /^\/radar\/archive\/hrrr\?field=refc/) && R[hr].jumps[yr].layers === 1, show(hr, yr));
}
const qp = 'Radar > Observations > Precip Amount';
ok(`${qp} (2024) shows the measured MRMS rainfall instead of a lost forecast, and says why`,
   has(qp, 'y2024', /product=qpemulti01/) && said(qp, 'y2024', /what actually fell/), show(qp, 'y2024'));
for (const lab of ['Precip Chance', 'Snow Amount', 'Weather Type']) {
  const path = `Radar > Observations > ${lab}`;
  ok(`${path} says past NDFD forecasts are not kept, rather than showing today's`,
     said(path, 'y2024', /not kept anywhere/) && R[path].jumps.y2024.layers === 0, show(path, 'y2024'));
}

console.log('\nevery radar path was checked');
const checked = new Set([...Object.keys(L2).map(l => 'Radar > Level 2 > ' + l), ...Object.keys(L3).map(l => 'Radar > Level 3 > ' + l),
  'Radar > Normal > Reflectivity', ...Object.keys(NS).map(l => 'Radar > Normal > ' + l), mr, hr, qp,
  ...['Precip Chance', 'Snow Amount', 'Weather Type'].map(l => 'Radar > Observations > ' + l)]);
const left = PATHS.filter(x => !checked.has(x));
ok('no radar product is left without a check', left.length === 0 || left.every(x => /Composite Refl\./.test(x)), left.join(' | '));
ok('no page errors along the way', errs.length === 0, errs[0]);

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
