#!/usr/bin/env node
/*
 * The ABI satellite picture stays on screen, and playback genuinely plays.
 *
 *     node tools/test-sat-playback.mjs
 *
 * Two long-standing complaints, one cause each:
 *
 * Disappearing: the 60-second live refresh used to tear the whole layer
 * down and rebuild it every minute, even though the ten-minute frame grid
 * only changes a tenth of the time - and the WMS URL carried a per-build
 * cache-bust, so the rebuild was always a full refetch. The picture
 * vanished and slowly crawled back, once a minute, forever. The refresh
 * now rebuilds only when the grid has really rolled forward, and the swap
 * (_goesSwapFrames) keeps the old picture on the map until the new one
 * has actually loaded.
 *
 * Playback: stepping onto a frame whose tiles had not arrived yet swapped
 * to it immediately, so the map flashed empty on every step past the
 * preloaded window - and thanks to the cache-bust, the second lap of the
 * loop refetched everything again. Now the last picture that finished
 * loading holds the screen until the next one is ready
 * (_goesShownLayer), and a fixed TIME is cacheable, so laps get faster.
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

console.log('\n1. the machinery is in the page');
{
  ok('the WMS layers carry no cache-bust: TIME names the picture, the cache may keep it',
     PAGE.includes('L.tileLayer.wms(cfg.url, opts)')
     && !PAGE.includes('?_cb='));
  ok('a shown-layer is tracked, so an unloaded frame never blanks the map',
     /let _goesShownLayer = null;/.test(PAGE)
     && /const keep = \(tgt && !_goesPoolLoaded\[idx\]\) \? _goesShownLayer : null;/.test(PAGE));
  ok('a frame promotes itself the moment it loads, ending the hold',
     /_goesPoolLoaded\[i\] = true;\s*\n[\s\S]{0,400}?if \(goesCurrentFrame === i && activeLayers\.satellite && _goesPool\[i\] === l\)/.test(PAGE));
  ok('eviction spares the picture on the glass while the jumped-to frame loads',
     /if \(_goesPool\[i\] === _goesShownLayer && !_goesPoolLoaded\[idx\]\) continue;/.test(PAGE));
  ok('the live refresh skips rebuilding an unchanged frame list',
     /cur\[cur\.length - 1\]\.timeStr === fresh\[fresh\.length - 1\]\.timeStr\) return;/.test(PAGE)
     && /_goesSwapFrames\(fresh\);/.test(PAGE));
  ok('a parsing server composite refresh asks first and keeps the picture on a failed or empty answer',
     /if \(_goesIsPi\(\)\) \{ _goesRefreshPiFrames\(\); return; \}/.test(PAGE)
     && /async function _goesRefreshPiFrames\(\) \{[\s\S]*?if \(!frames \|\| !frames\.length\) return;/.test(PAGE));
  ok('the swap holds the old picture until the new current frame has loaded',
     /function _goesSwapFrames\(frames\) \{/.test(PAGE)
     && /if \(!l \|\| _goesPoolLoaded\[goesCurrentFrame\]\) drop\(\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sat-playback.mjs'), 'utf8').includes(EM));
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
  try { localStorage.setItem('gwcfc_mode', 'expert'); } catch (e) {}
});
// A one-pixel PNG for every WMS tile. `slowTiles` makes NEW tile requests
// take a beat, which is what lets the hold be observed deterministically.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64');
let slowTiles = false;
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('mesonet.agron.iastate.edu') && /request=getmap/i.test(url)) {
    const done = () => route.fulfill({ contentType: 'image/png', body: PNG }).catch(() => {});
    if (slowTiles) setTimeout(done, 1200); else done();
    return;
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4500);
// The What Changed modal's own open attempt is on a delayed timer inside
// _actuallyDismiss, so closing it once here would only race that timer;
// marking it seen stops the delayed attempt from ever opening it.
await p.evaluate(() => {
  try { if (typeof _clMarkSeen === 'function') _clMarkSeen(); } catch (e) {}
  const m = document.getElementById('changelog-modal');
  if (m) m.classList.remove('open');
});

console.log('\n2. an ABI band comes up with real frames, loaded, playable');
{
  const r = await p.evaluate(async () => {
    _setGoesProduct('ch13');
    const t0 = Date.now();
    while ((!goesFrames.length || !_goesPoolLoaded[goesCurrentFrame])
           && Date.now() - t0 < 20000)
      await new Promise(res => setTimeout(res, 100));
    return {
      frames: goesFrames.length,
      poolMax: GOES_POOL_MAX,
      ready: _animationReady(),
      playEnabled: !document.getElementById('play-btn').disabled,
      loadedCurrent: !!_goesPoolLoaded[goesCurrentFrame],
      shownIsCurrent: _goesShownLayer === _goesPool[goesCurrentFrame],
      atNewest: goesCurrentFrame === goesFrames.length - 1,
    };
  });
  ok('hours of frames, more than the pool holds, so the loop outruns the window',
     r.frames > r.poolMax, JSON.stringify(r));
  ok('the newest frame is showing and has genuinely loaded',
     r.atNewest && r.loadedCurrent, JSON.stringify(r));
  ok('the loaded picture is the tracked shown-layer', r.shownIsCurrent);
  ok('play is ready and the button agrees', r.ready && r.playEnabled, JSON.stringify(r));
}

console.log('\n3. jumping to a far, unloaded frame holds the old picture instead of blanking');
slowTiles = true;
{
  const r = await p.evaluate(async () => {
    const out = {};
    out.prevIdx = goesCurrentFrame;
    const prevLayer = _goesPool[out.prevIdx];
    showGoesFrame(0);
    out.jumpedFar = out.prevIdx >= GOES_POOL_MAX;
    out.targetVisible = !!_goesPool[0] && _goesPool[0].options.opacity > 0;
    out.heldVisible = !!prevLayer && prevLayer.options.opacity > 0;
    out.heldOnMap = !!(prevLayer && map.hasLayer(prevLayer));
    out.shownStillPrev = _goesShownLayer === prevLayer;
    const t0 = Date.now();
    while (!_goesPoolLoaded[0] && Date.now() - t0 < 20000)
      await new Promise(res => setTimeout(res, 100));
    out.loaded = !!_goesPoolLoaded[0];
    out.promoted = _goesShownLayer === _goesPool[0];
    out.heldHiddenAfter = !prevLayer || prevLayer.options.opacity === 0;
    return out;
  });
  ok('the jump really was past the preloaded window', r.jumpedFar, JSON.stringify(r));
  ok('the target frame goes visible immediately and starts loading', r.targetVisible);
  ok('the old picture stays on the map, still showing, not evicted',
     r.heldVisible && r.heldOnMap && r.shownStillPrev, JSON.stringify(r));
  ok('the target finishes loading and promotes itself', r.loaded && r.promoted,
     JSON.stringify(r));
  ok('and only then is the old picture hidden', r.heldHiddenAfter);
}

console.log('\n4. the play button really advances frames, and lands on a single visible picture');
slowTiles = false;
{
  const r = await p.evaluate(async () => {
    const start = goesCurrentFrame;
    const btn = document.getElementById('play-btn');
    btn.click();
    const nowPlaying = playing;
    await new Promise(res => setTimeout(res, 1500));
    btn.click();
    const stopped = !playing;
    const moved = goesCurrentFrame;
    const t0 = Date.now();
    while (!_goesPoolLoaded[goesCurrentFrame] && Date.now() - t0 < 20000)
      await new Promise(res => setTimeout(res, 100));
    const vis = [];
    _goesPool.forEach((l, i) => { if (l && l.options.opacity > 0) vis.push(i); });
    return { start, nowPlaying, moved, stopped, vis, cur: goesCurrentFrame };
  });
  ok('clicking play starts it', r.nowPlaying === true, JSON.stringify(r));
  ok('frames genuinely advance on the real clock', r.moved !== r.start, JSON.stringify(r));
  ok('clicking again stops it', r.stopped === true);
  ok('once the landed frame loads, it is the one and only visible picture',
     r.vis.length === 1 && r.vis[0] === r.cur, JSON.stringify(r));
}

console.log('\n5. a refresh swap keeps the picture on the glass through the whole rebuild');
slowTiles = true;
{
  const r = await p.evaluate(async () => {
    const t0 = Date.now();
    while (!_goesPoolLoaded[goesCurrentFrame] && Date.now() - t0 < 20000)
      await new Promise(res => setTimeout(res, 100));
    const held = _goesShownLayer;
    const out = { hadHeld: !!held };
    _goesSwapFrames(_buildGoesFrames());
    out.heldStillOnMap = !!(held && map.hasLayer(held));
    out.heldStillShowing = !!held && held.options.opacity > 0;
    const t1 = Date.now();
    while (!_goesPoolLoaded[goesCurrentFrame] && Date.now() - t1 < 20000)
      await new Promise(res => setTimeout(res, 100));
    await new Promise(res => setTimeout(res, 400));
    out.heldGone = !(held && map.hasLayer(held));
    out.newShown = _goesShownLayer === _goesPool[goesCurrentFrame];
    return out;
  });
  ok('there was a picture to hold', r.hadHeld);
  ok('through the teardown it stays on the map, still showing',
     r.heldStillOnMap && r.heldStillShowing, JSON.stringify(r));
  ok('once the new frame loads, the held picture is dropped', r.heldGone, JSON.stringify(r));
  ok('and the new frame is the tracked shown-layer', r.newShown);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
