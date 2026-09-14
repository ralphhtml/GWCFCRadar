#!/usr/bin/env node
/*
 * The Inspector's crosshair sits at the exact point it samples, even when
 * the map does not fill the whole page.
 *
 *     node tools/test-inspector-location.mjs
 *
 * The ring and readout used to be `position: fixed; top: 50%; left: 50%` -
 * dead centre of the page. The point actually sampled was the dead centre
 * of the MAP CONTAINER instead (map.getContainer().getBoundingClientRect()),
 * read back for a pixel colour and a lat/lng. Those two centres are only the
 * same point if the map container happens to fill the entire page exactly,
 * which is not guaranteed - a mobile browser showing or hiding its own
 * address bar is the ordinary way it stops being true for a moment, and it
 * would read as "the Inspector is reading the wrong spot" with no visible
 * cause, since nothing about the page looks obviously broken.
 *
 * _inspUpdate() now paints the ring and the readout at the same rect-derived
 * point it samples, every call, so the two can never disagree. This proves
 * it by literally shrinking the map container away from the page's own
 * centre and checking the ring still lands on the map's centre, not the
 * page's.
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
  ok('the crosshair no longer paints itself at a fixed 50%/50%',
     /#inspector-crosshair \{[\s\S]{0,80}?top: 0; left: 0;/.test(PAGE));
  ok('_inspUpdate sets the crosshair\'s real screen position from the same rect it samples',
     /function _inspUpdate\(\)[\s\S]{0,1200}?_inspEl\.style\.left = cx \+ 'px'; _inspEl\.style\.top = cy \+ 'px';/.test(PAGE));
  ok('and the readout too, 22px below it',
     /_inspLabelEl\.style\.left = cx \+ 'px'; _inspLabelEl\.style\.top = \(cy \+ 22\) \+ 'px';/.test(PAGE));
  ok('_inspApplyOff no longer paints anything itself, only clamps',
     /function _inspApplyOff\(\) \{\s*_inspClampOff\(\);\s*\}/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-inspector-location.mjs'), 'utf8').includes(EM));
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

const p = await b.newPage({ viewport: { width: 900, height: 800 } });
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

console.log('\n2. the crosshair lands on the map\'s real centre, not the page\'s');
{
  ok('the page boots clean', errs.length === 0, errs[0]);

  const before = await p.evaluate(() => {
    toggleInspector();
    const rect = document.getElementById('map').getBoundingClientRect();
    const el = document.getElementById('inspector-crosshair');
    const er = el.getBoundingClientRect();
    return {
      mapCenterX: rect.left + rect.width / 2, mapCenterY: rect.top + rect.height / 2,
      ringCenterX: er.left + er.width / 2, ringCenterY: er.top + er.height / 2,
    };
  });
  ok('with the map filling the page, the ring is already on its centre',
     Math.abs(before.ringCenterX - before.mapCenterX) < 1
     && Math.abs(before.ringCenterY - before.mapCenterY) < 1,
     JSON.stringify(before));

  // Shrink #main away from the top of the page, the way a shorter mobile
  // visual viewport (address bar showing) would - #main stays flex:1, the
  // page around it just gets taller than what the old CSS 50% assumed.
  const after = await p.evaluate(async () => {
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:0 0 220px;';
    document.body.insertBefore(spacer, document.body.firstChild);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Kick the Inspector the same way a map move would - _inspUpdate is what
    // has to notice the container moved, since nothing fires a Leaflet event
    // for a plain layout reflow.
    if (typeof _inspUpdate === 'function') _inspUpdate();
    const rect = document.getElementById('map').getBoundingClientRect();
    const el = document.getElementById('inspector-crosshair');
    const er = el.getBoundingClientRect();
    const readout = document.getElementById('inspector-readout').getBoundingClientRect();
    return {
      mapCenterX: rect.left + rect.width / 2, mapCenterY: rect.top + rect.height / 2,
      ringCenterX: er.left + er.width / 2, ringCenterY: er.top + er.height / 2,
      readoutX: readout.left + readout.width / 2, readoutTop: readout.top,
    };
  });
  ok('pushed 220px down the page, the ring still finds the map\'s real centre',
     Math.abs(after.ringCenterX - after.mapCenterX) < 1
     && Math.abs(after.ringCenterY - after.mapCenterY) < 1,
     JSON.stringify(after));
  ok('and it actually moved, this is not a coincidence of both staying at 0',
     Math.abs(after.mapCenterY - before.mapCenterY) > 100, JSON.stringify({ before, after }));
  ok('the readout stays centred under the ring, not the page',
     Math.abs(after.readoutX - after.ringCenterX) < 1, JSON.stringify(after));
  ok('and 22px below it', Math.abs(after.readoutTop - (after.ringCenterY + 22 - 13)) < 20,
     JSON.stringify(after));
}

console.log('\n3. the sampled point is the same point the ring is drawn on');
{
  const r = await p.evaluate(() => {
    const el = document.getElementById('inspector-crosshair');
    const er = el.getBoundingClientRect();
    const ringCenter = { x: er.left + er.width / 2, y: er.top + er.height / 2 };
    // Reconstruct exactly what _inspUpdate itself used to sample, and check
    // it against where the ring was actually drawn.
    const rect = map.getContainer().getBoundingClientRect();
    const cx = rect.left + rect.width / 2 + _inspOff.x;
    const cy = rect.top + rect.height / 2 + _inspOff.y;
    return { ringCenter, sampled: { x: cx, y: cy } };
  });
  ok('the ring is drawn exactly where the pixel was read from',
     Math.abs(r.ringCenter.x - r.sampled.x) < 1 && Math.abs(r.ringCenter.y - r.sampled.y) < 1,
     JSON.stringify(r));
}

console.log('\n4. dragging it still works, and still lands where it says it does');
{
  const r = await p.evaluate(async () => {
    const settle = () => new Promise(res => requestAnimationFrame(res));
    _inspResetPos();
    await settle();
    const before = document.getElementById('inspector-crosshair').getBoundingClientRect();
    const handle = document.getElementById('inspector-drag-btn');
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: -40, bubbles: true }));
    await settle();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const after = document.getElementById('inspector-crosshair').getBoundingClientRect();
    const rect = map.getContainer().getBoundingClientRect();
    const expectX = rect.left + rect.width / 2 + 60;
    const expectY = rect.top + rect.height / 2 - 40;
    return {
      moved: Math.abs((after.left) - (before.left)) > 30,
      onTarget: Math.abs((after.left + after.width / 2) - expectX) < 1
             && Math.abs((after.top + after.height / 2) - expectY) < 1,
    };
  });
  ok('it actually moved when dragged', r.moved, JSON.stringify(r));
  ok('and landed exactly on the offset point, not just close to it', r.onTarget, JSON.stringify(r));
  ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
