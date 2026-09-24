#!/usr/bin/env node
/*
 * Layer Order is one list for everything, down to the last sub-bubble.
 *
 *     node tools/test-layer-order-all.mjs
 *
 * Map layers and overlays are rows of one list, so any row can go over or
 * under any other. And every product picked from a menu, however deep, draws
 * into a pane of its own nested inside its layer's pane, and shows up as an
 * indented row under that layer that can be reordered against its siblings.
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
ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-layer-order-all.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
ok('the separate overlay list is gone from Settings', !PAGE.includes('id="lqm-ovorder-list"'));

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

console.log('\n1. every sub-bubble pick gets its own row');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _bubblePane('waves');          // the Waves loader makes its pane before it draws
    const stand = () => L.rectangle([[30, -100], [32, -98]], { pane: 'wavesPane' }).addTo(map);
    await _menuPlay('Waves > Period');
    const a = stand();
    await _menuPlay('Waves > Direction');
    const bb = stand();
    const fam = map.getPane('wavesPane');
    out.nested = [...fam.children].filter(c => c.dataset.subslug).map(c => c.dataset.sublabel);
    out.aIn = a.getPane().parentElement === fam && a.getPane().dataset.sublabel === 'Period';
    out.bIn = bb.getPane().parentElement === fam && bb.getPane().dataset.sublabel === 'Direction';
    _stackRender();
    const subs = () => [...document.querySelectorAll('#lqm-stack-list .lqm-order-row.sub')].filter(r => r.dataset.fam === 'wavesPane');
    out.rows = subs().map(r => r.querySelector('.lqm-order-name').textContent);
    // Under the Waves row itself.
    const wavesRow = document.querySelector('#lqm-stack-list .lqm-order-row[data-stackid="waves"]');
    out.underWaves = wavesRow.nextElementSibling === subs()[0];
    const zOf = lab => +[...fam.children].find(c => c.dataset.sublabel === lab).style.zIndex;
    out.zBefore = { period: zOf('Period'), direction: zOf('Direction') };
    // Move the first sub-row down: the two swap, on the map too.
    subs()[0].querySelector('[data-move="down"]').click();
    out.rowsAfter = subs().map(r => r.querySelector('.lqm-order-name').textContent);
    out.zAfter = { period: zOf('Period'), direction: zOf('Direction') };
    // The family row moves with its sub-rows kept under it.
    const wr = document.querySelector('#lqm-stack-list .lqm-order-row[data-stackid="waves"]');
    wr.querySelector('[data-move="up"]').click();
    const wr2 = document.querySelector('#lqm-stack-list .lqm-order-row[data-stackid="waves"]');
    out.stillUnder = wr2.nextElementSibling && wr2.nextElementSibling.classList.contains('sub');
    // The family pane still finds everything drawn inside it.
    out.found = fam.querySelectorAll('path').length;
    map.removeLayer(a); map.removeLayer(bb);
    return out;
  });
  ok('two Waves products drew into two panes nested in the Waves pane', r.aIn && r.bIn && r.nested.length === 2, JSON.stringify(r.nested));
  ok('each is a row, named by its menu path, under the Waves row', r.rows.includes('Period') && r.rows.includes('Direction') && r.underWaves, JSON.stringify(r.rows));
  ok('moving a sub-row restacks those two on the map', r.rowsAfter[0] === r.rows[1]
     && (r.zAfter.period > r.zAfter.direction) === (r.zBefore.period < r.zBefore.direction), JSON.stringify(r));
  ok('the Waves row moves with its sub-rows kept under it', r.stillUnder);
  ok('code that searches the Waves pane still finds what is drawn', r.found === 2, String(r.found));
}

console.log('\n2. a deep path is one row, named all the way down');
{
  const r = await p.evaluate(async () => {
    _menuCrumb = [];
    // A pick three taps down, set the way the menu sets it.
    _menuPick.Waves = ['Waves', 'SST', 'Coral Reef Watch', 'Actual'];
    const l = L.rectangle([[20, -90], [21, -89]], { pane: 'sstPane' }).addTo(map);
    const label = l.getPane().dataset.sublabel;
    _stackRender();
    const row = [...document.querySelectorAll('#lqm-stack-list .lqm-order-row.sub')].find(r => r.dataset.fam === 'sstPane');
    map.removeLayer(l);
    return { label, row: row && row.querySelector('.lqm-order-name').textContent };
  });
  ok('Waves > SST > Coral Reef Watch > Actual is its own row', r.label === 'SST > Coral Reef Watch > Actual' && r.row === r.label, JSON.stringify(r));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
