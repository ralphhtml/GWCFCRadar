#!/usr/bin/env node
/*
 * Ensemble Explorer: every member of an ensemble, one field at a time.
 *
 *     node tools/test-ensemble-explorer.mjs
 *
 * The member grids are built by the real pipeline code (pi/ens_fields_pipeline.py)
 * from made-up members whose answers are known: five members, member k with
 * 2 m temperature 50 + 10k F, rain 0.5k in, CAPE 500k and rain or snow by
 * turns. Then the panel is checked: member stepping keeps the hour, mean,
 * median, spread and normalised spread come out right, chance maps with AND
 * and OR count the right members, presets fill the conditions, the postage
 * stamps pick a member, and the map picture and hover readout follow along.
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
  const a = PAGE.indexOf('// -- ENSEMBLE EXPLORER'), b = PAGE.indexOf('// -- ENSEMBLE MODELS ----');
  ok('no em dashes in the new code or this test', a > 0 && b > a && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-ensemble-explorer.mjs'), 'utf8').includes(EM));
}

// The fixture, built by the pipeline itself.
const DATA = mkdtempSync(join(tmpdir(), 'gwcfc-ensx-'));
execFileSync('python3', ['-c', `
import sys, numpy as np
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'pi'))})
import ens_fields_pipeline as ef
tl, tn = ef.target()
shape = (len(tl), len(tn))
def fake(mem, fhr):
    if fhr > 12: return None
    k = int(mem[-2:])
    return ({"t2m": np.full(shape, (50 + 10 * k - 32) * 5 / 9 + 273.15), "u10": np.full(shape, 2.0 + k), "v10": np.zeros(shape),
             "tp": np.full(shape, 25.4 * 0.5 * k), "cape": np.full(shape, 500.0 * k),
             "crain": np.full(shape, 1.0 if k % 2 == 0 else 0.0), "csnow": np.full(shape, 1.0 if k % 2 else 0.0)},
            {"tp_start": 0, "tp_units_m": False})
ef.ENSEMBLES["gefs"] = dict(ef.ENSEMBLES["gefs"], members=["gec00", "gep01", "gep02", "gep03", "gep04"], steps=[6, 12, 18])
ef.build("gefs", "20260924", "12", fetch=fake, workers=2)
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
const asked = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.startsWith('http://pi.test/ens/')) {
    const path = new URL(url).pathname.slice(1);
    asked.push(path);
    try {
      return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: path.endsWith('.json') ? 'application/json' : 'application/gzip', body: readFileSync(join(DATA, path)) });
    } catch (e) { return route.fulfill({ status: 404, body: 'no' }); }
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; map.setView([38, -95], 4, { animate: false }); });

const state = () => p.evaluate(() => {
  const P = _ensx.man.grid.nx * _ensx.man.grid.ny, mid = Math.floor(_ensx.man.grid.ny / 2) * _ensx.man.grid.nx + 70;
  return { mode: _ensx.mode, member: _ensx.member, hour: _ensx.man.hours[_ensx.hourIdx], v: _ensx.values ? _ensx.values[mid] : null,
    legend: document.querySelector('#ensx-panel [data-e="legend"]').textContent, alert: document.querySelector('#ensx-panel [data-e="alert"]').textContent,
    layer: !!(_ensx.layer && map.hasLayer(_ensx.layer)), P };
});
const _ensxIdxOf = (pl) => [6, 12].indexOf(pl.hour);
const click = (mode) => p.evaluate(m => document.querySelector(`#ensx-panel .ensx-modes [data-mode="${m}"]`).click(), mode);

console.log('\n1. opened from Models > Ensemble Models');
{
  await p.evaluate(() => { toggleEnsembleModelsSub(); });
  await p.waitForTimeout(1500);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#ensx-panel .ensx-modes [data-mode]')].map(x => x.textContent));
  ok('Mean, Member, Chance and Stamps are all in the one panel', ['Mean', 'Member', 'Chance', 'Stamps'].every(r => rows.includes(r)), rows.join('|'));
  const s = await state();
  ok('opens on the mean of the newest run, drawn on the map', s.mode === 'mean' && s.layer && Math.abs(s.v - 70) < 0.06 && s.hour === 6, JSON.stringify(s));
  const ui = await p.evaluate(() => ({ models: [...document.querySelectorAll('#ensx-panel [data-e="chips"] .spag-leg')].map(o => o.textContent + ':' + o.classList.contains('on')),
    which: document.querySelector('#ensx-panel [data-e="which"]').textContent,
    names: [...document.querySelectorAll('#ensx-panel [data-e="member"] option')].slice(0, 3).map(o => o.textContent),
    members: document.querySelectorAll('#ensx-panel [data-e="member"] option').length, run: document.querySelector('#ensx-panel [data-e="run"]').textContent,
    note: document.querySelector('#ensx-panel [data-e="note"]').textContent }));
  ok('the ensemble is a Spaghetti-style chip (AEMN is the GEFS mean) with its name', ui.models.join() === 'AEMN:true' && /GEFS/.test(ui.which), JSON.stringify(ui));
  ok('members carry their ATCF names, as in Spaghetti Models', ui.names.join('|') === 'AC00 (control)|AP01|AP02', ui.names.join('|'));
  ok('names the run and members', ui.members === 5 && ui.run === '09/24 12z run' && /5 members, 2 forecast hours/.test(ui.note), JSON.stringify(ui));
  await p.evaluate(() => { _ensxQ('speed').value = '4'; _ensxQ('speed').dispatchEvent(new Event('input')); _ensxQ('play').click(); });
  await p.waitForTimeout(900);
  const pl = await p.evaluate(() => ({ playing: _ensx.playing, hour: _ensx.man.hours[_ensx.hourIdx], slider: +_ensxQ('hour').value, speed: _ensx.speed }));
  await p.evaluate(() => _ensxQ('play').click());
  await p.waitForTimeout(300);
  ok('the playbar plays the forecast hours, at the typed speed', pl.playing && pl.speed === 4 && pl.slider === _ensxIdxOf(pl), JSON.stringify(pl));
  ok('and stops again', !(await p.evaluate(() => _ensx.playing)));
  await p.evaluate(() => { _ensx.hourIdx = 0; _ensxQ('hour').value = 0; _ensxSyncHour(); return _ensxRender(); });
  ok('the Models row lights', await p.evaluate(() => document.getElementById('sub-ensemble-models') ? document.getElementById('sub-ensemble-models').classList.contains('active') : activeBubbles['ensemble-models'] === true));
}

console.log('\n2. mean, median, spread');
{
  await click('median'); await p.waitForTimeout(400);
  ok('median', Math.abs((await state()).v - 70) < 0.06);
  await click('spread'); await p.waitForTimeout(400);
  let s = await state();
  ok('spread is the standard deviation across members', Math.abs(s.v - Math.sqrt(200)) < 0.06, s.v);
  await click('nspread'); await p.waitForTimeout(400);
  s = await state();
  ok('normalised spread is 1 where spread is average', Math.abs(s.v - 1) < 0.01, s.v);
}

console.log('\n3. stepping through members, the hour staying put');
{
  await p.evaluate(() => { _ensxQ('hour').value = 1; _ensxQ('hour').dispatchEvent(new Event('input')); });
  await p.waitForTimeout(500);
  await click('member'); await p.waitForTimeout(400);
  let s = await state();
  ok('member 00 is the control', s.mode === 'member' && s.member === 0 && Math.abs(s.v - 50) < 0.06 && /AC00/.test(s.legend), JSON.stringify(s));
  await p.evaluate(() => _ensxQ('mnext').click()); await p.waitForTimeout(300);
  await p.evaluate(() => _ensxQ('mnext').click()); await p.waitForTimeout(300);
  s = await state();
  ok('the arrows step members, the hour does not move', s.member === 2 && Math.abs(s.v - 70) < 0.06 && s.hour === 12, JSON.stringify(s));
  await p.keyboard.press(']'); await p.waitForTimeout(300);
  ok('] steps too', (await state()).member === 3);
  await p.evaluate(() => { _ensx.member = 0; _ensxQ('member').value = 0; }); await p.evaluate(() => _ensxQ('mprev').click()); await p.waitForTimeout(300);
  ok('and it wraps round', (await state()).member === 4);
}

console.log('\n4. chance maps, AND and OR');
{
  await click('prob'); await p.waitForTimeout(500);
  let s = await state();
  ok('chance of more than an inch of rain: two of five members', Math.abs(s.v - 40) < 0.01 && /Total precipitation > 1 in/.test(s.legend), JSON.stringify(s));
  await p.evaluate(() => { const sel = _ensxQ('preset'); sel.value = 'fuel'; sel.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(500);
  s = await state();
  const conds = await p.evaluate(() => document.querySelectorAll('#ensx-panel .ensx-cond').length);
  const cf = await p.evaluate(() => _ensx.conds.map(c => c.field + c.op + c.value).join(' ') + ' ' + _ensx.join);
  ok('a preset fills in its conditions', conds === 2 && cf === 'cape>1000 td2m>60 and', cf);
  ok('a field this run lacks says so, and the old picture comes off', /has no 2 m dew point/.test(s.alert) && !s.layer && s.legend === '', JSON.stringify(s));
  await p.evaluate(() => {
    _ensx.conds = [{ field: 'cape', op: '>', value: 1000 }, { field: 'qpf', op: '>', value: 1 }]; _ensx.join = 'and';
    _ensxCondsUi(); _ensxRender();
  });
  await p.waitForTimeout(500);
  ok('AND: CAPE over 1000 and rain over an inch', Math.abs((await state()).v - 40) < 0.01);
  await p.evaluate(() => {
    _ensx.conds = [{ field: 'qpf', op: '>', value: 1.9 }, { field: 't2m', op: '<', value: 55 }];
    _ensxQ('join').value = 'or'; _ensxQ('join').dispatchEvent(new Event('change'));
  });
  await p.waitForTimeout(500);
  s = await state();
  ok('OR: rain over 1.9 in or colder than 55 F', Math.abs(s.v - 40) < 0.01 && / OR /.test(s.legend), JSON.stringify(s));
  await p.evaluate(() => { _ensx.conds = [{ field: 't2m', op: '<', value: 75 }]; _ensxCondsUi(); _ensxRender(); });
  await p.waitForTimeout(500);
  ok('non-exceedance: colder than 75 F, three of five', Math.abs((await state()).v - 60) < 0.01);
  await p.evaluate(() => { _ensx.conds = [{ field: 'ptype', op: '=', value: 2 }]; _ensxCondsUi(); _ensxRender(); });
  await p.waitForTimeout(500);
  ok('precipitation type: chance of snow', Math.abs((await state()).v - 40) < 0.01);
  const box = await p.evaluate(() => { const c = map.latLngToContainerPoint([38, -95]); return c; });
  const r = map => map;
  await p.mouse.move(box.x + 10, box.y + 10);
  await p.waitForTimeout(200);
  const read = await p.evaluate(() => { map.fire('mousemove', { latlng: L.latLng(38, -95) }); return _ensxQ('read').textContent; });
  ok('hover reads the chance under the pointer', read === '40% of members', read);
}

console.log('\n5. precipitation type, stamps');
{
  await p.evaluate(() => { _ensxQ('field').value = 'ptype'; _ensxQ('field').dispatchEvent(new Event('change')); });
  await click('mean'); await p.waitForTimeout(500);
  let s = await state();
  ok('for precipitation type the middle is the most likely type', s.v === 1 && /Most likely/.test(s.legend) && /Rain/.test(s.legend), JSON.stringify(s));
  await p.evaluate(() => { _ensxQ('field').value = 't2m'; _ensxQ('field').dispatchEvent(new Event('change')); });
  await click('stamps'); await p.waitForTimeout(600);
  const n = await p.evaluate(() => document.querySelectorAll('#ensx-panel .ensx-stamp canvas').length);
  ok('a stamp for every member', n === 5, n);
  await p.evaluate(() => document.querySelectorAll('#ensx-panel .ensx-stamp')[3].click());
  await p.waitForTimeout(500);
  s = await state();
  ok('clicking a stamp shows that member on the map', s.mode === 'member' && s.member === 3 && Math.abs(s.v - 80) < 0.06, JSON.stringify(s));
  await click('stamps'); await p.waitForTimeout(400);
  await p.evaluate(() => _ensxQ('big').click()); await p.waitForTimeout(300);
  await p.screenshot({ path: process.env.SHOT || '/tmp/ensx-stamps.png' });
  await p.evaluate(() => _ensxQ('big').click());
  await click('prob'); await p.waitForTimeout(500);
  await p.screenshot({ path: process.env.SHOT2 || '/tmp/ensx-prob.png' });
  const used = new Set(asked.filter(a => a.endsWith('.bin.gz')));
  ok('each field and hour is fetched once and reused', asked.filter(a => a.endsWith('.bin.gz')).length === used.size, asked.join(' '));
}

console.log('\n6. closing');
{
  await p.evaluate(() => _ensxQ('x').click());
  const r = await p.evaluate(() => ({ open: _ensxPanelIsOpen(), layer: !!_ensx.layer }));
  ok('closing takes the picture off the map', !r.open && !r.layer, JSON.stringify(r));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
