#!/usr/bin/env node
/*
 * Keyboard shortcuts, pressed for real: every edge a keyboard has.
 *
 *     node tools/test-keybind-robust.mjs
 *
 * Found by pressing keys rather than reading code:
 *   - GR2Analyst's Shift+, never fired: with Shift held the browser reports
 *     "<", not ",". Chords are now read by the physical key.
 *   - On a Mac, Option+R types "®", so an Option shortcut was saved as a symbol.
 *   - A held key auto-repeats, so an overlay's key toggled it on and off.
 *   - Leaving Settings while a key waited to be rebound left it waiting, and
 *     the next keypress anywhere quietly became that shortcut.
 *   - Ctrl and Command combinations could be saved but never fire.
 *   - Keys pressed while composing text (Chinese, Japanese, accents) fired.
 * And how long a press takes, for the built-in keys and your own.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => {
  localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id);
  // A custom chord saved the old way, as the shifted character.
  localStorage.setItem('gwcfc_keys', JSON.stringify({ preset: 'custom', binds: { alerts: 'Shift+?' } }));
}, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
const ev = (fn, arg) => p.evaluate(fn, arg);

console.log('\n1. Reading the key that was pressed');
const mig = await ev(() => _kbdLoad().alerts);
ok('a chord saved as the shifted character is rewritten to the key (Shift+? to Shift+/)', mig === 'Shift+/', mig);
await ev(() => { kbdApplyPreset('gr2'); window.__set = 0; const o = window.lqmOpenSettings; window.lqmOpenSettings = function () { window.__set++; return o.apply(this, arguments); }; });
await p.mouse.click(650, 600);
await p.keyboard.press('Shift+Comma');
ok('GR2Analyst Shift+, opens Settings from a real keyboard', await ev(() => window.__set) === 1);
await ev(() => lqmCloseSettings());
const chords = await ev(() => [
  _kbdChord(new KeyboardEvent('keydown', { key: '®', code: 'KeyR', altKey: true })),
  _kbdChord(new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true })),
  _kbdChord(new KeyboardEvent('keydown', { key: 'Q', code: 'KeyA', shiftKey: true })),   // AZERTY: the A key types Q
  _kbdChord(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true })),
  _kbdChord(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', isComposing: true })),
  _kbdChord(new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote' })),
]);
ok('Mac Option+R is Alt+R, not a symbol', chords[0] === 'Alt+R', JSON.stringify(chords));
ok('Shift+1 is Shift+1, not Shift+!', chords[1] === 'Shift+1', JSON.stringify(chords));
ok('a French keyboard\'s letters keep their own names', chords[2] === 'Shift+Q', JSON.stringify(chords));
ok('named keys are untouched', chords[3] === 'Shift+ArrowRight', JSON.stringify(chords));
ok('keys while composing text, and dead keys, are not shortcuts', chords[4] === '' && chords[5] === '', JSON.stringify(chords));

console.log('\n2. Held keys, focused buttons, typing');
const held = await ev(() => {
  let n = 0; const t = window.toggleAlertsPanel; window.toggleAlertsPanel = () => { n++; };
  const k = (rep) => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', code: 'KeyA', shiftKey: true, repeat: rep, bubbles: true, cancelable: true }));
  k(false); for (let i = 0; i < 10; i++) k(true);
  window.toggleAlertsPanel = t;
  let s = 0; const sf = window.stepFrame; window.stepFrame = () => { s++; };
  const r = (rep) => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', repeat: rep, bubbles: true, cancelable: true }));
  r(false); for (let i = 0; i < 5; i++) r(true);
  window.stepFrame = sf;
  return { toggles: n, steps: s };
});
ok('holding an overlay\'s key toggles it once, not on and off', held.toggles === 1, JSON.stringify(held));
ok('holding Right still scrubs frame by frame', held.steps === 6, JSON.stringify(held));
const focus = await ev(async () => {
  let clicks = 0, plays = 0;
  const btn = document.createElement('button'); btn.id = 'kbd-focus-test'; btn.textContent = 'x';
  btn.style.cssText = 'position:fixed;left:10px;top:500px;z-index:99999'; btn.onclick = () => { clicks++; };
  document.body.appendChild(btn); btn.focus();
  const tp = window.togglePlay; window.togglePlay = () => { plays++; };
  window.__focusOut = () => { window.togglePlay = tp; btn.remove(); return { clicks, plays }; };
  return true;
});
await p.keyboard.press(' ');
const fr = await ev(() => window.__focusOut());
ok('Space for Play works with a button focused, and does not also press that button', fr.plays === 1 && fr.clicks === 0, JSON.stringify(fr));
await ev(() => { lqmOpenSettings(); document.getElementById('lqm-set-find').focus(); window.__al = 0; const t = window.toggleAlertsPanel; window.toggleAlertsPanel = () => { window.__al++; }; window.__alOut = () => { window.toggleAlertsPanel = t; }; });
await p.keyboard.type('A shortcut');
await p.keyboard.press('Shift+A');
ok('typing in a box never fires a shortcut', await ev(() => { const n = window.__al; window.__alOut(); return n; }) === 0);
await ev(() => { document.getElementById('lqm-set-find').value = ''; lqmSettingsFind(''); lqmCloseSettings(); });

console.log('\n3. Rebinding');
const cap = await ev(() => {
  const k = (o) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, o)));
  const out = {};
  lqmOpenSettings(); lqmSettingsCat('keyboard');
  _kbdCapture('vel');
  lqmCloseSettings();
  out.disarmed = !_kbdCapturing;
  k({ key: 'N', code: 'KeyN', shiftKey: true });
  out.velSame = _kbdLoad().vel === 'Shift+V';
  lqmOpenSettings(); lqmSettingsCat('keyboard');
  const st = window.showToast; let said = []; window.showToast = (m) => said.push(m);
  _kbdCapture('vel');
  k({ key: 's', code: 'KeyS', ctrlKey: true });
  k({ key: 'Tab', code: 'Tab' });
  out.stillWaiting = _kbdCapturing === 'vel' && _kbdLoad().vel === 'Shift+V' && said.length === 2;
  k({ key: '®', code: 'KeyR', altKey: true });
  out.altBound = _kbdLoad().vel === 'Alt+R';
  window.showToast = st;
  kbdApplyPreset('gr2');
  lqmCloseSettings();
  return out;
});
ok('leaving Settings while a key waits to be rebound cancels it', cap.disarmed && cap.velSame, JSON.stringify(cap));
ok('Ctrl, Command and Tab are refused with a note, and it keeps waiting', cap.stillWaiting, JSON.stringify(cap));
ok('an Option shortcut is saved as Alt+R', cap.altBound, JSON.stringify(cap));
const sync = await ev(() => {
  localStorage.setItem('gwcfc_keys', JSON.stringify({ preset: 'custom', binds: { vel: 'Shift+X' } }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'gwcfc_keys' }));
  const v = _kbdLoad().vel;
  kbdApplyPreset('gr2');
  return v;
});
ok('keys changed in another tab are picked up here', sync === 'Shift+X', sync);

console.log('\n4. Your own shortcuts, and how long a press takes');
const lat = await ev(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const k = (o) => { const e = new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, o)); document.dispatchEvent(e); return e; };
  const med = (fn) => { const ts = []; for (let i = 0; i < 40; i++) { const a = performance.now(); fn(); ts.push(performance.now() - a); } ts.sort((x, y) => x - y); return ts[20]; };
  const out = {};
  const t = window.toggleAlertsPanel; window.toggleAlertsPanel = () => {};
  out.builtin = med(() => k({ key: 'A', code: 'KeyA', shiftKey: true }));
  window.toggleAlertsPanel = t;
  // A catalogue shortcut
  const entry = _srchCatalog().find(c => c.type === 'OVERLAY');
  let ran = 0; const real = entry.action; entry.action = () => { ran++; };
  _kbdExtra = [{ id: 'x1', kind: 'cat', label: entry.label, type: 'OVERLAY', chord: 'J' }];
  out.cat = med(() => k({ key: 'j', code: 'KeyJ' }));
  out.catRan = ran;
  entry.action = real;
  // A picked button, in a list that gets rebuilt in a new order
  const list = document.createElement('div'); list.id = 'kbd-list-test';
  list.style.cssText = 'position:fixed;left:10px;top:520px;z-index:99999';
  let hits = 0;
  const build = (names) => { list.innerHTML = ''; names.forEach(n => { const b = document.createElement('button'); b.textContent = n; b.onclick = () => { if (n === 'Target') hits++; }; list.appendChild(b); }); };
  build(['One', 'Target', 'Three']);
  document.body.appendChild(list);
  const target = list.children[1];
  _kbdExtra.push({ id: 'x2', kind: 'el', sel: _kbdSelectorFor(target), text: 'Target', label: 'Target', chord: 'Shift+J' });
  out.el = med(() => k({ key: 'J', code: 'KeyJ', shiftKey: true }));
  const before = hits;
  build(['Target', 'One', 'Three']);      // rebuilt: the old path now names "One"
  k({ key: 'J', code: 'KeyJ', shiftKey: true });
  out.followedText = hits === before + 1;
  // Gone entirely: whatever now sits at its old place is left alone.
  let others = 0;
  list.innerHTML = '';
  ['One', 'Two', 'Three'].forEach(n => { const b = document.createElement('button'); b.textContent = n; b.onclick = () => { others++; }; list.appendChild(b); });
  const st = window.showToast; let said = ''; window.showToast = (m) => { said = m; };
  k({ key: 'J', code: 'KeyJ', shiftKey: true });
  window.showToast = st;
  out.goneLeftAlone = others === 0 && /not on screen/.test(said);
  // A button with its own id whose label changes (Play becomes Pause).
  const pb = document.createElement('button'); pb.id = 'kbd-play-like'; pb.textContent = 'Play';
  let pp = 0; pb.onclick = () => { pp++; pb.textContent = pb.textContent === 'Play' ? 'Pause' : 'Play'; };
  list.appendChild(pb);
  _kbdExtra.push({ id: 'x3', kind: 'el', sel: '#kbd-play-like', text: 'Play', label: 'Play', chord: 'Shift+P' });
  k({ key: 'P', code: 'KeyP', shiftKey: true }); k({ key: 'P', code: 'KeyP', shiftKey: true });
  out.idLabelChange = pp === 2;
  list.remove();
  out.hits = hits;
  _kbdExtra = []; _kbdExtraSave();
  return out;
});
ok(`a built-in key takes under a millisecond (median ${lat.builtin.toFixed(3)} ms)`, lat.builtin < 1, JSON.stringify(lat));
ok(`a catalogue shortcut takes under a millisecond and runs every time (median ${lat.cat.toFixed(3)} ms)`, lat.cat < 1 && lat.catRan === 40, JSON.stringify(lat));
ok(`a picked button takes under a millisecond (median ${lat.el.toFixed(3)} ms)`, lat.el < 1 && lat.hits >= 40, JSON.stringify(lat));
ok('a picked button is still found after its list is rebuilt in another order', lat.followedText, JSON.stringify(lat));
ok('a picked button that is gone presses nothing in its old place, with a note', lat.goneLeftAlone, JSON.stringify(lat));
ok('a button with its own id still works after its label changes (Play, Pause)', lat.idLabelChange, JSON.stringify(lat));

console.log('\n5. Arrow keys on the map, pressed for real');
const c0 = await ev(() => { const c = map.getCenter(); return [c.lat, c.lng]; });
await ev(() => { window.__st = 0; const s = window.stepFrame; window.stepFrame = function () { window.__st++; }; window.__stOut = () => { window.stepFrame = s; }; });
await p.mouse.click(650, 500);
await p.keyboard.press('ArrowRight');
await p.waitForTimeout(300);
const c1 = await ev(() => { const c = map.getCenter(); window.__stOut(); return [c.lat, c.lng, window.__st]; });
ok('Right steps a frame and the map does not pan', c1[2] === 1 && Math.abs(c1[0] - c0[0]) < 1e-9 && Math.abs(c1[1] - c0[1]) < 1e-9, JSON.stringify([c0, c1]));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
