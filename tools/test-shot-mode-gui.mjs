#!/usr/bin/env node
/*
 * ?shot=1 (body.shot-mode) hides the whole interface, not just the parts
 * that happen to hang directly off <body>. #map-compass, #right-menu, the
 * draw/measure/polygon toolbars, the GPS and nav HUDs and a dozen other
 * controls are all direct children of #map-wrap, right alongside #map
 * itself, so the earlier body-level catch-all never touched them - a bot
 * screenshot taken with ?shot=1 still showed them.
 *
 *     node tools/test-shot-mode-gui.mjs
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

console.log('\n1. the map-wrap catch-all is in the page');
{
  ok('every direct child of #map-wrap except #map is hidden in shot-mode',
     /body\.shot-mode #map-wrap > div:not\(#map\) \{[\s\S]{0,60}?display: none !important;/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-shot-mode-gui.mjs'), 'utf8').includes(EM));
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

const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
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
// Same pattern the other shot-mode tests use: the class is what the CSS
// keys off, and setting it directly sidesteps needing real tile network to
// reach the readiness flag this sandbox has no route to.
await p.evaluate(() => document.body.classList.add('shot-mode'));

console.log('\n2. a ?shot=1 load actually hides the interface');
{
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(() => {
    const vis = id => {
      const el = document.getElementById(id);
      if (!el) return 'missing';
      return getComputedStyle(el).display;
    };
    return {
      main: vis('main'),
      map: vis('map'),
      rightMenu: vis('right-menu'),
      compass: vis('map-compass'),
      subBubbles: vis('sub-bubbles'),
      drawToolbar: vis('draw-toolbar'),
      modelInfo: vis('model-info'),
      recenter: vis('recenter-float'),
    };
  });
  ok('#main (holding the map) stays visible', r.main !== 'none', JSON.stringify(r));
  ok('#map itself stays visible', r.map !== 'none', JSON.stringify(r));
  ok('#right-menu (the right-edge tool icons) is hidden', r.rightMenu === 'none', JSON.stringify(r));
  ok('#map-compass is hidden', r.compass === 'none', JSON.stringify(r));
  ok('#sub-bubbles is hidden', r.subBubbles === 'none', JSON.stringify(r));
  ok('#draw-toolbar is hidden', r.drawToolbar === 'none', JSON.stringify(r));
  ok('#model-info is hidden', r.modelInfo === 'none', JSON.stringify(r));
  ok('#recenter-float is hidden', r.recenter === 'none', JSON.stringify(r));
}

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
