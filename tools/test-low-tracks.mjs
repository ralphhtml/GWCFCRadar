#!/usr/bin/env node
/*
 * The Low Tracks overlay: every low pressure centre in the ensembles (one
 * line per member) and the ordinary runs, as tracks or as L markers.
 *
 *     node tools/test-low-tracks.mjs
 *
 * A fake parsing server serves the lows index and two model files in the
 * format pi/enscenters_pipeline.py writes. Checked: the pill and its panel;
 * the models the index lists become buttons; tracks are drawn on ONE canvas
 * (no Leaflet layer per track) and only the ones on screen; a track across
 * the date line is unwrapped; Centers draws an L per low at the chosen hour
 * and the hour slider moves them; the pressure filter hides weak lows;
 * switching model loads that file; the Inspector names the nearest low; the
 * canvas hides during a zoom and is redrawn after; and turning it off
 * removes everything.
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
ok('a Low Tracks pill and its panel', PAGE.includes('id="op-low-tracks"') && PAGE.includes('<div id="lows-controls">'));
ok('described for the info button', /'low-tracks':\s+'Low Tracks:/.test(PAGE));
ok('no em dashes in the overlay code or this test',
   !PAGE.slice(PAGE.indexOf('// -- LOW TRACKS'), PAGE.indexOf('function _inspLowsRow')).includes(String.fromCharCode(0x2014))
   && !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// 31 GEFS members, each with a low moving north east from Texas and a weak
// low off Florida; one Pacific track that crosses the date line (in 0-360
// longitudes, the way the pipeline can write them). GFS: one deep low.
const gefsTracks = [];
for (let m = 0; m < 31; m++) {
  gefsTracks.push({ m, p: Array.from({ length: 9 }, (_, i) => [i * 6, 30 + i * 1.2 + m * 0.03, -98 + i * 2.5, 1010 - i * 2 - (m % 9)]) });
  gefsTracks.push({ m, p: [[0, 26, -79, 1011], [6, 26.5, -78, 1010], [12, 27, -77, 1010]] });
}
gefsTracks.push({ m: 4, p: [[0, 45, 175, 990], [6, 46, 179, 988], [12, 47, 183, 986]] });
const GEFS = { model: 'gefs', label: 'GEFS ensemble', run: '20260923_00', base: '2026-09-23T00:00:00Z', kind: 'ensemble',
               members: 31, step_h: 6, out_h: 48, tracks: gefsTracks };
const GFS = { model: 'gfs', label: 'GFS', run: '20260923_06', base: '2026-09-23T06:00:00Z', kind: 'deterministic',
              members: 1, step_h: 6, out_h: 48, tracks: [{ m: 0, p: [[0, 40, -90, 996], [6, 41, -87, 992], [12, 42, -84, 985]] }] };
const INDEX = { models: {
  gefs: { label: 'GEFS ensemble', run: GEFS.run, base: GEFS.base, kind: 'ensemble', members: 31, step_h: 6, out_h: 48, path: 'lows/gefs_20260923_00.json' },
  gfs: { label: 'GFS', run: GFS.run, base: GFS.base, kind: 'deterministic', members: 1, step_h: 6, out_h: 48, path: 'lows/gfs_20260923_06.json' },
} };

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
const asked = [];
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js'))
    return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css'))
    return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (u.startsWith('http://pi.test/')) {
    asked.push(u.split('?')[0]);
    const H = { 'access-control-allow-origin': '*' };
    if (u.includes('/enscenters/lows/latest.json')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(INDEX), headers: H });
    if (u.includes('/enscenters/lows/gefs_')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(GEFS), headers: H });
    if (u.includes('/enscenters/lows/gfs_')) return r.fulfill({ contentType: 'application/json', body: JSON.stringify(GFS), headers: H });
    return r.fulfill({ status: 404, body: '' });
  }
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. on, with the ensemble');
{
  const r = await p.evaluate(async () => {
    _hdBase = 'http://pi.test';
    map.setView([33, -88], 5, { animate: false });
        toggleOverlayPill('low-tracks');
    await new Promise(res => setTimeout(res, 800));
    let lowsLayers = 0; map.eachLayer(l => { if (l.options && l.options.pane === 'lowsPane') lowsLayers++; });
    const ctrl = document.getElementById('lows-controls');
    return { shown: getComputedStyle(ctrl).display === 'flex', model: _lowsModel, n: _lowsData && _lowsData.tracks.length,
             buttons: [...document.querySelectorAll('#lows-models [data-lm]')].map(x => x.textContent + (x.classList.contains('active') ? '*' : '')),
             drawn: _lowsCanvas && _lowsCanvas._drawn, lowsLayers,
             canvases: document.querySelectorAll('.lows-canvas').length, note: document.getElementById('lows-note').textContent,
             pill: document.getElementById('op-low-tracks').classList.contains('active') };
  });
  ok('the panel opens and the pill lights', r.shown && r.pill, JSON.stringify(r));
  ok('GEFS first, both models offered as buttons', r.model === 'gefs' && r.buttons.join(',') === 'GEFS*,GFS', r.buttons.join(','));
  ok('the note names the run and the members', /GEFS ensemble/.test(r.note) && /31 members/.test(r.note) && /00z Sep 23/.test(r.note), r.note);
  ok('one canvas, not a Leaflet layer per track', r.canvases === 1 && r.lowsLayers === 0, `${r.canvases} canvases, ${r.lowsLayers} layers`);
  ok('only tracks on screen are drawn (the Pacific one is not)', r.drawn && r.drawn.lines === 62, JSON.stringify(r.drawn));
  const px = await p.evaluate(() => {
    const cv = _lowsCanvas, x = cv.getContext('2d');
    const d = x.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ok('and something is actually painted', px > 500, px);
}

console.log('\n3. across the date line');
{
  const r = await p.evaluate(async () => {
    map.setView([46, 180], 5, { animate: false });
    await new Promise(res => setTimeout(res, 300));
    const t = _lowsData.tracks.find(t => t.p.length === 3 && t.p[0][1] === 45);
    return { lons: t.p.map(q => q[2]), drawn: _lowsCanvas._drawn.lines };
  });
  ok('a Pacific track is one continuous line (175, 179, 183 as -185..)', Math.abs(r.lons[2] - r.lons[1]) < 10 && Math.abs(r.lons[1] - r.lons[0]) < 10, r.lons.join(','));
  ok('and it is drawn there', r.drawn >= 1, r.drawn);
}

console.log('\n4. Centers, the hour and the filter');
{
  const r = await p.evaluate(async () => {
    map.setView([33, -88], 5, { animate: false });
    await new Promise(res => setTimeout(res, 300));
    _lowsPick('view', 'centers');
    const at0 = _lowsCanvas._drawn.labels;
    const lbl0 = document.getElementById('lows-hour-lbl').textContent;
    _lowsPick('hour', 24);
    const at24 = _lowsCanvas._drawn.labels;
    const lbl24 = document.getElementById('lows-hour-lbl').textContent;
    _lowsPick('max', 1000);
    const deep = _lowsCanvas._drawn.labels;
    const row = _inspLowsRow({ lat: 34.8, lng: -88 });
    _lowsPick('max', 1015);
    return { at0, at24, deep, lbl0, lbl24, row };
  });
  ok('an L for every low at hour 0 (31 Texas, 31 Florida)', r.at0 === 62, r.at0);
  ok('at hour 24 the Florida lows are gone, the Texas ones moved on', r.at24 === 31, r.at24);
  ok('the slider label gives the valid time', /\+0 h · Wed 00z/.test(r.lbl0) && /\+24 h · Thu 00z/.test(r.lbl24), `${r.lbl0} | ${r.lbl24}`);
  ok('Deeper than 1000 hides the weaker members (23 of 31 reach it)', r.deep === 23, r.deep);
  ok('the Inspector names the nearest low, its pressure and member',
     /^\d{3,4}$/.test(r.row.value) && /hPa/.test(r.row.unit) && /(member|control)/.test(r.row.unit), JSON.stringify(r.row));
}

console.log('\n5. another model, a zoom, and off');
{
  const r = await p.evaluate(async () => {
    document.querySelector('#lows-models [data-lm="gfs"]').click();
    await new Promise(res => setTimeout(res, 600));
    const model = _lowsData && _lowsData.model, kind = _lowsData && _lowsData.kind;
    _lowsPick('view', 'tracks');
    const lines = _lowsCanvas._drawn.lines;
    map.fire('zoomstart');
    const hidden = _lowsCanvas.style.visibility === 'hidden';
    map.fire('moveend');
    const back = _lowsCanvas.style.visibility === '';
    toggleOverlayPill('low-tracks');
    return { model, kind, lines, hidden, back, gone: !document.querySelector('.lows-canvas') && !_lowsData,
             panel: getComputedStyle(document.getElementById('lows-controls')).display,
             saved: JSON.parse(localStorage.getItem('gwcfc_lows') || '{}') };
  });
  ok('GFS loads, one bold deterministic line', r.model === 'gfs' && r.kind === 'deterministic' && r.lines === 1, JSON.stringify(r));
  ok('the canvas hides for a zoom and comes back after', r.hidden && r.back);
  ok('off removes the canvas, the data and the panel', r.gone && r.panel === 'none', JSON.stringify(r));
  ok('the model and view are remembered', r.saved.m === 'gfs' && r.saved.v === 'tracks', JSON.stringify(r.saved));
  ok('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
