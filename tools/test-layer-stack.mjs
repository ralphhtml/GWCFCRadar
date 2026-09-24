#!/usr/bin/env node
/*
 * Model Layer Stack: up to four model layers at once, model chosen per layer.
 *
 *     node tools/test-layer-stack.mjs
 *
 * Two runs built by the real pipeline: a five member GEFS from 12z and a
 * single GFS run from 18z, so their forecast hours line up only at shared
 * valid times. Checked: each layer draws its own model and field, contours
 * come out where they should with the chosen colour and dash, the top of the
 * list draws on top, a layer with nothing at the chosen valid time says so
 * and leaves the map, the hover readout reads every layer, and there are at
 * most four.
 */

import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};
{
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- MODEL LAYER STACK'), b = PAGE.indexOf('// -- ENSEMBLE MODELS ----');
  ok('no em dashes in the new code or this test', a > 0 && b > a && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-layer-stack.mjs'), 'utf8').includes(EM));
}

const DATA = mkdtempSync(join(tmpdir(), 'gwcfc-ensl-'));
execFileSync('python3', ['-c', `
import sys, numpy as np
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'pi'))})
import ens_fields_pipeline as ef
tl, tn = ef.target()
LA = np.repeat(tl[:, None], len(tn), axis=1)
def fake(mem, fhr):
    if fhr > 12: return None
    k = int(mem[-2:])
    return ({"t2m": np.full(LA.shape, (50 + 10 * k - 32) * 5 / 9 + 273.15), "gh500": None, "h500": (5400 + 5 * (LA - 20)) * 10 / 10 * 10 / 10 * 1.0 + 100 * k,
             "u10": np.zeros(LA.shape), "v10": np.zeros(LA.shape)}, {})
ef.ENSEMBLES["gefs"] = dict(ef.ENSEMBLES["gefs"], members=["gec00", "gep01", "gep02", "gep03", "gep04"], steps=[6, 12, 18])
ef.ENSEMBLES["gfs"] = dict(ef.ENSEMBLES["gfs"], steps=[6, 12, 18])
def clean(fetch):
    def f(mem, fhr):
        r = fetch(mem, fhr)
        if r: r[0].pop("gh500", None)
        return r
    return f
ef.build("gefs", "20260924", "12", fetch=clean(fake), workers=2)
ef.build("gfs", "20260924", "18", fetch=clean(fake), workers=1)
`], { env: { ...process.env, GWCFC_DATA: DATA }, stdio: 'pipe' });

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.startsWith('http://pi.test/ens/')) {
    const path = new URL(url).pathname.slice(1);
    try { return route.fulfill({ status: 200, contentType: path.endsWith('.json') ? 'application/json' : 'application/gzip', body: readFileSync(join(DATA, path)) }); }
    catch (e) { return route.fulfill({ status: 404, body: 'no' }); }
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; map.setView([38, -95], 4, { animate: false }); });

console.log('\n1. opening');
{
  await p.evaluate(() => { toggleEnsembleModelsSub(); document.getElementById('sub-ens-stack').click(); });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({ open: _enslPanelIsOpen(), n: _ensl.layers.length, times: _ensl.times.map(t => new Date(t).toISOString().slice(8, 13)),
    models: [...document.querySelectorAll('#ensl-panel [data-k="model"]')[0].options].map(o => o.textContent) }));
  ok('opens with two layers from Models > Ensemble Models', r.open && r.n === 2, JSON.stringify(r));
  ok('every run the parsing server has is on offer, per layer', r.models.join() === 'GEFS,GFS', r.models.join());
  ok('the time slider walks valid times across both runs', r.times.join() === '24T18,25T00,25T06', r.times.join());
}

console.log('\n2. two models on one map at one valid time');
{
  await p.evaluate(() => {
    _ensl.layers = [
      Object.assign(_enslNewLayer(1), { model: 'gfs', stat: 'member', field: 'h500', draw: 'contour', line: 'dashed', color: '#ff3030', interval: 6 }),
      Object.assign(_enslNewLayer(0), { model: 'gefs', stat: 'mean', field: 't2m', draw: 'fill', opacity: 0.6 }),
    ];
    _ensl.t = 1; _ensl.q('time').value = 1; _enslTimeLabel(); _enslUi();
  });
  await p.evaluate(() => _enslRender());
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => {
    const [top, bottom] = _ensl.layers;
    const pane = map.getPane('modelPane');
    const imgs = [...pane.querySelectorAll('img')];
    return { top: !!(top.layer && map.hasLayer(top.layer)), bottom: !!(bottom.layer && map.hasLayer(bottom.layer)),
      order: imgs.indexOf(top.layer.getElement()) > imgs.indexOf(bottom.layer.getElement()),
      mean: bottom.values[35 * 141 + 70], h500: top.values[0], alert: _ensl.q('alert').textContent,
      when: _ensl.q('when').textContent, opacity: +getComputedStyle(bottom.layer.getElement()).opacity };
  });
  ok('both layers are on the map', r.top && r.bottom, JSON.stringify(r));
  ok('the top of the list draws on top', r.order);
  ok('the GEFS layer is the GEFS mean, the GFS layer the GFS run', Math.abs(r.mean - 70) < 0.06 && Math.abs(r.h500 - 540) < 0.1, JSON.stringify(r));
  ok('each layer keeps its own opacity', Math.abs(r.opacity - 0.6) < 0.01, r.opacity);
  ok('both at 00z on the 25th', r.when === 'valid 09-25 00Z' && r.alert === '', JSON.stringify(r));
  const c = await p.evaluate(() => {
    const g = _ensl.layers[0].grid, segs = _enslContours(_ensl.layers[0].values, g, 6);
    const levels = [...new Set(segs.map(s => s[4]))];
    // Every segment of the 546 contour sits at the latitude where the field is 546.
    const at546 = segs.filter(s => s[4] === 546).map(s => g.s + s[1] * g.d);
    return { levels: levels.length, first: levels[0], lat546: at546.length ? [Math.min(...at546), Math.max(...at546)] : null };
  });
  ok('contours every 6 dam, where the field crosses each value', c.first === 540 && c.levels === 3 && c.lat546 && Math.abs(c.lat546[0] - 32) < 0.01 && Math.abs(c.lat546[1] - 32) < 0.01, JSON.stringify(c));
  const px = await p.evaluate(async () => {
    const img = new Image(); img.src = _ensl.layers[0].layer._url; await img.decode();
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let red = 0, other = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) red++; else if (!(d[i] < 40 && d[i + 1] < 40)) other++; }
    return { red, other };
  });
  ok('the contour layer is lines in its own colour, nothing filled', px.red > 2000 && px.other < px.red, JSON.stringify(px));
}

console.log('\n3. a valid time one model does not have');
{
  await p.evaluate(() => _ensl.q('tprev').click());
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => ({ alert: _ensl.q('alert').textContent, gfs: !!_ensl.layers[0].layer, gefs: !!_ensl.layers[1].layer }));
  ok('says which layer has nothing then, and takes it off', /Layer 1: GFS has no 500 mb height at this time/.test(r.alert) && !r.gfs && r.gefs, JSON.stringify(r));
  await p.evaluate(() => _ensl.q('tnext').click());
  await p.waitForTimeout(600);
  const read = await p.evaluate(() => { map.fire('mousemove', { latlng: L.latLng(32, -95) }); return _ensl.q('read').textContent; });
  ok('hover reads every layer', read === '1: 546  2: 70', read);
}

console.log('\n4. per-layer controls');
{
  await p.evaluate(() => { const s = document.querySelectorAll('#ensl-panel [data-k="stat"]')[1]; s.value = 'member'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(500);
  await p.evaluate(() => { const s = document.querySelector('#ensl-panel .ensl-layer[data-i="1"] [data-k="member"]'); s.value = '3'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(500);
  ok('a layer can be one member', Math.abs((await p.evaluate(() => _ensl.layers[1].values[5000])) - 80) < 0.06);
  await p.evaluate(() => { document.querySelector('#ensl-panel .ensl-layer[data-i="1"] [data-k="up"]').click(); });
  await p.waitForTimeout(500);
  ok('layers can be reordered', await p.evaluate(() => _ensl.layers[0].model === 'gefs'));
  for (let k = 0; k < 3; k++) await p.evaluate(() => _ensl.q('add').click());
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => ({ n: _ensl.layers.length, disabled: _ensl.q('add').disabled }));
  ok('four layers at most', r.n === 4 && r.disabled, JSON.stringify(r));
  await p.evaluate(() => _ensl.q('big').click());
  await p.waitForTimeout(300);
  await p.screenshot({ path: process.env.SHOT || '/tmp/layer-stack.png' });
  await p.evaluate(() => _ensl.q('x').click());
  ok('closing takes every layer off', await p.evaluate(() => _ensl.layers.every(y => !y.layer)));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
