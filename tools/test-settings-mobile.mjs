#!/usr/bin/env node
/*
 * Settings on a phone, a search across every setting, and a keyboard
 * shortcut for anything in the app.
 *
 *     node tools/test-settings-mobile.mjs
 *
 * On a phone the panel was a floating box with a strip of unlabelled icons
 * twice the width of the screen. It is now the whole screen: a list of named
 * categories first, one category after a tap, a back button, and a search.
 * The keyboard page can now bind a key to anything: any entry the search bar
 * knows, or any button picked on screen.
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
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
async function open(viewport, mobile) {
  const ctx = await b.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  return { p, errs, ctx };
}

console.log('\n1. Settings on a phone');
{
  const { p, errs, ctx } = await open({ width: 390, height: 844 }, true);
  const r = await p.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const ov = document.getElementById('lqm-settings-overlay');
    // As if the desktop panel had once been dragged somewhere.
    ov.style.setProperty('top', '300px', 'important');
    lqmOpenSettings();
    await wait(400);
    const out = {};
    const box = ov.getBoundingClientRect();
    out.full = box.left === 0 && box.top === 0 && Math.round(box.width) === innerWidth && Math.round(box.height) === innerHeight;
    out.home = ov.classList.contains('lqm-set-home');
    const tabs = Array.from(document.querySelectorAll('#lqm-set-rail .lqm-set-tab'));
    out.tabs = tabs.length;
    out.named = tabs.every(t => { const s = t.querySelector('span'); return s && getComputedStyle(s).display !== 'none' && s.textContent.trim(); });
    const cw = document.getElementById('lqm-set-shell').getBoundingClientRect().width;
    out.fullWidthRows = tabs.every(t => t.getBoundingClientRect().width >= cw - 2);
    out.allOnScreen = tabs.every(t => { const q = t.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth; });
    out.noSideScroll = document.documentElement.scrollWidth <= innerWidth && ov.scrollWidth <= ov.clientWidth + 1;
    out.contentHiddenOnHome = getComputedStyle(document.getElementById('lqm-set-content')).display === 'none';
    out.backHiddenOnHome = getComputedStyle(document.getElementById('lqm-set-back')).display === 'none';
    // Into a category.
    const radar = tabs.find(t => /radar/i.test(t.textContent));
    radar.click();
    await wait(200);
    out.inCat = !ov.classList.contains('lqm-set-home')
      && getComputedStyle(document.getElementById('lqm-set-rail')).display === 'none'
      && Array.from(document.querySelectorAll('#lqm-set-content .lqm-settings-group')).some(g => !g.hidden && g.getBoundingClientRect().height > 0);
    out.title = document.getElementById('lqm-set-title-text').textContent;
    const back = document.getElementById('lqm-set-back');
    out.backShown = getComputedStyle(back).display !== 'none' && back.getBoundingClientRect().height >= 32;
    const close = document.getElementById('lqm-settings-close').getBoundingClientRect();
    out.closeBig = close.width >= 40 && close.height >= 40;
    // The header stays at the top while the card scrolls.
    ov.scrollTop = 600; await wait(50);
    out.headSticks = Math.abs(document.getElementById('lqm-set-head').getBoundingClientRect().top) < 2;
    back.click();
    await wait(100);
    out.backHome = ov.classList.contains('lqm-set-home') && document.getElementById('lqm-set-title-text').textContent === 'Settings';
    // Search reaches into every category.
    const f = document.getElementById('lqm-set-find');
    f.value = 'smoothing'; f.dispatchEvent(new Event('input'));
    await wait(50);
    const shown = Array.from(document.querySelectorAll('#lqm-set-content .lqm-settings-row'))
      .filter(r => r.getBoundingClientRect().height > 0);
    out.found = shown.length;
    out.foundRight = shown.length > 0 && shown.every(r => /smooth/i.test(r.textContent)
      || /smooth/i.test(r.closest('.lqm-settings-group').querySelector('.lqm-settings-category').textContent));
    f.value = ''; f.dispatchEvent(new Event('input'));
    await wait(50);
    out.clearedHome = ov.classList.contains('lqm-set-home');
    lqmCloseSettings();
    return out;
  });
  ok('opens as the whole screen, even after the desktop panel was moved', r.full, JSON.stringify(r));
  ok('opens on the list of categories', r.home && r.contentHiddenOnHome && r.backHiddenOnHome, JSON.stringify(r));
  ok(`every category is a full width row with its name (${r.tabs})`, r.tabs >= 8 && r.named && r.fullWidthRows && r.allOnScreen, JSON.stringify(r));
  ok('nothing scrolls sideways', r.noSideScroll, JSON.stringify(r));
  ok('a tap opens that one category, named in the header', r.inCat && /radar/i.test(r.title), JSON.stringify(r));
  ok('a back button and a thumb-sized close button', r.backShown && r.closeBig, JSON.stringify(r));
  ok('the header stays put while the settings scroll', r.headSticks, JSON.stringify(r));
  ok('back returns to the list', r.backHome, JSON.stringify(r));
  ok(`search finds settings in any category (${r.found} rows for "smoothing")`, r.found >= 2 && r.foundRight, JSON.stringify(r));
  ok('clearing the search goes back to the list', r.clearedHome, JSON.stringify(r));
  ok('no page errors on the phone', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n2. The desktop panel is unchanged, plus search');
{
  const { p, errs, ctx } = await open({ width: 1300, height: 850 });
  const r = await p.evaluate(async () => {
    const ov = document.getElementById('lqm-settings-overlay');
    lqmOpenSettings();
    await new Promise(res => setTimeout(res, 300));
    const out = {};
    out.notHome = !ov.classList.contains('lqm-set-home');
    out.railBeside = getComputedStyle(document.getElementById('lqm-set-rail')).display !== 'none'
      && getComputedStyle(document.getElementById('lqm-set-content')).display !== 'none';
    out.floating = ov.getBoundingClientRect().width < innerWidth - 100;
    out.backHidden = getComputedStyle(document.getElementById('lqm-set-back')).display === 'none';
    out.hits = lqmSettingsFind('radar');
    out.clear = lqmSettingsFind('') === 0 && !ov.classList.contains('lqm-set-finding');
    lqmCloseSettings();
    return out;
  });
  ok('rail beside the card, no phone back button, still a floating panel', r.notHome && r.railBeside && r.floating && r.backHidden, JSON.stringify(r));
  ok('search works on the desktop too', r.hits > 0 && r.clear, JSON.stringify(r));

  console.log('\n3. A keyboard shortcut for anything');
  const k = await p.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const key = (k, extra) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));
    const out = {};
    lqmOpenSettings(); lqmSettingsCat('keyboard');
    // By name: anything the search bar knows.
    const cat = _srchCatalog();
    out.catalog = cat.length;
    const target = cat.find(c => c.type === 'TOOL') || cat[0];
    let ran = 0;
    const real = target.action; target.action = () => { ran++; };
    kbdFind(target.label);
    await wait(30);
    out.results = document.querySelectorAll('#lqm-kbd-results .kbd-result').length;
    const i = _kbdFindMatches().findIndex(c => c.label === target.label);
    _kbdAddFound(i);
    out.capturing = !!_kbdCapturing;
    key('R');
    out.bound = _kbdExtraLoad().some(x => x.label === target.label && x.chord === 'R');
    out.listed = /Your own shortcuts/.test(document.getElementById('lqm-settings-overlay').textContent)
      && document.querySelectorAll('.kbd-extra-row').length === 1;
    lqmCloseSettings();
    key('R');
    out.ran = ran === 1;
    target.action = real;
    // By pointing at a button on screen.
    const btn = document.createElement('button');
    btn.id = 'kbd-test-btn'; btn.textContent = 'Test button';
    btn.style.cssText = 'position:fixed;left:400px;top:400px;z-index:99999';
    let clicks = 0; btn.onclick = () => { clicks++; };
    document.body.appendChild(btn);
    kbdPickStart();
    out.settingsAway = !document.getElementById('lqm-settings-overlay').classList.contains('lqm-panel-open');
    btn.click();                       // the pick: it must not also press it
    out.pickDidNotPress = clicks === 0;
    out.backInKeyboard = document.getElementById('lqm-settings-overlay').classList.contains('lqm-panel-open') && _lqmSetCat === 'keyboard';
    key('K', { shiftKey: true });
    const picked = _kbdExtraLoad().find(x => x.kind === 'el');
    out.picked = picked && picked.sel === '#kbd-test-btn' && picked.chord === 'Shift+K' && picked.label === 'Test button';
    lqmCloseSettings();
    key('K', { shiftKey: true });
    out.pressed = clicks === 1;
    // A preset never throws them away; a key it needs is simply given up.
    kbdApplyPreset('simple');
    const xs = _kbdExtraLoad();
    out.kept = xs.length === 2 && xs.find(x => x.kind === 'el').chord === 'Shift+K' && xs.find(x => x.kind === 'cat').chord === '';
    // Its button gone: a note, no error.
    btn.remove();
    let said = ''; const st = window.showToast; window.showToast = (m) => { said = m; };
    key('K', { shiftKey: true });
    window.showToast = st;
    out.goneSaid = /not on screen/.test(said);
    // Reloaded from storage.
    _kbdExtra = null;
    out.persisted = _kbdExtraLoad().length === 2;
    kbdRemoveExtra(xs[0].id);
    out.removed = _kbdExtraLoad().length === 1;
    return out;
  });
  ok(`every catalogue entry can be found by name (${k.catalog} entries)`, k.catalog > 30 && k.results >= 1, JSON.stringify(k));
  ok('choosing one asks for its key and binds it', k.capturing && k.bound && k.listed, JSON.stringify(k));
  ok('the key runs that action', k.ran, JSON.stringify(k));
  ok('"Pick a button" puts Settings away, and the pick does not press the button', k.settingsAway && k.pickDidNotPress, JSON.stringify(k));
  ok('the picked button gets its own key, then Settings comes back on Keyboard', k.picked && k.backInKeyboard, JSON.stringify(k));
  ok('the key presses the picked button', k.pressed, JSON.stringify(k));
  ok('choosing a preset keeps your own shortcuts, giving up only a clashing key', k.kept, JSON.stringify(k));
  ok('a button that is not on screen gets a note, not an error', k.goneSaid, JSON.stringify(k));
  ok('your shortcuts are saved, and can be removed', k.persisted && k.removed, JSON.stringify(k));
  ok('no page errors on the desktop', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
