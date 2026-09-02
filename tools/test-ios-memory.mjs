#!/usr/bin/env node
/*
 * iPhone and iPad stop crashing.
 *
 *     node tools/test-ios-memory.mjs
 *
 * WebKit on iOS gives a page a hard ceiling on canvas and compositing memory
 * and kills the tab past it: the "a problem repeatedly occurred" reload, or
 * a silent reload when it is the whole process rather than one canvas. The
 * page has an _isIOS budget for exactly this, split into a phone tier and a
 * tablet tier. The page is loaded three times below, as an iPhone, as an
 * iPad (which calls itself a Mac), and as a desktop, so each guard is proven
 * to switch on for the right device and stay off for the desktop.
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
  ok('iOS is stamped on the html element, and phones are told from tablets',
     PAGE.includes("document.documentElement.classList.add('ios-lite')")
     && PAGE.includes('const _iosPhone = _isIOS && Math.min(screen.width || 0, screen.height || 0) < 700;'));
  ok('the stylesheet sheds per-tile GPU layers, blurs, shadows and zoom-time promotion on iOS',
     /html\.ios-lite \.leaflet-tile,[\s\S]*?will-change: auto !important/.test(PAGE)
     && /html\.ios-lite \*, html\.ios-lite \*::before[\s\S]*?backdrop-filter: none !important/.test(PAGE)
     && /html\.ios-lite \.leaflet-marker-icon img \{ filter: none !important; \}/.test(PAGE)
     && PAGE.includes('html.ios-lite .leaflet-zoom-anim .leaflet-zoom-animated { will-change: auto !important; }'));
  ok('Leaflet stops drawing canvases at double density and animating tiles on iOS',
     PAGE.includes('if (_isIOS) { try { L.Browser.retina = false; } catch (e) {} }')
     && PAGE.includes('fadeAnimation: !_isIOS,')
     && PAGE.includes('markerZoomAnimation: !_isIOS,'));
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
  ok('the caches and pools are shallowest on a phone, shallow on a tablet',
     PAGE.includes('const L3_PIC_MAX = _isIOS ? 1 : 6;')
     && PAGE.includes('const GOES_POOL_MAX = _isIOS ? (_iosPhone ? 2 : 3) : 12;')
     && PAGE.includes('const MRMS_WINDOW = _isIOS ? (_iosPhone ? 2 : 3) : 14;')
     && PAGE.includes('const sz = _iosPhone ? 4 : 6, half = _iosPhone ? 2 : 3;'));
  ok('radar loops are shorter and gentler on iOS, budgeted by decoded size',
     PAGE.includes('MESH_MAX_PX = _iosPhone ? 1200 : 1600;')
     && PAGE.includes('mb = (_iosPhone ? 16 : 24) * PB_FRAME_MB;')
     && PAGE.includes('return _isIOS ? (_iosPhone ? 8 : 10) : 20;'));
  ok('the Inspector reads through one small zeroing cache, never a canvas per read',
     PAGE.includes('const INSP_PX_MAX = 4;')
     && PAGE.split('_inspPixelCanvas(found)').length === 3
     && !/canvas\.width = found\.naturalWidth/.test(PAGE)
     && /function _inspPxDropEntry\(e\) \{\s*try \{ e\.ctx\.canvas\.width = e\.ctx\.canvas\.height = 0; \}/.test(PAGE));
  ok('the sea temperature loader frees its three full-size canvases as it goes',
     PAGE.split('cv.width = cv.height = 0').length >= 4
     && PAGE.includes('mask.width = mask.height = 0'));
  ok('the 100 MB city parse is skipped on iOS, where deviceMemory is never reported',
     PAGE.includes("conn.saveData || _isIOS) { _cityWebTiles = 'failed'"));
  ok('a hidden tab sheds its rebuildable caches on iOS',
     /function _memShed\(\)[\s\S]*?_l3Pic\.clear\(\)[\s\S]*?_inspPxClear\(\)/.test(PAGE)
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

const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' },
  tablet: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, macWithFingers: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' },
  desktop: { viewport: { width: 1280, height: 800 } },
};

async function load(kind) {
  const dev = DEVICES[kind];
  const ctx = await b.newContext({ viewport: dev.viewport,
    deviceScaleFactor: dev.deviceScaleFactor || 1, userAgent: dev.userAgent });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
  await p.addInitScript(mac => {
    try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
    if (mac) {
      // What iPadOS 13+ actually reports: a Mac, with fingers.
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
    }
  }, !!dev.macWithFingers);
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
    out.phone = _iosPhone;
    out.lite = document.documentElement.classList.contains('ios-lite');
    out.retina = L.Browser.retina;
    out.fade = map.options.fadeAnimation;
    const o = mapTileLayers.dark.options;
    out.base = { zooming: o.updateWhenZooming, idle: o.updateWhenIdle, buf: o.keepBuffer };
    out.alertPad = _alertsCanvas().options.padding;
    out.mapWillChange = getComputedStyle(document.getElementById('map')).willChange;
    out.picMax = L3_PIC_MAX;
    out.goesMax = GOES_POOL_MAX;
    out.mrmsWin = MRMS_WINDOW;
    out.loopMax = L3_LOOP_MAX;
    out.l2Max = _l2LoopMax();
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
  const r = await load('tablet');
  ok('the Mac-with-fingers is recognised as iOS, and as a tablet',
     r.isIOS === true && r.lite === true && r.phone === false,
     JSON.stringify({ isIOS: r.isIOS, lite: r.lite, phone: r.phone }));
  ok('Leaflet draws single density and does not fade tiles',
     r.retina === false && r.fade === false, JSON.stringify({ retina: r.retina, fade: r.fade }));
  ok('the basemap waits for the pinch to end and keeps a slim buffer',
     r.base.zooming === false && r.base.idle === true && r.base.buf === 2,
     JSON.stringify(r.base));
  ok('the alert canvas pads a tenth, not a third', r.alertPad === 0.1, String(r.alertPad));
  ok('the map is no longer forced onto its own GPU layer',
     r.mapWillChange === 'auto', r.mapWillChange);
  ok('the picture cache holds one, satellite three, MRMS three',
     r.picMax === 1 && r.goesMax === 3 && r.mrmsWin === 3,
     `${r.picMax} / ${r.goesMax} / ${r.mrmsWin}`);
  ok('the archive loop is 24 frames and the Level 2 loop 10',
     r.loopMax === 24 && r.l2Max === 10, `${r.loopMax} / ${r.l2Max}`);
  ok('the city web tier declines on iOS', r.cities === 'failed', String(r.cities));
  ok('the stand-in basemap skips @2x tiles and mid-pinch fetches',
     !r.fallbackUrl.includes('{r}') && r.fallbackZooming === false, r.fallbackUrl);
  ok('and nothing threw', r.errs.length === 0, r.errs.slice(0, 3).join(' | '));
}

console.log('\n3. loaded as an iPhone, tighter still');
{
  const r = await load('phone');
  ok('an iPhone is iOS, and a phone',
     r.isIOS === true && r.phone === true && r.lite === true,
     JSON.stringify({ isIOS: r.isIOS, phone: r.phone }));
  ok('satellite and MRMS hold two frames each',
     r.goesMax === 2 && r.mrmsWin === 2, `${r.goesMax} / ${r.mrmsWin}`);
  ok('the archive loop is 16 frames and the Level 2 loop 8',
     r.loopMax === 16 && r.l2Max === 8, `${r.loopMax} / ${r.l2Max}`);
  ok('single density, no tile fades, slim basemap buffer',
     r.retina === false && r.fade === false && r.base.zooming === false && r.base.buf === 2,
     JSON.stringify({ retina: r.retina, fade: r.fade, base: r.base }));
  ok('and nothing threw', r.errs.length === 0, r.errs.slice(0, 3).join(' | '));
}

console.log('\n4. loaded as a desktop, nothing changes');
{
  const r = await load('desktop');
  ok('a desktop is not iOS', r.isIOS === false && r.lite === false && r.phone === false);
  ok('tiles still fade in', r.fade === true);
  ok('the basemap keeps its eager tile loading and deep buffer',
     r.base.zooming === true && r.base.buf === 8, JSON.stringify(r.base));
  ok('the alert canvas keeps its full padding', r.alertPad === 0.3, String(r.alertPad));
  ok('the map keeps its GPU layer hint', r.mapWillChange === 'transform', r.mapWillChange);
  ok('the caches keep their depth',
     r.picMax === 6 && r.goesMax === 12 && r.mrmsWin === 14 && r.l2Max === 20,
     `${r.picMax} / ${r.goesMax} / ${r.mrmsWin} / ${r.l2Max}`);
  ok('the stand-in keeps @2x tiles', r.fallbackUrl.includes('{r}'), r.fallbackUrl);
  ok('and nothing threw', r.errs.length === 0, r.errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
