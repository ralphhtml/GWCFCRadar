#!/usr/bin/env node
/*
 * iPhone and iPad stop crashing.
 *
 *     node tools/test-ios-memory.mjs
 *
 * WebKit on iOS gives a page a hard ceiling on canvas and compositing memory
 * and kills the tab past it: the "a problem repeatedly occurred" reload. The
 * page has an _isIOS budget for exactly this, and it had holes. The page is
 * loaded twice below, once as an iPad (which calls itself a Mac) and once as
 * a desktop, so each guard is proven to switch on for the one and stay off
 * for the other.
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

console.log('\n1. every guard is in the page');
{
  ok('an iPad that calls itself a Mac is still an iPad',
     /navigator\.platform === 'MacIntel' && navigator\.maxTouchPoints > 1/.test(PAGE));
  ok('iOS is stamped on the html element for the stylesheet',
     PAGE.includes("document.documentElement.classList.add('ios-lite')"));
  ok('the stylesheet sheds per-tile GPU layers, blurs and shadows on iOS',
     /html\.ios-lite \.leaflet-tile,[\s\S]*?will-change: auto !important/.test(PAGE)
     && /html\.ios-lite \*, html\.ios-lite \*::before[\s\S]*?backdrop-filter: none !important/.test(PAGE)
     && /html\.ios-lite \.leaflet-marker-icon img \{ filter: none !important; \}/.test(PAGE));
  ok('the basemap stops fetching tiles mid-pinch on iOS',
     /keepBuffer: _isIOS \? 2 : 8, updateWhenZooming: !_isIOS, updateWhenIdle: _isIOS/.test(PAGE));
  ok('the keyless stand-in does the same and skips @2x tiles on iOS',
     PAGE.includes("_isIOS ? url.replace('{r}', '') : url")
     && /keepBuffer: _isIOS \? 2 : 8, updateWhenZooming: !_isIOS,\s*updateWhenIdle: _isIOS \}, opts/.test(PAGE));
  ok('satellite tiles are not fetched at four times the pixels on iOS',
     PAGE.includes('detectRetina: !_isIOS,'));
  ok('the three canvas renderers pad far less on iOS',
     PAGE.includes("L.canvas({ pane: 'alertsPane', padding: _isIOS ? 0.1 : 0.3 })")
     && PAGE.includes('L.canvas({ padding: _isIOS ? 0.15 : 0.5 })')
     && PAGE.includes("L.canvas({ pane: 'bordersPane', padding: _isIOS ? 0.1 : 0.25 })"));
  ok('on iOS a radar picture releases its drawing canvas the moment the PNG exists',
     PAGE.includes('if (_isIOS) { try { canvas.width = canvas.height = 0; } catch (e) {} }')
     && PAGE.includes('canvas: _isIOS ? null : canvas,')
     && !/url: canvas\.toDataURL\('image\/png'\),\s*canvas: canvas,/.test(PAGE));
  ok('the picture cache and satellite pool are shallower on iOS',
     PAGE.includes('const L3_PIC_MAX = _isIOS ? 2 : 6;')
     && PAGE.includes('const GOES_POOL_MAX = _isIOS ? 3 : 12;'));
  ok('the 100 MB city parse is skipped on iOS, where deviceMemory is never reported',
     PAGE.includes("conn.saveData || _isIOS) { _cityWebTiles = 'failed'"));
  ok('a hidden tab sheds its rebuildable caches on iOS',
     /function _memShed\(\)[\s\S]*?_l3Pic\.clear\(\)/.test(PAGE)
     && /if \(document\.hidden\) _memShed\(\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-ios-memory.mjs'), 'utf8').includes(EM));
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

async function load(asIpad) {
  const ctx = await b.newContext({ viewport: { width: 1024, height: 768 },
    userAgent: asIpad
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
      : undefined });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
  await p.addInitScript(ipad => {
    try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
    if (ipad) {
      // What iPadOS 13+ actually reports: a Mac, with fingers.
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
    }
  }, asIpad);
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
  const r = await p.evaluate(() => {
    const out = {};
    out.isIOS = _isIOS;
    out.lite = document.documentElement.classList.contains('ios-lite');
    const o = mapTileLayers.dark.options;
    out.base = { zooming: o.updateWhenZooming, idle: o.updateWhenIdle, buf: o.keepBuffer };
    out.alertPad = _alertsCanvas().options.padding;
    out.mapWillChange = getComputedStyle(document.getElementById('map')).willChange;
    out.picMax = L3_PIC_MAX;
    out.goesMax = GOES_POOL_MAX;
    out.cities = _cityWebLoad();
    window._mtFallBack();
    out.fallbackUrl = mapTileLayers.dark._url || '';
    out.fallbackZooming = mapTileLayers.dark.options.updateWhenZooming;
    return out;
  });
  r.errs = errs;
  await ctx.close();
  return r;
}

console.log('\n2. loaded as an iPad, every budget tightens');
{
  const r = await load(true);
  ok('the Mac-with-fingers is recognised as iOS', r.isIOS === true && r.lite === true,
     JSON.stringify({ isIOS: r.isIOS, lite: r.lite }));
  ok('the basemap waits for the pinch to end and keeps a slim buffer',
     r.base.zooming === false && r.base.idle === true && r.base.buf === 2,
     JSON.stringify(r.base));
  ok('the alert canvas pads a tenth, not a third', r.alertPad === 0.1, String(r.alertPad));
  ok('the map is no longer forced onto its own GPU layer',
     r.mapWillChange === 'auto', r.mapWillChange);
  ok('the picture cache holds two and the satellite pool three',
     r.picMax === 2 && r.goesMax === 3, `${r.picMax} / ${r.goesMax}`);
  ok('the city web tier declines on iOS', r.cities === 'failed', String(r.cities));
  ok('the stand-in basemap skips @2x tiles and mid-pinch fetches',
     !r.fallbackUrl.includes('{r}') && r.fallbackZooming === false, r.fallbackUrl);
  ok('and nothing threw', r.errs.length === 0, r.errs.slice(0, 3).join(' | '));
}

console.log('\n3. loaded as a desktop, nothing changes');
{
  const r = await load(false);
  ok('a desktop is not iOS', r.isIOS === false && r.lite === false);
  ok('the basemap keeps its eager tile loading and deep buffer',
     r.base.zooming === true && r.base.buf === 8, JSON.stringify(r.base));
  ok('the alert canvas keeps its full padding', r.alertPad === 0.3, String(r.alertPad));
  ok('the map keeps its GPU layer hint', r.mapWillChange === 'transform', r.mapWillChange);
  ok('the caches keep their depth', r.picMax === 6 && r.goesMax === 12);
  ok('the stand-in keeps @2x tiles', r.fallbackUrl.includes('{r}'), r.fallbackUrl);
  ok('and nothing threw', r.errs.length === 0, r.errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
