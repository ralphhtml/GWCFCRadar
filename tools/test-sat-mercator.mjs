#!/usr/bin/env node
/*
 * Satellite pictures from the parsing server (the Time Machine's NOAA
 * archive frames, the composites, the global mosaic) are plain latitude and
 * longitude grids, and a Leaflet image overlay stretches a picture evenly in
 * MERCATOR. Drawn as they came, the clouds sat about 2 degrees south of
 * where they were over the middle of the US. Each picture is now resampled
 * onto Mercator rows before it is drawn.
 *
 *     node tools/test-sat-mercator.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) { console.log('playwright is not installed, skipping'); process.exit(0); }

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
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
await p.waitForTimeout(4000);
ok('the page boots clean', errs.length === 0, errs[0]);

// A plain lat/lon picture of the CONUS sector (16 to 52 N) with one red row
// at exactly 35 N, the way the parsing server makes them.
const setup = () => {
  window.__equirect = () => {
    const W = 200, H = 360, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = 'rgb(40,40,40)'; x.fillRect(0, 0, W, H);
    const row = Math.round((52 - 35) / (52 - 16) * H);
    x.fillStyle = 'rgb(255,0,0)'; x.fillRect(0, row - 1, W, 3);
    return c.toDataURL();
  };
  window.__redRow = (url) => new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, img.width, img.height).data;
      let sum = 0, n = 0;
      for (let y = 0; y < img.height; y++) {
        const o = (y * img.width + 5) * 4;
        if (d[o] > 200 && d[o + 1] < 60) { sum += y; n++; }
      }
      res({ row: n ? sum / n : -1, h: img.height });
    };
    img.src = url;
  });
};

console.log('\n1. a lat/lon picture is resampled so 35 N lands where Mercator puts 35 N');
{
  const r = await p.evaluate(async (s) => {
    eval('(' + s + ')()');
    const url = __equirect();
    const bounds = [[16, -125], [52, -65]];
    const blob = await _goesMercUrl(url, bounds);
    const got = await __redRow(blob);
    const before = await __redRow(url);
    const yN = _latToMercY(52), yS = _latToMercY(16);
    const want = (yN - _latToMercY(35)) / (yN - yS) * got.h;
    return { blob: /^blob:/.test(blob || ''), row: got.row, want, before: before.row, h: got.h };
  }, setup.toString());
  ok('the corrected picture is kept as a blob URL', r.blob, JSON.stringify(r));
  ok(`the 35 N line sits at Mercator's row for 35 N (${r.row.toFixed(1)} vs ${r.want.toFixed(1)})`,
     Math.abs(r.row - r.want) <= 1.5, JSON.stringify(r));
  ok('which is a real move: uncorrected, it was off by more than 5% of the picture',
     Math.abs(r.before - r.want) > r.h * 0.05, JSON.stringify(r));
}

console.log('\n2. the Time Machine and composite frames on the map use it');
{
  const r = await p.evaluate(async (s) => {
    eval('(' + s + ')()');
    activeLayers.satellite = true;
    const url = __equirect();
    goesFrames = [{ time: new Date(Date.UTC(2024, 5, 1, 18)), timeStr: 'x', url, bounds: [[16, -125], [52, -65]] }];
    goesCurrentFrame = 0;
    _goesPool = []; _goesPoolLoaded = [];
    _goesEnsureLayer(0);
    const l = _goesPool[0];
    const first = l._url;
    for (let i = 0; i < 50 && !/^blob:/.test(l._url); i++) await new Promise(res => setTimeout(res, 50));
    const bb = l.getBounds();
    const out = { first, now: l._url.slice(0, 5), south: bb.getSouth(), north: bb.getNorth() };
    try { map.removeLayer(l); } catch (e) {}
    _goesPool = []; goesFrames = []; activeLayers.satellite = false;
    return out;
  }, setup.toString());
  ok('it starts blank, so the uncorrected picture is never on screen', /^data:image\/gif/.test(r.first),
     r.first.slice(0, 30));
  ok('then shows the corrected picture over the same rectangle', r.now === 'blob:' && r.south === 16 && r.north === 52,
     JSON.stringify(r));
}

console.log('\n3. the satellite comparison panes use it too');
{
  const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
  ok('a parsing server satellite pane is filled through the same correction',
     /slot\.layer = L\.imageOverlay\(GOES_BLANK, _goesMercBounds\(f\.bounds\)/.test(PAGE)
     && /_goesMercApply\(slot\.layer, f\.url, f\.bounds\);/.test(PAGE));
  ok('and nothing draws a raw parsing server satellite URL any more', !/L\.imageOverlay\(f\.url, f\.bounds/.test(PAGE));
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
