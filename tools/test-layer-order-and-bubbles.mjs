#!/usr/bin/env node
/*
 * Two changes, tested together since they are the two halves of one ask:
 * reordering layers should happen in exactly one place (Settings ->
 * Layer Order), not in two places that disagree about what they even do.
 *
 *     node tools/test-layer-order-and-bubbles.mjs
 *
 * 1. The left-menu bubble column (#sub-bubbles) used to carry its own drag
 *    handle, at every level, that only ever reordered the BUTTONS in that
 *    menu - it never touched what actually draws on top of what on the map.
 *    That handle is gone now; the info button is the only thing every row
 *    still carries.
 * 2. Settings -> Layer Order used to cover four map layers (borders, radar,
 *    satellite, ocean) plus model charts, but the NWS RTMA/NDFD grids behind
 *    Temperature, Wind, Pressure and Waves' NWS source had a z-index written
 *    once, at boot, and never moved - so it was not in the list at all, and
 *    turning it on always drew wherever the code happened to put it whatever
 *    order was saved. It is a sixth row in the reorderable stack now.
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

console.log('\n1. the bubble drag-reorder machinery is gone');
{
  ok('no more sb-drag handle creation anywhere in the page',
     !/className = 'sb-drag'/.test(PAGE));
  ok('no more per-menu saved bubble order (gwcfc_sb_order_)',
     !PAGE.includes('gwcfc_sb_order_'));
  ok('no more top-level saved bubble order (gwcfc_bubble_order)',
     !PAGE.includes('gwcfc_bubble_order'));
  ok('the .sb-drag CSS class itself is gone too',
     !/\.sb-drag\s*\{/.test(PAGE));
  ok('the tutorial demo no longer draws a fake drag handle',
     !PAGE.includes('tut-bubble-drag'));
  ok('the bubble column still gets an info button - only the drag handle left',
     /Every bubble gets an info button/.test(PAGE));
}

console.log('\n2. the NWS grids are a real row in the map-layer stack');
{
  ok("MAP_STACK_LAYERS lists 'nws' pointing at nwsPane",
     /\{ id: 'nws',\s*pane: 'nwsPane'/.test(PAGE));
  ok('_nwsPane() applies the saved stack order the moment its pane is created',
     /function _nwsPane\(\)[\s\S]{0,700}?_stackApply\(\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-layer-order-and-bubbles.mjs'), 'utf8').includes(EM));
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
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const errs = [];

const p = await b.newPage({ viewport: { width: 900, height: 700 } });
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n3. the bubble column renders with no drag handles');
{
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(() => {
    if (typeof renderSubBubbles === 'function') renderSubBubbles('regular');
    const wrap = document.getElementById('sub-bubbles');
    return {
      bubbleCount: wrap ? wrap.querySelectorAll('.sub-bubble').length : 0,
      dragCount: wrap ? wrap.querySelectorAll('.sb-drag').length : 0,
      infoCount: wrap ? wrap.querySelectorAll('.ov-info-btn').length : 0,
    };
  });
  ok('the bubble column actually rendered rows', r.bubbleCount > 0, JSON.stringify(r));
  ok('none of them carry a drag handle', r.dragCount === 0, JSON.stringify(r));
  ok('they still carry an info button', r.infoCount > 0, JSON.stringify(r));
}

console.log('\n4. the NWS row is really in the stack and really moves the pane');
{
  const r = await p.evaluate(() => {
    // Create the pane the way turning an NWS layer on would, then read the
    // Settings list and confirm the row exists and is wired to it.
    const paneName = typeof _nwsPane === 'function' ? _nwsPane() : null;
    if (typeof _stackRender === 'function') _stackRender();
    const row = document.querySelector('#lqm-stack-list .lqm-order-row[data-stackid="nws"]');
    return {
      paneName,
      rowExists: !!row,
      rowLabel: row ? row.querySelector('.lqm-order-name').textContent : null,
      zBefore: paneName ? map.getPane(paneName).style.zIndex : null,
    };
  });
  ok('turning an NWS layer on creates nwsPane', r.paneName === 'nwsPane', JSON.stringify(r));
  ok('Settings -> Layer Order shows a row for it', r.rowExists, JSON.stringify(r));
  ok('labelled recognisably as the NWS grids', /NWS/.test(r.rowLabel || ''), JSON.stringify(r));

  // Move it to the very top with the up arrow, repeatedly, and confirm the
  // real pane's z-index actually changes to match - not just the list.
  const moved = await p.evaluate(() => {
    let row = document.querySelector('#lqm-stack-list .lqm-order-row[data-stackid="nws"]');
    for (let i = 0; i < 6 && row && !row.previousElementSibling === false; i++) {
      const upBtn = row.querySelector('.lqm-order-btn[data-move="up"]');
      if (!upBtn || upBtn.classList.contains('off')) break;
      upBtn.click();
      row = document.querySelector('#lqm-stack-list .lqm-order-row[data-stackid="nws"]');
    }
    const rows = Array.from(document.querySelectorAll('#lqm-stack-list .lqm-order-row'));
    const idx = rows.indexOf(row);
    const z = map.getPane('nwsPane').style.zIndex;
    return { idx, z, topZ: rows[0] === row };
  });
  ok('walking it up with the arrow puts it first in the list', moved.topZ, JSON.stringify(moved));
  ok('and the real pane on the map is now the highest of the stack layers',
     Number(moved.z) === 401, JSON.stringify(moved));
  ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
