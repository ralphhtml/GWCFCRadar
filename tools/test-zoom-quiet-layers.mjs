#!/usr/bin/env node
/*
 * The graticule (the faint lat/lon grid, always on) and the wind barbs (an
 * opt-in overlay) were the only two custom canvases left redrawing on
 * Leaflet's live 'zoom' event - every other heavy layer in this file
 * (the radar tile pool, the wind and wave particle systems) already hides
 * itself for the length of a zoom and picks back up once it settles,
 * because recomputing anything mid-animation is exactly the lag a zoom
 * report keeps describing. This checks both layers actually go quiet
 * between zoomstart and zoomend, and come back once it is over.
 *
 *     node tools/test-zoom-quiet-layers.mjs
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

console.log('\n1. neither canvas is still wired to the live zoom event');
{
  ok('the graticule no longer redraws on bare \'zoom\'',
     /map\.on\('move moveend zoomend resize', _gratDraw\)/.test(PAGE)
     && !/map\.on\('move zoom moveend zoomend resize', _gratDraw\)/.test(PAGE));
  ok('it hides at zoomstart and returns at zoomend instead',
     /map\.on\('zoomstart', \(\) => \{ canvas\.style\.visibility = 'hidden'; \}\);\s*\n\s*map\.on\('zoomend', \(\) => \{ canvas\.style\.visibility = ''; \}\);/.test(PAGE));
  ok('the wind barbs no longer redraw on bare \'zoom\' either',
     !/map\.on\('zoom', _barbDraw\)/.test(PAGE));
  ok('they hide at zoomstart and redraw once at zoomend',
     /map\.on\('zoomstart', \(\) => \{ if \(_barbCanvas\) _barbCanvas\.style\.visibility = 'hidden'; \}\);/.test(PAGE)
     && /map\.on\('zoomend', \(\) => \{\s*\n\s*if \(!_barbCanvas\) return;\s*\n\s*_barbCanvas\.style\.visibility = '';\s*\n\s*if \(_barbActive\) _barbDraw\(\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-zoom-quiet-layers.mjs'), 'utf8').includes(EM));
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
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
const fakeTile = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64');
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (/\.(png|jpg|jpeg|gif|webp)(\?|$)/i.test(url) || /tile|wms|cgi-bin/i.test(url))
    return route.fulfill({ contentType: 'image/png', body: fakeTile });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4500);

console.log('\n2. the grid actually goes quiet during a real zoom');
{
  const r = await p.evaluate(async () => {
    if (typeof _barbStart === 'function') _barbStart();
    await new Promise(res => setTimeout(res, 300));
    const grat = document.getElementById('graticule-canvas');
    const barb = document.getElementById('wind-barbs-canvas');
    const out = { midZoomGrat: null, midZoomBarb: null };
    map.once('zoomstart', () => {
      out.midZoomGrat = getComputedStyle(grat).visibility;
      out.midZoomBarb = barb ? getComputedStyle(barb).visibility : null;
    });
    map.setZoom(map.getZoom() + 2, { animate: true });
    await new Promise(res => setTimeout(res, 120));   // still mid-animation
    out.duringGrat = getComputedStyle(grat).visibility;
    out.duringBarb = barb ? getComputedStyle(barb).visibility : null;
    await new Promise(res => setTimeout(res, 400));   // settled
    out.afterGrat = getComputedStyle(grat).visibility;
    out.afterBarb = barb ? getComputedStyle(barb).visibility : null;
    return out;
  });
  ok('the graticule hides the instant a zoom starts',
     r.midZoomGrat === 'hidden', JSON.stringify(r));
  ok('and stays hidden through the animation',
     r.duringGrat === 'hidden', JSON.stringify(r));
  ok('then reappears once the zoom settles',
     r.afterGrat === 'visible', JSON.stringify(r));
  ok('the wind barbs hide the instant a zoom starts too',
     r.midZoomBarb === 'hidden', JSON.stringify(r));
  ok('and stay hidden through the animation',
     r.duringBarb === 'hidden', JSON.stringify(r));
  ok('then reappear once the zoom settles',
     r.afterBarb === 'visible', JSON.stringify(r));
  ok('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
