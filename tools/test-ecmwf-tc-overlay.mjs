#!/usr/bin/env node
/*
 * The ECMWF TC Probability overlay: strike probability and genesis maps
 * built by pi/ecmwf_tc_pipeline.py, coloured and drawn by the site.
 *
 *     node tools/test-ecmwf-tc-overlay.mjs
 *
 * The parsing server is faked: a manifest and greyscale maps whose pixels are
 * the percentages. Checked: the overlay row and its panel; the run's own time
 * windows as buttons; the strength, storms and window pickers ask for the
 * right map; ECMWF's colour key; the rows are put onto Mercator so a storm at
 * 15N is drawn at 15N; the Inspector reads the exact percentage; a missing
 * run says so instead of failing silently; and turning it off cleans up.
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
  ok('an overlay row', /id="op-ecmwf-tc" data-ovid="ecmwf-tc"/.test(PAGE) && /toggleOverlayPill\('ecmwf-tc'\)/.test(PAGE));
  ok('a controls panel with the three pickers and a legend',
     /id="ectc-controls"/.test(PAGE) && /id="ectc-c-hu"/.test(PAGE) && /id="ectc-s-existing"/.test(PAGE) && /class="ectc-legend"/.test(PAGE));
  ok('an info text', /'ecmwf-tc': +'ECMWF TC Probability:/.test(PAGE));
  ok('it reads the pipeline\'s manifest', /\/enscenters\/ecmwf\/latest\.json/.test(PAGE));
  ok('no em dashes in the new code or this test',
     !PAGE.slice(PAGE.indexOf('// -- ECMWF ENSEMBLE TROPICAL CYCLONE'), PAGE.indexOf('function _inspEctcRow')).includes(String.fromCharCode(0x2014))
     && !readFileSync(join(ROOT, 'tools/test-ecmwf-tc-overlay.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
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
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });

const MANIFEST = {
  model: 'ecmwf-ens', run: '20260923_00', base: '2026-09-23T00:00:00Z', members: 51, step_h: 12, out_h: 240,
  radius_km: 120, grid_deg: 0.5, bounds: [[-60, -180], [60, 180]],
  windows: [[0, 48], [0, 120], [0, 240]],
  products: {},
};
for (const c of ['td', 'ts', 'hu']) for (const sc of ['all', 'existing']) for (const w of MANIFEST.windows) {
  const key = `${c}_${sc}_${w[0]}_${w[1]}`;
  MANIFEST.products[key] = { path: `20260923_00/${key}.png`, max: 78 };
}
let PNG = null, manifestUp = true;
const asked = [];
await p.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.startsWith('http://pi.test/enscenters/ecmwf/latest.json')) {
    if (!manifestUp) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(MANIFEST), headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  if (url.startsWith('http://pi.test/enscenters/ecmwf/20260923_00/')) {
    asked.push(url.split('/').pop());
    return route.fulfill({ contentType: 'image/png', body: PNG, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);

// A 720 x 240 map (0.5 degrees, 60S to 60N) with 78% along a band at 15N
// from 70W to 50W, and 0 elsewhere. Grey, like the pipeline writes it.
PNG = Buffer.from(await p.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 720; c.height = 240;
  const x = c.getContext('2d'); const im = x.createImageData(720, 240);
  for (let j = 0; j < 240; j++) for (let i = 0; i < 720; i++) {
    const lat = 60 - (j + 0.5) * 0.5, lon = -180 + (i + 0.5) * 0.5;
    const v = (Math.abs(lat - 15) <= 1 && lon >= -70 && lon <= -50) ? 78 : 0;
    const o = (j * 720 + i) * 4;
    im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return c.toDataURL('image/png').split(',')[1];
}), 'base64');

const settle = () => p.evaluate(async () => {
  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 50)); if (_ectcLayer && _ectcGrid) break; }
  await new Promise(r => setTimeout(r, 150));
});

console.log('\n2. turning it on');
{
  await p.evaluate(() => { _hdBase = 'http://pi.test'; map.setView([15, -60], 5, { animate: false }); toggleOverlayPill('ecmwf-tc'); });
  await settle();
  const r = await p.evaluate(() => ({
    pill: document.getElementById('op-ecmwf-tc').classList.contains('active'),
    panel: getComputedStyle(document.getElementById('ectc-controls')).display,
    wins: [...document.querySelectorAll('#ectc-wins button')].map(b => b.textContent),
    activeWin: (document.querySelector('#ectc-wins button.active') || {}).textContent,
    layer: !!_ectcLayer && map.hasLayer(_ectcLayer), pane: _ectcLayer && _ectcLayer.options.pane,
    note: document.getElementById('ectc-note').textContent,
    listed: typeof _fxActiveOverlays === 'function' ? null : null,
  }));
  ok('the row lights and the panel opens', r.pill && r.panel === 'flex', JSON.stringify(r));
  ok('the run\'s own windows are the buttons, longest chosen', r.wins.join('|') === '0-2d|0-5d|0-10d' && r.activeWin === '0-10d', JSON.stringify(r.wins));
  ok('a map is on the map, in its own pane', r.layer && r.pane === 'ectcPane', JSON.stringify(r));
  ok('it asked for the tropical storm, all + genesis, 10 day map first', asked[asked.length - 1] === 'ts_all_0_240.png', asked.join(','));
  ok('the note names the run and the ensemble', /00z Sep 23 run · 51 members · within 120 km/.test(r.note), r.note);
}

console.log('\n3. the pickers');
{
  const want = async (fn, name) => {
    await p.evaluate(fn);
    await settle();
    return asked[asked.length - 1] === name;
  };
  ok('Hurricane asks for the hurricane map', await want(() => _ectcPick('cat', 'hu'), 'hu_all_0_240.png'), asked.slice(-1)[0]);
  ok('Existing asks for the existing-storms map', await want(() => _ectcPick('scope', 'existing'), 'hu_existing_0_240.png'), asked.slice(-1)[0]);
  ok('a window button asks for that window', await want(() => document.querySelector('#ectc-wins button').click(), 'hu_existing_0_48.png'), asked.slice(-1)[0]);
  const r = await p.evaluate(() => ({ hu: document.getElementById('ectc-c-hu').classList.contains('active'),
    ts: document.getElementById('ectc-c-ts').classList.contains('active'),
    ex: document.getElementById('ectc-s-existing').classList.contains('active'),
    saved: JSON.parse(localStorage.getItem('gwcfc_ectc') || '{}') }));
  ok('the buttons show what is picked', r.hu && !r.ts && r.ex, JSON.stringify(r));
  ok('and the choice is remembered', r.saved.c === 'hu' && r.saved.s === 'existing' && r.saved.w === '0_48', JSON.stringify(r.saved));
  await p.evaluate(() => { _ectcPick('cat', 'ts'); _ectcPick('scope', 'all'); _ectcPick('win', '0_240'); });
  await settle();
}

console.log('\n4. colours, placement and the Inspector');
{
  const r = await p.evaluate(() => {
    const at = (lat, lng) => _inspEctcRow({ lat, lng });
    const on = at(15, -60), off = at(30, -60), out = at(70, -60);
    // Where 15N lands in the coloured picture: Mercator rows, not equal
    // latitude rows.
    const img = _ectcLayer.getElement();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const col = Math.floor((-60 + 180) / 360 * c.width);
    let sum = 0, n = 0;
    const px = x.getImageData(col, 0, 1, c.height).data;
    for (let j = 0; j < c.height; j++) if (px[j * 4 + 3] > 0) { sum += j; n++; }
    const yN = _latToMercY(60), yS = _latToMercY(-60);
    const want = (yN - _latToMercY(15)) / (yN - yS) * c.height;
    return { on, off, out, row: n ? sum / n : -1, want, h: c.height, col78: _ectcColor(78), col4: _ectcColor(4),
             colour: [px[Math.round(sum / n) * 4], px[Math.round(sum / n) * 4 + 1], px[Math.round(sum / n) * 4 + 2]] };
  });
  ok('the Inspector reads 78% on the storm\'s path', r.on && r.on.value === '78%' && /tropical storm strike/.test(r.on.label), JSON.stringify(r.on));
  ok('and 0% away from it', r.off && r.off.value === '0%', JSON.stringify(r.off));
  ok('and says so outside the map\'s latitudes', r.out && /outside/.test(r.out.value), JSON.stringify(r.out));
  ok('ECMWF\'s key: 78% is the 70-80 blue, under 5% is nothing', r.col78 === '#3d8bff' && r.col4 === null, `${r.col78} ${r.col4}`);
  ok('the band at 15N is drawn at 15N on the Mercator map', Math.abs(r.row - r.want) < r.h * 0.01, `${r.row.toFixed(1)} vs ${r.want.toFixed(1)}`);
  ok('in that colour', r.colour.join() === '61,139,255', r.colour.join());
}

console.log('\n5. no run yet, and turning it off');
{
  manifestUp = false;
  const r = await p.evaluate(async () => {
    toggleOverlayPill('ecmwf-tc');
    const offState = { layer: !!_ectcLayer, timer: !!_ectcTimer, panel: document.getElementById('ectc-controls').style.display,
                       pill: document.getElementById('op-ecmwf-tc').classList.contains('active') };
    _ectcMan = null;
    toggleOverlayPill('ecmwf-tc');
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 50)); if (document.getElementById('ectc-note').textContent) break; }
    const note = document.getElementById('ectc-note').textContent;
    toggleOverlayPill('ecmwf-tc');
    return { offState, note };
  });
  ok('off: the map, the timer and the panel are gone', !r.offState.layer && !r.offState.timer && r.offState.panel === 'none' && !r.offState.pill, JSON.stringify(r.offState));
  ok('with no run on the parsing server, the panel says so', /No ECMWF cyclone maps/.test(r.note), r.note);
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
