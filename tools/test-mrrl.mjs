#!/usr/bin/env node
/*
 * The MRRL radar network: radars around the world as Level 2 pills, read
 * through the parsing server (pi/mrrl.py, serve.py's /mrrl doors).
 *
 *     node tools/test-mrrl.mjs
 *
 * With the parsing server faked and two small real-format volumes built by
 * tools/mrrl_synth.py (one bzip2, one plain, both with MRRL-style names the
 * decoder used to throw away), checked: the pills arrive, violet, named;
 * tapping one switches to Level 2 and draws it around the right place; the
 * custom radar colours and the value filter apply exactly as they do on the
 * American radars; playback gets several volumes; Radar 3D's whole-volume
 * decode works; and the American-only helpers never pick an MRRL radar.
 */

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the pieces');
{
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- THE MRRL RADAR NETWORK'), b = PAGE.indexOf('async function _fetchVolumeDirect(');
  ok('the module is in the page', a > 0 && b > a);
  ok('no em dashes in it, in mrrl.py or in this test', !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'pi/mrrl.py'), 'utf8').includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-mrrl.mjs'), 'utf8').includes(EM));
  const rec = readFileSync(join(ROOT, 'src/parse/level2/src/classes/Level2Record-31.js'), 'utf8');
  ok('the decoder takes radar ids that are not four capitals', /\[A-Za-z0-9_\]\{4\}/.test(rec));
  ok('and the built worker carries that', /\[A-Za-z0-9_\]\{4\}/.test(readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8')));
  ok('MRRL is credited', /MRRL radar feed/.test(PAGE));
}

const DIR = mkdtempSync(join(tmpdir(), 'mrrl-'));
execFileSync('python3', [join(ROOT, 'tools/mrrl_synth.py'), join(DIR, 'BOO_'), 'BOO_', '54.0', '10.05', 'bz']);
execFileSync('python3', [join(ROOT, 'tools/mrrl_synth.py'), join(DIR, '1852'), '1852', '21.03', '-86.85']);
writeFileSync(join(DIR, 'sites.json'), JSON.stringify({ sites: [
  { id: 'BOO_', lat: 54.0, lon: 10.05, height_m: 100 }, { id: '1852', lat: 21.03, lon: -86.85, height_m: 100 },
  { id: '../x', lat: 1, lon: 1 }] }));

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
const asked = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  const u = new URL(url);
  if (u.host === 'pi.test' && u.pathname.startsWith('/mrrl/')) {
    asked.push(u.pathname + u.search);
    const h = { 'Access-Control-Allow-Origin': '*' };
    const site = u.searchParams.get('site');
    if (u.pathname === '/mrrl/sites.json') return route.fulfill({ headers: h, contentType: 'application/json', body: readFileSync(join(DIR, 'sites.json')) });
    if (u.pathname === '/mrrl/list') return route.fulfill({ headers: h, contentType: 'application/json', body: JSON.stringify({ site,
      volumes: [0, 1, 2].map(i => ({ name: `${site}_2026092415${i}000.ar2v`, t: 1790262000000 + i * 300000, size: 1 })) }) });
    if (u.pathname === '/mrrl/vol') return route.fulfill({ headers: h, contentType: 'application/octet-stream', body: readFileSync(join(DIR, site)) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; });

console.log('\n2. the pills');
{
  const r = await p.evaluate(async () => {
    _buildNexradSiteMarkers(); await _mrrlLoad(); showNexradSites();
    map.setView([54, 10], 7, { animate: false });
    await new Promise(res => setTimeout(res, 300));
    const el = document.getElementById('nxlbl-mr-boo_');
    return { ids: NEXRAD_STATIONS.filter(s => s.mrrl).map(s => s.id + ':' + s.mrrl),
      label: el && el.textContent, violet: el && el.classList.contains('mrrl'), title: el && el.title,
      nearest: _nearestStation(54, 10), ai: _aiNearestStation(54, 10).id, cm: _cmNearestStation(54, 10) && _cmNearestStation(54, 10).id };
  });
  ok('every placed MRRL radar joins the pills, and a bad code is refused', r.ids.join(',') === 'mr-boo_:BOO_,mr-1852:1852', r.ids.join(','));
  ok('a violet pill, named without its padding', r.violet && r.label === 'BOO' && /MRRL radar BOO_/.test(r.title), JSON.stringify(r));
  ok('the American-only helpers never pick one', /^k/.test(r.nearest) && /^k/.test(r.ai) && /^k/.test(r.cm), JSON.stringify(r));
}

console.log('\n3. tapping one draws its own Level 2, around the right place');
const show = (code) => p.evaluate(async (code) => {
  const s = NEXRAD_STATIONS.find(x => x.mrrl === code);
  currentProduct = 'ref'; _radarSource = 'normal';
  await _siteView(s);
  for (let i = 0; i < 80; i++) { if (_l3Overlay && _l3Station === s.id && !_l2Loading) break; await new Promise(res => setTimeout(res, 200)); }
  const bb = _l3Overlay && _l3Overlay.getBounds();
  return { src: _radarSource, st: _l3Station, c: bb ? [bb.getCenter().lat, bb.getCenter().lng] : null,
    time: document.getElementById('anim-time').textContent };
}, code);
{
  let r = await show('BOO_');
  ok('switches to Level 2 by itself', r.src === 'l2' && r.st === 'mr-boo_', JSON.stringify(r));
  ok('the bzip2 volume is drawn around Boostedt', r.c && Math.abs(r.c[0] - 54) < 0.3 && Math.abs(r.c[1] - 10.05) < 0.3, JSON.stringify(r.c));
  ok('and the time line names it as MRRL', /MRRL BOO/.test(r.time), r.time);
  r = await show('1852');
  ok('the plain volume of a radar named 1852 draws around Cancun', r.c && Math.abs(r.c[0] - 21.03) < 0.3 && Math.abs(r.c[1] + 86.85) < 0.3, JSON.stringify(r.c));
  ok('volumes were asked of the parsing server by name', asked.some(a => /^\/mrrl\/vol\?site=1852&name=1852_/.test(a)), asked.slice(-3).join(' '));
}

console.log('\n4. custom radar colours and the value filter');
{
  const r = await p.evaluate(async () => {
    const buf = await _fetchVolumeDirect('mr-boo_');
    const result = await _workerProcess(buf, 'REF');
    const paint = async () => {
      const img = _meshToImage(result, 'ref');
      if (!img) return { n: 0 };
      const im = new Image(); im.src = img.url; await im.decode();
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const ctx = cv.getContext('2d'); ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, mag = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 0) { n++; if (d[k] > 200 && d[k + 1] < 60 && d[k + 2] > 200) mag++; }
      return { n, mag };
    };
    const saveC = _fxColors.ref, saveF = _fxFilter.ref;
    const plain = await paint();
    _fxColors.ref = { on: true, stops: [{ v: -30, c: '#ff00ff' }, { v: 95, c: '#ff00ff' }] };
    const custom = await paint();
    _fxColors.ref = saveC;
    _fxFilter.ref = { on: true, min: 40, max: 80 };
    const filtered = await paint();
    _fxFilter.ref = { on: true, min: 30, max: 40 };
    const kept = await paint();
    _fxFilter.ref = saveF;
    return { plain, custom, filtered, kept };
  });
  ok('the ring is drawn', r.plain.n > 1000, JSON.stringify(r.plain));
  ok('custom colours paint it (all magenta here)', r.custom.n > 1000 && r.custom.mag / r.custom.n > 0.9, JSON.stringify(r.custom));
  ok('a value filter of 40 to 80 dBZ hides the 35 dBZ ring', r.filtered.n < r.plain.n * 0.05, JSON.stringify(r.filtered));
  ok('and 30 to 40 dBZ keeps it', r.kept.n > r.plain.n * 0.8, JSON.stringify(r.kept));
}

console.log('\n5. playback and Radar 3D');
{
  const r = await p.evaluate(async () => {
    const recent = await _fetchRecentVolumes('mr-boo_', 3);
    const back = await _fetchRecentVolumes('mr-boo_', 2, undefined, 1);
    const whole = await _fetchVolumeDirect('mr-1852', 64 * 1024 * 1024, true);
    const head = new TextDecoder().decode(new Uint8Array(whole).slice(0, 4));
    const cuts = await _workerProcess(whole, 'REF', { elevations: 'distinct' });
    return { recent: recent.length, back: back.length, head,
      sweeps: (cuts.sweeps || []).length, where: cuts.sweeps && cuts.sweeps[0] && cuts.sweeps[0].bounds };
  });
  ok('playback gets the newest volumes', r.recent === 3 && r.back === 2, JSON.stringify(r));
  ok('Radar 3D gets the whole volume and decodes its cuts', r.head === 'AR2V' && r.sweeps >= 1, JSON.stringify(r));
  const pick = await p.evaluate(() => { _r3dZone = { lat: 21.03, lng: -86.85 }; const r = _r3dNearestStation(21.03, -86.85); return r && r.id; });
  ok('a Radar 3D box near Cancun is served by the MRRL radar there', pick === 'mr-1852', String(pick));
  const rc = await p.evaluate(() => { currentProduct = 'ref'; _radarSource = 'normal'; return JSON.stringify(_rcPlan('mr-boo_', null)); });
  ok('a radar-compare pane of an MRRL radar reads its Level 2 in any mode', rc === '{"kind":"mesh-l2","product":"ref"}', rc);
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
