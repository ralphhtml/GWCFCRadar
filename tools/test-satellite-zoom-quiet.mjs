#!/usr/bin/env node
/*
 * "When zooming and in and out or moving, especially zooming, it takes a
 * while for the satellite to load, like unusually long." The radar tile
 * pool, the wind particles and the wave particles all already detach
 * every off-screen frame for the length of a zoom and rebuild once it
 * settles (see the zoomstart/zoomend pair in initMap and its own comment
 * about "exactly the zoom lag people felt") - satellite's WMS pool never
 * got the same treatment. A held scroll-wheel zoom applies many small,
 * non-animated zoom steps (see _wireWheelZoom), and each one is a real
 * zoomend for every pooled layer still attached to the map: up to
 * GOES_POOL_MAX WMS tile layers, each server-rendered on request rather
 * than served from a pre-built pyramid, all re-fetching their whole
 * viewport at once, on every single step of the scroll. That pile-up
 * repeating throughout the gesture is what made satellite in particular
 * look unusually slow to catch up once zooming stopped.
 *
 *     node tools/test-satellite-zoom-quiet.mjs
 *
 * Uses the real Leaflet build, because the whole point is whether real
 * pooled layers actually detach and reattach around a real zoom.
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
  ok('a zoomstart handler for the satellite pool exists',
     /function _goesOnZoomStart\(\) \{/.test(PAGE));
  ok('a zoomend handler for the satellite pool exists',
     /function _goesOnZoomEnd\(\) \{/.test(PAGE));
  ok('both are wired to the map, the same way the graticule wires its own pair',
     /_initGraticule\(\);\s*\n\s*map\.on\('zoomstart', _goesOnZoomStart\);\s*\n\s*map\.on\('zoomend', _goesOnZoomEnd\);/.test(PAGE));
  ok('zoomstart leaves the current frame alone and drops the rest',
     /function _goesOnZoomStart\(\) \{\s*\n(\s*_goesFillTok\+\+;\s*\n)?\s*if \(!activeLayers\.satellite \|\| !_goesPool\.length\) return;\s*\n\s*for \(let i = 0; i < _goesPool\.length; i\+\+\) \{\s*\n\s*if \(i === goesCurrentFrame\) continue;/.test(PAGE));
  ok('zoomend debounces the rebuild rather than firing on every step',
     /function _goesOnZoomEnd\(\) \{[\s\S]{0,200}setTimeout\([\s\S]{0,120}, 300\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-satellite-zoom-quiet.mjs'), 'utf8').includes(EM));
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
  // WMS tile requests are irrelevant to this test (JS pool bookkeeping
  // only) and would just hang against a real server, so they are aborted
  // like everything else not needed to boot the page.
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. a held zoom drops every pooled satellite frame but the one on screen');
{
  const r = await p.evaluate(async () => {
    activeLayers.satellite = true;
    goesFrames = _buildGoesFrames();
    goesCurrentFrame = goesFrames.length - 1;
    showGoesFrame(goesCurrentFrame);
    // Give every pooled layer's WMS request a moment to be issued so it is
    // a real, attached layer at the time zoomstart fires below.
    await new Promise(res => setTimeout(res, 150));
    const beforeCount = _goesPool.filter(Boolean).length;
    const beforeOnMap = _goesPool.filter(l => l && map.hasLayer(l)).length;

    map.fire('zoomstart');

    const afterCount = _goesPool.filter(Boolean).length;
    const currentStillPooled = !!_goesPool[goesCurrentFrame];
    const currentStillOnMap = !!(_goesPool[goesCurrentFrame]
      && map.hasLayer(_goesPool[goesCurrentFrame]));
    return { beforeCount, beforeOnMap, afterCount, currentStillPooled, currentStillOnMap,
             poolMax: GOES_POOL_MAX };
  });
  ok('more than one frame was actually pooled before the zoom, or this test proves nothing',
     r.beforeCount > 1, JSON.stringify(r));
  ok('every pooled frame started out attached to the map',
     r.beforeOnMap === r.beforeCount, JSON.stringify(r));
  ok('zoomstart drops every frame but the current one',
     r.afterCount === 1, JSON.stringify(r));
  ok('the current frame is left in the pool',
     r.currentStillPooled, JSON.stringify(r));
  ok('and stays attached to the map, so the picture on screen does not blank out',
     r.currentStillOnMap, JSON.stringify(r));
}

console.log('\n3. zoomend rebuilds the window once the zoom actually settles, not on every step');
{
  const r = await p.evaluate(async () => {
    map.fire('zoomend');
    const immediately = _goesPool.filter(Boolean).length;
    // A second zoomend before the debounce fires, the way a fast scroll
    // sends many in a row - only the last one should end up rebuilding.
    map.fire('zoomend');
    await new Promise(res => setTimeout(res, 500));
    const afterSettle = _goesPool.filter(Boolean).length;
    return { immediately, afterSettle };
  });
  ok('the pool is not rebuilt the instant zoomend fires',
     r.immediately === 1, JSON.stringify(r));
  ok('it is rebuilt once the debounce has actually elapsed',
     r.afterSettle > 1, JSON.stringify(r));
}

console.log('\n4. satellite being off means the zoom handlers do nothing at all');
{
  const r = await p.evaluate(async () => {
    activeLayers.satellite = false;
    const before = _goesPool.filter(Boolean).length;
    map.fire('zoomstart');
    const afterStart = _goesPool.filter(Boolean).length;
    map.fire('zoomend');
    await new Promise(res => setTimeout(res, 500));
    const afterEnd = _goesPool.filter(Boolean).length;
    activeLayers.satellite = true; // leave state as found for anything after
    return { before, afterStart, afterEnd };
  });
  ok('nothing was torn down while satellite is off',
     r.afterStart === r.before, JSON.stringify(r));
  ok('and nothing was rebuilt either', r.afterEnd === r.before, JSON.stringify(r));
}

ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
