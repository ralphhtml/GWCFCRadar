#!/usr/bin/env node
/*
 * The Run Models list, and panels clear of the search bar.
 *
 *     node tools/test-models-list.mjs
 *
 * ECMWF IFS, HRDPS and the 18 h HRRR map charts are gone from the model
 * list; DWD ICON joined the main list of models, and stays there when the
 * parsing server's models fill it in. A panel shown or dragged under the
 * search bar is moved down below it instead of hiding its header.
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
ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-models-list.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1400, height: 860 } })).newPage();
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

console.log('\n1. the model list');
{
  const r = await p.evaluate(() => {
    const sel = document.getElementById('sev-model-sel');
    const vis = () => [...sel.options].filter(o => !o.hidden).map(o => o.value);
    const out = { before: vis(), groups: [...sel.querySelectorAll('optgroup')].map(g => g.label) };
    out.dwdInMain = !!document.querySelector('#sev-pi-group option[value="dwd"]');
    // The parsing server answers with its models: the list is rebuilt.
    _hdIndex = { models: { gfs: { label: 'GFS', res: '0.25 deg' }, hrrr: { label: 'HRRR', res: '3 km' } } };
    _hdFillModelPicker();
    out.after = vis();
    // Anything still naming a removed chart lands on DWD.
    _sevSetSection('ecmwf');
    out.retired = _sevSection;
    out.slot = _sevMakeSlot('hrdps').section;
    return out;
  });
  ok('ECMWF IFS, HRDPS and HRRR (18h) are gone', !['ecmwf', 'hrdps', 'hrrr'].some(v => r.before.includes(v) || r.after.includes(v)), JSON.stringify(r));
  ok('the Map Charts group is gone and DWD ICON sits in the main list', !r.groups.includes('Map Charts') && r.dwdInMain, JSON.stringify(r.groups));
  ok('and stays first when the parsing server fills the list', r.after[0] === 'dwd' && r.after.includes('pi:gfs'), JSON.stringify(r.after));
  ok('an old choice of a removed chart lands on DWD ICON', r.retired === 'dwd' && r.slot === 'dwd', JSON.stringify(r));
}

console.log('\n2. panels stay clear of the search bar');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const bar = document.getElementById('top-search-bar').getBoundingClientRect();
    const el = document.getElementById('run-models-panel');
    el.style.display = 'flex';
    // Put it right where the search bar is, the way the screenshot had it.
    el.style.setProperty('left', (bar.left - 20) + 'px', 'important');
    el.style.setProperty('top', '0px', 'important');
    await sleep(80);
    const shown = el.getBoundingClientRect();
    // Drag it up into the bar by its handle.
    const h = document.getElementById('run-models-drag').getBoundingClientRect();
    const fire = (t, x, y, tgt) => (tgt || document).dispatchEvent(new MouseEvent(t, { clientX: x, clientY: y, bubbles: true }));
    fire('mousedown', h.left + 4, h.top + 4, document.getElementById('run-models-drag'));
    fire('mousemove', h.left + 4, 2);
    fire('mouseup', h.left + 4, 2);
    await sleep(80);
    const dragged = el.getBoundingClientRect();
    // Away from the bar, the top edge is still free.
    el.style.setProperty('left', '200px', 'important');
    el.style.setProperty('top', '10px', 'important');
    await sleep(80);
    const free = el.getBoundingClientRect();
    el.style.display = 'none';
    return { barBottom: bar.bottom, shown: shown.top, dragged: dragged.top, free: free.top };
  });
  ok('a panel shown under the bar is moved below it', r.shown >= r.barBottom, JSON.stringify(r));
  ok('a panel dragged up into the bar stops below it', r.dragged >= r.barBottom, JSON.stringify(r));
  ok('away from the bar a panel can still sit at the top', r.free === 10, JSON.stringify(r));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
