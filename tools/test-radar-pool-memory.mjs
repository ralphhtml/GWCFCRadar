#!/usr/bin/env node
/*
 * The national radar mosaic keeps one full Leaflet tile layer per
 * animation frame (_radarLayerPool). _activateWindow used to have no
 * eviction at all - once a frame's layer was built it stayed attached to
 * the map forever, so repeated zooming/panning around (which rebuilds the
 * active window on every zoomend) silently grew the pool without bound.
 * iOS Safari's per-tab memory ceiling is much lower than desktop's, and
 * that unbounded growth is what was crashing it with "This webpage was
 * reloaded because it was using too much memory" after enough zoom/pan.
 *
 * This proves two things stay true after the fix: iOS keeps a small,
 * sliding window (old frames actually get evicted, not just deferred),
 * and desktop's "preload every frame" behavior for smooth animation is
 * untouched.
 *
 *     node tools/test-radar-pool-memory.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});

async function bootPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**://**', route => {
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
  await page.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  return { page, errors };
}

function seedFrames(n) {
  const now = Math.floor(Date.now() / 1000);
  return Array.from({ length: n }, (_, i) => ({
    tileKey: 'synthframe' + i,
    iso: new Date((now - (n - i) * 300) * 1000).toISOString().slice(0, 19) + 'Z',
    time: now - (n - i) * 300,
    forecast: false,
  }));
}

console.log('\n1. iOS: the pool stays a small sliding window as frames are scrubbed');
{
  const iosCtx = await browser.newContext({ userAgent: IPHONE_UA });
  const { page, errors } = await bootPage(iosCtx);

  const r = await page.evaluate((frames) => {
    radarFrames = frames;
    currentFrame = 0;
    activeLayers.nexrad = true;
    _buildRadarPool();
    const counts = [];
    // Simulate scrubbing/zooming across the whole range, the way zoomend
    // re-running _activateWindow(currentFrame) would in real use.
    [0, 5, 10, 15, 19, 10, 3, 19].forEach(idx => {
      _activateWindow(idx);
      counts.push(_radarLayerPool.filter(Boolean).length);
    });
    return { isIOS: _isIOS, counts };
  }, seedFrames(20));

  ok('the page really did detect an iOS user agent', r.isIOS === true, String(r.isIOS));
  ok('the pool never grows past the capped window size, no matter how far scrubbed',
     r.counts.every(c => c <= 6), JSON.stringify(r.counts));
  ok('nothing threw while building/evicting the pool', errors.length === 0, errors.join(' | '));

  const rebuild = await page.evaluate(() => {
    // Frame 0 should have been evicted by the jump to 19 - scrubbing back
    // to it must rebuild its layer rather than leaving it permanently gone.
    const beforeAny = _radarLayerPool.filter(Boolean).length;
    _activateWindow(0);
    return { rebuilt: !!_radarLayerPool[0], beforeAny };
  });
  ok('scrubbing back to an evicted frame rebuilds its layer',
     rebuild.rebuilt, JSON.stringify(rebuild));

  await page.close();
  await iosCtx.close();
}

console.log('\n2. desktop: still preloads every frame at normal zoom (unchanged)');
{
  const desktopCtx = await browser.newContext();
  const { page, errors } = await bootPage(desktopCtx);

  const r = await page.evaluate(async (frames) => {
    radarFrames = frames;
    currentFrame = 0;
    activeLayers.nexrad = true;
    map.setZoom(7);
    _buildRadarPool();
    _activateWindow(0);
    // The window fills in timed batches now (the burst of simultaneous
    // tile requests was most of the post-zoom stutter), so the count is
    // read after the schedule has run, not the same tick it was asked.
    await new Promise(res => setTimeout(res, 2500));
    return { isIOS: _isIOS, poolLen: _radarLayerPool.length,
             count: _radarLayerPool.filter(Boolean).length };
  }, seedFrames(20));

  ok('this context is not detected as iOS', r.isIOS === false, String(r.isIOS));
  ok('every frame gets a layer at normal zoom, same as before the fix',
     r.count === 20, JSON.stringify(r));
  ok('nothing threw', errors.length === 0, errors.join(' | '));

  await page.close();
  await desktopCtx.close();
}

console.log('\n4. the machine\'s memory sizes the window, and a hidden tab sheds');
{
  const smallCtx = await browser.newContext();
  await smallCtx.addInitScript(() => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 });
  });
  const { page, errors } = await bootPage(smallCtx);
  const r = await page.evaluate((frames) => {
    radarFrames = frames;
    const w = _poolWindow(50);
    return { win: w.e - w.s + 1, goesMax: GOES_POOL_MAX };
  }, seedFrames(100));
  ok('a 4 GB machine gets a 12-frame radar window, not 24',
     r.win === 12, JSON.stringify(r));
  ok('and a 6-frame satellite pool, not 12', r.goesMax === 6, String(r.goesMax));
  ok('nothing threw', errors.length === 0, errors.join(' | '));
  await page.close();
  await smallCtx.close();

  const bigCtx = await browser.newContext();
  const big = await bootPage(bigCtx);
  const s = await big.page.evaluate(async (frames) => {
    radarFrames = frames;
    currentFrame = 3;
    activeLayers.nexrad = true;
    map.setZoom(7);
    _buildRadarPool();
    _activateWindow(3);
    await new Promise(res => setTimeout(res, 2500));
    const before = _radarLayerPool.filter(Boolean).length;
    // The 60-second hidden timer's job, run directly.
    _memShedHeavy();
    const after = _radarLayerPool.filter(Boolean).length;
    const keptCurrent = !!_radarLayerPool[3];
    // Coming back rebuilds from the shown frame, as the listener does.
    _activateWindow(currentFrame);
    await new Promise(res => setTimeout(res, 2500));
    const rebuilt = _radarLayerPool.filter(Boolean).length;
    return { before, after, keptCurrent, rebuilt,
             timerWired: typeof _memShedTimer !== 'undefined' };
  }, seedFrames(20));
  ok('a background shed drops every pooled frame but the one on screen',
     s.before >= 20 && s.after === 1 && s.keptCurrent, JSON.stringify(s));
  ok('and the pool rebuilds in full when the tab comes back',
     s.rebuilt === s.before, JSON.stringify(s));
  ok('the hidden-tab timer is wired for every platform, not just iOS',
     s.timerWired === true);
  ok('nothing threw', big.errors.length === 0, big.errors.join(' | '));
  await big.page.close();
  await bigCtx.close();
}

console.log('\n3. desktop: low zoom still caps the window (unchanged behavior)');
{
  const desktopCtx = await browser.newContext();
  const { page, errors } = await bootPage(desktopCtx);

  const r = await page.evaluate((frames) => {
    radarFrames = frames;
    currentFrame = 0;
    activeLayers.nexrad = true;
    // The map manages its own zoom during boot (home-location flyTo etc.),
    // so setZoom() here isn't reliable in a headless run - stub the read
    // instead, which is all _poolWindow actually looks at.
    const origGetZoom = map.getZoom.bind(map);
    map.getZoom = () => 2;
    _buildRadarPool();
    _activateWindow(0);
    const count = _radarLayerPool.filter(Boolean).length;
    map.getZoom = origGetZoom;
    return { count };
  }, seedFrames(20));

  ok('at low zoom the window is still capped at 5, same as before the fix',
     r.count <= 5, JSON.stringify(r));
  ok('nothing threw', errors.length === 0, errors.join(' | '));

  await page.close();
  await desktopCtx.close();
}

await browser.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
