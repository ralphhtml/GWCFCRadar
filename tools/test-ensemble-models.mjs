#!/usr/bin/env node
/*
 * Models > Ensemble Models: every ensemble feature in one sub-bubble.
 *
 *     node tools/test-ensemble-models.mjs
 *
 * The ensemble charts (the Run Models panel switched to its ensemble list),
 * Low Tracks and ECMWF TC Probability (which were overlay rows), the GEFS
 * cyclone centres (which was a button in the AI Cyclones panel) and the
 * ensemble meteogram. Checked: the rows are there and light up, the old
 * homes no longer show them, and the Run Models picker splits cleanly into
 * ordinary runs and ensembles.
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
{
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- ENSEMBLE MODELS'), b = PAGE.indexOf('function toggleModelsSub() {');
  ok('no em dashes in the new code or this test', a > 0 && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-ensemble-models.mjs'), 'utf8').includes(EM));
}

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
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => {
  const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none';
  // No parsing server here: the three map features just flip their switch.
  window._lowsToggle = () => { _lowsOn = !_lowsOn; };
  window._ectcToggle = () => { _ectcOn = !_ectcOn; };
  window._ensToggle = async () => { _ensOn = !_ensOn; };
});

console.log('\n1. the sub-bubble');
const rows = () => p.evaluate(() => [...document.querySelectorAll('#sub-bubbles .sub-bubble')].map(e =>
  (e.classList.contains('active') ? '*' : '') + e.querySelector('.sb-label').textContent));
{
  await p.evaluate(() => toggleModelsSub());
  const r = await rows();
  ok('Models lists Ensemble Models right under Run Models', r.join('|').startsWith('Back|Run Models|Ensemble Models|'), r.join('|'));
  await p.evaluate(() => document.getElementById('sub-ensemble-models').click());
  const e = await rows();
  ok('it opens a menu of every ensemble feature',
     e.join('|') === 'Ensemble Models|Ensemble Charts|Members & Stats|Chance Maps|Postage Stamps|Model Layer Stack|Low Tracks|ECMWF TC Probability|GEFS Cyclone Centres|Ensemble Meteogram', e.join('|'));
  const info = await p.evaluate(() => [...document.querySelectorAll('#sub-bubbles .sub-bubble:not(.sb-back)')].every(x => x.querySelector('.ov-info-btn')));
  ok('each row explains itself', info);
}

console.log('\n2. the rows work and light up');
{
  for (const [id, flag] of [['ens-lows', '_lowsOn'], ['ens-tcprob', '_ectcOn'], ['ens-centres', '_ensOn']]) {
    await p.evaluate(i => document.getElementById('sub-' + i).click(), id);
    await p.waitForTimeout(450);
    const r = await p.evaluate(([i, f]) => ({ on: eval(f), lit: document.getElementById('sub-' + i).classList.contains('active') }), [id, flag]);
    ok(`${id} turns on and lights`, r.on && r.lit, JSON.stringify(r));
    await p.evaluate(i => document.getElementById('sub-' + i).click(), id);
    await p.waitForTimeout(450);
    const r2 = await p.evaluate(([i, f]) => ({ on: eval(f), lit: document.getElementById('sub-' + i).classList.contains('active') }), [id, flag]);
    ok(`${id} turns off again`, !r2.on && !r2.lit, JSON.stringify(r2));
  }
  await p.evaluate(() => document.getElementById('sub-ens-meteogram').click());
  await p.waitForTimeout(500);
  ok('the meteogram row opens the meteogram', await p.evaluate(() => _mtgPanelIsOpen()));
  await p.evaluate(() => document.getElementById('sub-ens-meteogram').click());
  await p.waitForTimeout(300);
  ok('and closes it', !(await p.evaluate(() => _mtgPanelIsOpen())));
}

console.log('\n3. the old homes');
{
  const r = await p.evaluate(() => ['op-ecmwf-tc', 'op-low-tracks', 'cyc-ens-centres-btn'].map(id => {
    const el = document.getElementById(id);
    return id + ':' + (el ? getComputedStyle(el).display : 'gone');
  }));
  ok('the overlay rows and the AI Cyclones button are no longer shown', r.every(x => /:none$/.test(x)), r.join(' '));
}

console.log('\n4. ensemble charts and ordinary runs, split');
{
  await p.evaluate(() => { toggleEnsembleModelsSub(); document.getElementById('sub-ens-charts').click(); });
  await p.waitForTimeout(600);
  const vis = () => p.evaluate(() => ({
    title: document.querySelector('#run-models-panel .models-panel-title').textContent.trim(),
    shown: [...document.querySelectorAll('#sev-model-sel option')].filter(o => !o.hidden).map(o => o.value),
    value: document.getElementById('sev-model-sel').value }));
  let v = await vis();
  ok('Ensemble Charts opens the models panel as Ensemble Models', v.title === 'Ensemble Models', v.title);
  ok('listing only the ensembles, and showing one', v.shown.join(',') === 'pi:gefs,pi:gefsspr' && v.value === 'pi:gefs', JSON.stringify(v));
  ok('and the row is lit', await p.evaluate(() => document.getElementById('sub-ens-charts').classList.contains('active')));
  await p.evaluate(() => { toggleModelsSub(); document.getElementById('sub-run-models').click(); });
  await p.waitForTimeout(600);
  v = await vis();
  ok('Run Models is the ordinary runs only', v.title === 'Run Models' && !v.shown.some(x => /gefs/.test(x)) && v.shown.includes('pi:gfs')
     && !/gefs/.test(v.value), JSON.stringify(v));
  // The parsing server's own list arriving later keeps the split.
  await p.evaluate(() => {
    _hdIndex = { models: { gfs: { label: 'GFS' }, gefs: { label: 'GEFS Mean' }, cmce: { label: 'CMC Ensemble' },
      hrefpmmn: { label: 'HREF PMM' }, ecmwfens: { label: 'ECMWF ENS mean' }, hrrr: { label: 'HRRR' } } };
    _hdFillModelPicker();
  });
  v = await vis();
  ok('a fresh model list from the parsing server keeps ensembles out of Run Models',
     !v.shown.some(x => /gefs|cmce|href|ecmwfens/.test(x)) && v.shown.includes('pi:hrrr'), JSON.stringify(v.shown));
  await p.evaluate(() => openEnsembleChartsPanel());
  v = await vis();
  ok('and in Ensemble Models', v.shown.join(',') === 'pi:gefs,pi:cmce,pi:hrefpmmn,pi:ecmwfens', JSON.stringify(v.shown));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
