#!/usr/bin/env node
/*
 * "Barely zooming it zooms SOO much." Leaflet's own scroll-wheel handler
 * is disabled for good at boot - _wireWheelZoom wires the wheel itself
 * instead, accumulating deltas and applying one non-animated zoom per
 * animation frame - but the Radar Compass tool's own lock/unlock pair used
 * to turn that native handler back ON when closing, which meant every
 * wheel notch answered TWICE from the moment anyone opened and closed the
 * dial once. Measured before the fix: one notch moved the map by 1.91
 * zoom levels instead of the intended 0.83 - more than double.
 *
 *     node tools/test-wheel-zoom-sensitivity.mjs
 *
 * Uses the real Leaflet build (unlike test-radar-compass.mjs, which stubs
 * Leaflet out entirely to test only the compass's own angle math), because
 * the whole point here is measuring how far a real wheel event actually
 * moves a real map.
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

console.log('\n1. the fix is in the page');
{
  ok('closing the Radar Compass no longer re-enables Leaflet\'s own wheel handler',
     !/function _radcUnlockMapView\(\)[\s\S]{0,800}map\.scrollWheelZoom\.enable/.test(PAGE));
  ok('it still hands back dragging, double-click zoom and touch zoom, which it never replaced',
     /function _radcUnlockMapView\(\)[\s\S]{0,200}map\.dragging\.enable\(\)/.test(PAGE)
     && /function _radcUnlockMapView\(\)[\s\S]{0,200}map\.doubleClickZoom\.enable\(\)/.test(PAGE)
     && /function _radcUnlockMapView\(\)[\s\S]{0,900}map\.touchZoom\.enable\(\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-wheel-zoom-sensitivity.mjs'), 'utf8').includes(EM));
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

// One notch, dispatched the same way for every measurement below.
const notch = () => p.evaluate(async () => {
  const z0 = map.getZoom();
  map.getContainer().dispatchEvent(new WheelEvent('wheel', {
    deltaY: -100, deltaMode: 0, clientX: 500, clientY: 400,
    bubbles: true, cancelable: true }));
  await new Promise(res => requestAnimationFrame(res));
  await new Promise(res => setTimeout(res, 80));
  return +(map.getZoom() - z0).toFixed(2);
});

console.log('\n2. one notch, before ever touching the Radar Compass');
{
  const moved = await notch();
  ok('moves a moderate amount, well under a full level', moved > 0 && moved < 1, String(moved));
}

console.log('\n3. one notch, after opening and closing the Radar Compass once');
{
  const r = await p.evaluate(async () => {
    const before = map.scrollWheelZoom.enabled();
    _radcLockMapView();
    _radcUnlockMapView();
    const afterUnlock = map.scrollWheelZoom.enabled();
    return { before, afterUnlock };
  });
  ok('Leaflet\'s own wheel handler was off beforehand', r.before === false, JSON.stringify(r));
  ok('and is still off after the dial has been opened and closed',
     r.afterUnlock === false, JSON.stringify(r));
  const moved = await notch();
  ok('one notch still moves the same moderate amount, not doubled',
     moved > 0 && moved < 1, String(moved));
}

console.log('\n4. and again after a second round, in case only the first ever worked');
{
  await p.evaluate(() => { _radcLockMapView(); _radcUnlockMapView(); });
  const moved = await notch();
  ok('still not doubled the second time either', moved > 0 && moved < 1, String(moved));
}

ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
