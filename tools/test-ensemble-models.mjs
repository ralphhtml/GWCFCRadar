#!/usr/bin/env node
/*
 * Models > Ensemble Models: one panel shaped like the other model panels.
 *
 *     node tools/test-ensemble-models.mjs
 *
 * Checked: the Models row opens it; it has the playbar, the ensembles as
 * Spaghetti-style chips, what to show and the map switches; the switches
 * light; nothing in it repeats a feature that lives elsewhere; and Run
 * Models lists the ensembles too, under their own heading.
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
});

console.log('\n1. one panel, shaped like the other model panels');
const rows = () => p.evaluate(() => [...document.querySelectorAll('#sub-bubbles .sub-bubble')].map(e =>
  (e.classList.contains('active') ? '*' : '') + e.querySelector('.sb-label').textContent));
{
  await p.evaluate(() => toggleModelsSub());
  const r = await rows();
  ok('Models lists Ensemble Models right under Run Models', r.join('|').startsWith('Back|Run Models|Ensemble Models|'), r.join('|'));
  await p.evaluate(() => document.getElementById('sub-ensemble-models').click());
  await p.waitForTimeout(400);
  const e = await p.evaluate(() => {
    const el = document.getElementById('ensx-panel');
    return { shown: !!el && getComputedStyle(el).display === 'flex', cls: el.className,
      title: el.querySelector('.models-panel-title').textContent.trim(),
      sections: [...el.querySelectorAll('.sev-section-label')].map(x => x.textContent.trim()).join('|'),
      play: !!el.querySelector('.sev-playbar-row [data-e="play"]') && !!el.querySelector('.sev-playbar-row [data-e="speed"]'),
      toggles: [...el.querySelectorAll('.ens-toggles button')].map(x => x.textContent.trim()).join('|'),
      titled: [...el.querySelectorAll('.ens-toggles button')].every(b => b.title.length > 20),
      old: !!document.getElementById('ens-models-panel') };
  });
  ok('the Models row opens the one Ensemble Models panel', e.shown && /models-style-panel/.test(e.cls) && e.title === 'Ensemble Models', JSON.stringify(e));
  ok('playbar on top, then Ensemble, Show and On the map', e.play && e.sections === 'Ensemble|Show|On the map', e.sections);
  ok('the map layers are gold switches that explain themselves', e.toggles === 'Low Tracks|TC Chance|Layer Stack' && e.titled, e.toggles);
  ok('the old button menu is gone', !e.old);
}

console.log('\n2. the switches work and light up');
{
  for (const [id, flag] of [['ens-lows', '_lowsOn'], ['ens-tcprob', '_ectcOn']]) {
    await p.evaluate(i => document.getElementById(i).click(), id);
    await p.waitForTimeout(450);
    const r = await p.evaluate(([i, f]) => ({ on: eval(f), lit: document.getElementById(i).classList.contains('on') }), [id, flag]);
    ok(`${id} turns on and lights`, r.on && r.lit, JSON.stringify(r));
    await p.evaluate(i => document.getElementById(i).click(), id);
    await p.waitForTimeout(450);
    const r2 = await p.evaluate(([i, f]) => ({ on: eval(f), lit: document.getElementById(i).classList.contains('on') }), [id, flag]);
    ok(`${id} turns off again`, !r2.on && !r2.lit, JSON.stringify(r2));
  }
}

console.log('\n3. nothing repeated from elsewhere');
{
  const r = await p.evaluate(() => ({
    ids: [...document.querySelectorAll('#ensx-panel button[id]')].map(b => b.id),
    hidden: ['op-ecmwf-tc', 'op-low-tracks', 'cyc-ens-centres-btn'].map(id => {
      const el = document.getElementById(id); return id + ':' + (el ? getComputedStyle(el).display : 'gone'); }),
    rightClick: typeof _cmMeteogramHere === 'function' }));
  ok('no charts, meteogram or GEFS centres buttons (Run Models, the right-click menu and Spaghetti Models have those)',
     !r.ids.some(i => /ens-charts|ens-meteogram|ens-centres/.test(i)) && r.rightClick, r.ids.join(','));
  ok('and the overlay rows stay hidden, so each layer has one home', r.hidden.every(x => /:none$/.test(x)), r.hidden.join(' '));
}

console.log('\n4. Run Models runs the ensembles too');
{
  await p.evaluate(() => { toggleModelsSub(); document.getElementById('sub-run-models').click(); });
  await p.waitForTimeout(600);
  const vis = () => p.evaluate(() => ({
    title: document.querySelector('#run-models-panel .models-panel-title').textContent.trim(),
    shown: [...document.querySelectorAll('#sev-model-sel option')].filter(o => !o.hidden).map(o => o.value),
    ens: [...document.querySelectorAll('#sev-ens-group option')].map(o => o.value),
    label: (document.getElementById('sev-ens-group') || {}).label }));
  let v = await vis();
  ok('the single runs and the ensembles are both there', v.title === 'Run Models' && v.shown.includes('pi:gfs') && v.shown.includes('pi:gefs'), JSON.stringify(v));
  ok('the ensembles under their own Ensembles heading', v.label === 'Ensembles' && v.ens.join(',') === 'pi:gefs,pi:gefsspr', JSON.stringify(v));
  await p.evaluate(() => {
    _hdIndex = { models: { gfs: { label: 'GFS' }, gefs: { label: 'GEFS Mean' }, cmce: { label: 'CMC Ensemble' },
      hrefpmmn: { label: 'HREF PMM' }, ecmwfens: { label: 'ECMWF ENS mean' }, hrrr: { label: 'HRRR' } } };
    _hdFillModelPicker();
  });
  v = await vis();
  ok('a fresh list from the parsing server keeps that shape, no repeats',
     v.ens.join(',') === 'pi:gefs,pi:cmce,pi:hrefpmmn,pi:ecmwfens' && v.shown.includes('pi:hrrr')
     && new Set(v.shown).size === v.shown.length, JSON.stringify(v));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
