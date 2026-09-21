#!/usr/bin/env node
/*
 * The pointer preference: tornado, hurricane or supercell for a cursor,
 * picked in Settings > General, remembered, and never stealing the
 * I-beam from a text field.
 *
 *     node tools/test-pointer.mjs
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
  ok('three storms and a default, in a Settings select',
     /id="lqm-set-pointer"/.test(PAGE)
     && ['default', 'tornado', 'hurricane', 'supercell']
        .every(v => new RegExp('<option value="' + v + '"').test(PAGE)));
  ok('each storm is an inline SVG cursor with the auto fallback',
     (PAGE.match(/cursor: url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, auto !important;/g) || []).length === 3);
  ok('text fields keep their I-beam whatever the pointer',
     /:root\[data-pointer\] input\[type="text"\][\s\S]{0,200}cursor: text !important;/.test(PAGE));
  ok('the choice is remembered', /localStorage\.setItem\('gwcfc_pointer', _appPointer\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-pointer.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 150)));
await p.addInitScript(() => {
  try {
    localStorage.setItem('gwcfc_tutorial_seen', '1');
    localStorage.setItem('gwcfc_pointer', 'hurricane');   // a stored storm
  } catch (e) {}
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
await p.waitForTimeout(4000);

console.log('\n2. it applies, switches, restores and remembers');
{
  const r = await p.evaluate(() => {
    const out = {};
    out.storedApplied = document.documentElement.getAttribute('data-pointer');
    out.mapCursor = getComputedStyle(document.getElementById('map')).cursor.slice(0, 24);
    out.selSynced = document.getElementById('lqm-set-pointer').value;
    out.inputCursor = getComputedStyle(document.getElementById('lqm-search-input')).cursor;
    lqmSetPointer('tornado');
    out.afterSwitch = document.documentElement.getAttribute('data-pointer');
    out.stored2 = localStorage.getItem('gwcfc_pointer');
    lqmSetPointer('default');
    out.attrGone = !document.documentElement.hasAttribute('data-pointer');
    out.mapDefault = getComputedStyle(document.getElementById('map')).cursor;
    lqmSetPointer('supercell');
    out.bodyCursor = getComputedStyle(document.body).cursor.slice(0, 24);
    return out;
  });
  ok('a stored storm is the pointer from boot, select in step',
     r.storedApplied === 'hurricane' && r.selSynced === 'hurricane', JSON.stringify(r));
  ok('the map wears the SVG cursor, not leaflet\'s grab',
     /^url\("data:image\/svg/.test(r.mapCursor), r.mapCursor);
  ok('a text field keeps its I-beam', r.inputCursor === 'text', r.inputCursor);
  ok('switching storms applies and remembers',
     r.afterSwitch === 'tornado' && r.stored2 === 'tornado', JSON.stringify(r));
  ok('Default hands the map its grab cursor back',
     r.attrGone && r.mapDefault === 'grab', r.mapDefault);
  ok('the supercell rides everything, body included',
     /^url\("data:image\/svg/.test(r.bodyCursor), r.bodyCursor);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
