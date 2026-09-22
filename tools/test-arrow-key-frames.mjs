#!/usr/bin/env node
/*
 * "When moving arrow keys left and right it moves the frames, LOVE IT, but
 * at the same time it also pans the map a bit." Leaflet's own keyboard
 * handler binds a bubble-phase keydown listener straight onto document the
 * moment the map is created, well before this app's own shortcut listener
 * exists, and Leaflet's handler pans on every arrow key by default. Once
 * that bubble-phase listener has already run, calling preventDefault()
 * from a later, bubble-phase listener here cannot undo the pan; it only
 * cancels the browser's own default action for the key, not another
 * listener's side effect that has already happened. The fix moves this
 * app's shortcut listener to the capture phase, which on the same target
 * (document) always runs before any bubble-phase listener there regardless
 * of which was registered first, and calls stopPropagation() once a
 * shortcut has actually run, so Leaflet's handler never sees the key at
 * all.
 *
 *     node tools/test-arrow-key-frames.mjs
 *
 * Uses the real Leaflet build (unlike test-radar-compass.mjs, which stubs
 * Leaflet out entirely), because the whole point here is measuring whether
 * a real key event actually moves a real map.
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
  ok('the shortcut listener runs in the capture phase',
     /const binds = _kbdLoad\(\);[\s\S]{0,400}\}, true\);/.test(PAGE));
  ok('and stops the key outright once a shortcut actually ran, not just preventDefault',
     /if \(_kbdRun\(action\)\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-arrow-key-frames.mjs'), 'utf8').includes(EM));
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

// A GR2Analyst-style bind, so ArrowRight/ArrowLeft are actually bound to
// something before this runs, matching how a real visitor would have them.
await p.evaluate(() => { kbdApplyPreset('gr2'); });

const arrow = (key) => p.evaluate((key) => {
  const before = { center: map.getCenter(), frame: currentFrame };
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key, code: key, bubbles: true, cancelable: true }));
  const after = { center: map.getCenter(), frame: currentFrame };
  return {
    centerMoved: before.center.lat !== after.center.lat
              || before.center.lng !== after.center.lng,
    frameBefore: before.frame, frameAfter: after.frame,
  };
}, key);

console.log('\n2. ArrowRight steps the frame and leaves the map exactly where it was');
{
  const r = await arrow('ArrowRight');
  ok('the frame actually moved', r.frameAfter !== r.frameBefore, JSON.stringify(r));
  ok('the map center did not move at all', r.centerMoved === false, JSON.stringify(r));
}

console.log('\n3. ArrowLeft does the same, the other direction');
{
  const r = await arrow('ArrowLeft');
  ok('the frame actually moved', r.frameAfter !== r.frameBefore, JSON.stringify(r));
  ok('the map center did not move at all', r.centerMoved === false, JSON.stringify(r));
}

console.log('\n4. Leaflet\'s own keyboard handler is still enabled, just beaten to the key');
{
  const r = await p.evaluate(() => ({ enabled: map.keyboard.enabled() }));
  ok('map.keyboard was never disabled outright, only pre-empted for bound chords',
     r.enabled === true, JSON.stringify(r));
}

console.log('\n5. an unbound key still reaches Leaflet normally');
{
  // PageDown is not bound by the gr2 preset, so this app's listener finds
  // no hit and must not call stopPropagation, leaving Leaflet's own
  // handling of the key (which does nothing with PageDown) untouched.
  const r = await p.evaluate(() => {
    const before = map.getCenter();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'PageDown', code: 'PageDown', bubbles: true, cancelable: true }));
    const after = map.getCenter();
    return { same: before.lat === after.lat && before.lng === after.lng };
  });
  ok('nothing broke dispatching a key this app does not claim', r.same === true);
}

console.log('\n6. typing in a text field is still left alone');
{
  const r = await p.evaluate(() => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const before = currentFrame;
    ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
    const after = currentFrame;
    ta.remove();
    return { moved: before !== after };
  });
  ok('an ArrowRight typed into a text field does not step the radar frame',
     r.moved === false, JSON.stringify(r));
}

ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
