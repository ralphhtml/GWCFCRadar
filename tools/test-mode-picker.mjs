#!/usr/bin/env node
/*
 * Wx-pert and Lite-ning: the first-visit choice, and what each mode is.
 *
 *     node tools/test-mode-picker.mjs
 *
 * The app has two audiences. The person who reads soundings wants all
 * fifty-eight controls; the person who just heard thunder wants the radar,
 * the warnings and their forecast. The first visit now asks which they are,
 * once, and Lite-ning strips the screen down to that answer.
 *
 * What has to stay true, and is held here against the running page:
 *   - a true first visit gets the question BEFORE the tutorial
 *   - Lite-ning trims the bubbles to Radar, hides the tool rails, and
 *     speaks plain words ("Live Radar", never "Level 2")
 *   - the choice is remembered, and switchable from the logo menu
 *   - an EXISTING visitor is never asked; they stay Wx-pert untouched
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

console.log('\n1. the source keeps the shape of the feature');
{
  ok('one body class does the hiding',
     /body\.lite-mode #right-menu/.test(PAGE)
     && /body\.lite-mode #overlay-toggle-btn/.test(PAGE));
  ok('the picker outranks the auto-tutorial on a first visit',
     /_modeChosen\(\)\) \{[\s\S]{0,700}_modeOpenPicker\(\)/.test(PAGE));
  ok('choosing Lite-ning waives the full tutorial, not the greeting line',
     /_modePick[\s\S]{0,900}gwcfc_tutorial_seen', '1'/.test(PAGE)
     && /_liteIntroClose[\s\S]{0,200}_fvSignup\(\)/.test(PAGE));
  ok('the mode is changed in Settings, with no tag or button of its own',
     /id="lqm-set-mode"/.test(PAGE)
     && !/id="profile-mode-tag"/.test(PAGE) && !/id="lqm-mode-btn"/.test(PAGE));
  ok('Lite-ning empties the bubble column in the renderer',
     /renderSubBubbles[\s\S]{0,1200}_isLite\(\)[\s\S]{0,120}bubbles = \[\]/.test(PAGE));
  ok('and turns its two layers on by itself instead',
     /function _liteEnsureBasics/.test(PAGE)
     && /_liteEnsureBasics[\s\S]{0,700}toggleForecastDots/.test(PAGE)
     && /_liteEnsureBasics[\s\S]{0,1400}_loadMrmsComposite/.test(PAGE));
  ok('at boot too, once the map exists',
     /_whenMapReady\(\(\) => \{ try \{ _liteEnsureBasics\(\); \}/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-mode-picker.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });

const errsAll = [];
async function boot(initStorage) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  p.on('pageerror', e => errsAll.push(String(e).slice(0, 180)));
  if (initStorage) {
    await p.addInitScript(seed => {
      for (const [k, v] of Object.entries(seed)) {
        try { localStorage.setItem(k, v); } catch (e) {}
      }
    }, initStorage);
  }
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
  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4200);
  return p;
}

console.log('\n2. a brand-new visitor is asked, and Lite-ning answers for them');
{
  const p = await boot(null);
  const first = await p.evaluate(() => ({
    picker: !!document.querySelector('#mode-modal.open'),
    tutorial: !!document.querySelector('#tutorial-modal-overlay.open'),
  }));
  ok('the question appears before anything else', first.picker,
     JSON.stringify(first));
  ok('and the full tutorial does not', !first.tutorial);

  await p.click('#mode-pick-lite');
  await p.waitForTimeout(400);
  const lite = await p.evaluate(() => ({
    saved: localStorage.getItem('gwcfc_mode'),
    body: document.body.classList.contains('lite-mode'),
    intro: !!document.querySelector('#lite-intro.open'),
    tutSeen: localStorage.getItem('gwcfc_tutorial_seen'),
    bubbles: [...document.querySelectorAll('#sub-bubbles .sb-label')].map(x => x.textContent),
    colGone: getComputedStyle(document.getElementById('sub-bubbles')).display === 'none',
    railGone: getComputedStyle(document.getElementById('right-menu')).display === 'none',
    launcherGone: getComputedStyle(document.getElementById('overlay-toggle-btn')).display === 'none',
    radarOn: activeLayers.nexrad === true,
    product: currentProduct,
    dotsOn: activeLayers.forecasts === true,
  }));
  ok('the choice is saved', lite.saved === 'lite', String(lite.saved));
  ok('the page wears the mode', lite.body === true);
  ok('a four-line intro opens instead of eighteen sections', lite.intro);
  ok('so the full tutorial will not ambush the next visit',
     lite.tutSeen === '1', String(lite.tutSeen));
  ok('the bubble column is gone entirely, Radar button included',
     lite.bubbles.length === 0 && lite.colGone, JSON.stringify(lite.bubbles));
  ok('because the radar turned itself on instead',
     lite.radarOn && lite.product === 'mrms', lite.product);
  ok('with the 1 km composite as the product', lite.product === 'mrms');
  ok('and the forecast dots are on', lite.dotsOn);
  ok('the drawing and measuring rail is gone', lite.railGone);
  ok('so is the overlay launcher', lite.launcherGone);

  // Closing the intro no longer jumps straight to the welcome: the rest of
  // the first-visit greeting line comes first. Sign-up panel (skippable),
  // then the changelog, and only then the welcome flight.
  const radar = await p.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    _liteIntroClose();
    await wait(700);
    const signupOpen =
      !!document.querySelector('#lqm-profile-overlay.lqm-panel-open');
    lqmCloseProfile();
    await wait(700);
    const clOpen = !!document.querySelector('#changelog-modal.open');
    _clClose();
    await wait(900);
    return {
      signupOpen, clOpen,
      clSeen: localStorage.getItem('gwcfc_changelog_seen'),
      newestId: APP_CHANGELOG[0].id,
      welcomeRan: _welcomeRan === true,
    };
  });
  ok('closing the intro opens the sign-up panel', radar.signupOpen);
  ok('closing that opens the changelog', radar.clOpen);
  ok('which starts their history at today',
     radar.clSeen === radar.newestId, `${radar.clSeen} vs ${radar.newestId}`);
  ok('and dismissing the changelog starts the welcome', radar.welcomeRan);

  // And the way back up: one tap in the logo menu restores everything.
  const back = await p.evaluate(() => {
    renderSubBubbles('regular');
    _modeToggle();
    return {
      saved: localStorage.getItem('gwcfc_mode'),
      bubbles: document.querySelectorAll('#sub-bubbles .sub-bubble-main').length,
      railBack: getComputedStyle(document.getElementById('right-menu')).display !== 'none',
      tagGone: !document.getElementById('profile-mode-tag'),
    };
  });
  ok('the switch flips back to Wx-pert', back.saved === 'expert', back.saved);
  ok('all eight bubbles return', back.bubbles === 8, String(back.bubbles));
  ok('and so do the tools', back.railBack);
  // The pill tag is retired everywhere (it was already hidden on phones):
  // the mode lives in Settings under Display and in the account panel.
  ok('the mode tag is gone from the account pill', back.tagGone);

  // The account panel carries the switch itself: two buttons under the
  // menu strip, the current mode lit, and tapping the other one flips the
  // whole app plus the Settings dropdown it must agree with.
  const sw = await p.evaluate(() => {
    const btns = [...document.querySelectorAll('.lqm-pm-mode-btn')];
    const btn = m => btns.find(b => b.dataset.mode === m);
    const out = { count: btns.length,
                  expertLit: btn('expert').classList.contains('on')
                          && !btn('lite').classList.contains('on') };
    btn('lite').click();
    out.liteBody = document.body.classList.contains('lite-mode');
    out.liteLit = btn('lite').classList.contains('on')
               && !btn('expert').classList.contains('on');
    out.dropdown = document.getElementById('lqm-set-mode').value;
    btn('expert').click();
    out.backBody = !document.body.classList.contains('lite-mode');
    return out;
  });
  ok('the panel offers both modes', sw.count === 2, String(sw.count));
  ok('with the current one lit', sw.expertLit);
  ok('tapping LITE-NING switches the app on the spot',
     sw.liteBody && sw.liteLit);
  ok('and the Settings dropdown agrees', sw.dropdown === 'lite', sw.dropdown);
  ok('tapping WX-PERT switches straight back', sw.backBody);

  // Saved layers belong to Wx-pert. A preset that arrives while Lite-ning
  // is on is held back, not applied; switching to Wx-pert applies it; and
  // switching INTO Lite-ning sweeps the extra layers off the map.
  const preset = await p.evaluate(async () => {
    const out = {};
    _viewStateApplied = false;
    _setMode('lite', { quiet: true });
    _applyViewState({ savedLayers: { lightning: true } });
    out.stashed = !!_pendingViewState;
    out.liteStaysClean = activeLayers.lightning !== true;
    _setMode('expert', { quiet: true });
    out.expertGetsPreset = activeLayers.lightning === true;
    out.pendingSpent = _pendingViewState == null && _viewStateApplied === true;
    _setMode('lite', { quiet: true });
    out.liteSweepsItOff = activeLayers.lightning !== true;
    out.dotsSurvive = activeLayers.forecasts === true;
    _setMode('expert', { quiet: true });
    return out;
  });
  ok('a preset arriving in Lite-ning is held back, not applied',
     preset.stashed && preset.liteStaysClean, JSON.stringify(preset));
  ok('switching to Wx-pert applies the held preset',
     preset.expertGetsPreset && preset.pendingSpent);
  ok('switching into Lite-ning sweeps extra layers off',
     preset.liteSweepsItOff);
  ok('but never the forecast dots', preset.dotsSurvive);

  // The app menu's seat inside the account panel follows the sign-in
  // state: below the avatar and name for an account, above the sign-in
  // invitation for a guest. One element, moved, never duplicated.
  const seat = await p.evaluate(() => {
    const menu = document.getElementById('lqm-panel-menu');
    _lqmPlacePanelMenu(true);
    const signedIn = menu.previousElementSibling
      && menu.previousElementSibling.id === 'lqm-profile-sub-txt';
    _lqmPlacePanelMenu(false);
    const guest = menu.nextElementSibling
      && menu.nextElementSibling.id === 'lqm-profile-guest';
    return { signedIn, guest, copies: document.querySelectorAll('#lqm-panel-menu').length };
  });
  ok('signed in, the menu sits below the avatar and name', seat.signedIn);
  ok('signed out, it returns above the sign-in invitation', seat.guest);
  ok('and there is exactly one of it', seat.copies === 1, String(seat.copies));
  await p.close();
}

console.log("\n4. on a phone: the row is retired, the menu lives in the account panel");
{
  // The quick-menu row's whole history of phone breakage ends here: the row
  // is retired outright, and its five buttons live at the top of the
  // account panel, which cannot overflow a screen edge.
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  p.on('pageerror', e => errsAll.push(String(e).slice(0, 180)));
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
  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4600);
  const m = await p.evaluate(() => {
    const qm = document.getElementById('logo-quick-menu');
    const r = qm.getBoundingClientRect();
    const bubbles = document.getElementById('sub-bubbles');
    const br = bubbles ? bubbles.getBoundingClientRect() : null;
    // The search bar's phone collapse used to lose to the desktop width by
    // source order, leaving a mostly-empty 150px pill drifting over the
    // quick menu. Collapsed it must size to its two buttons and hug the
    // corner; expanded it must open wide enough to read what you type.
    const sb = document.getElementById('top-search-bar');
    const sc = sb.getBoundingClientRect();
    const searchCollapsed = { w: Math.round(sc.width),
                              right: Math.round(innerWidth - sc.right) };
    sb.classList.add('expanded');
    const se = sb.getBoundingClientRect();
    sb.classList.remove('expanded');
    const searchExpanded = Math.round(se.width);
    // The row under the logo is retired: the five app buttons live at the
    // top of the account panel now, there whether or not anyone is signed
    // in. On a phone the mode tag also stays off the pill, because the
    // corner is already crowded.
    const panel = document.getElementById('lqm-profile-overlay');
    panel.classList.add('lqm-panel-open');
    const pm = document.getElementById('lqm-panel-menu');
    const menuShown = pm && pm.getBoundingClientRect().width > 0;
    const menuLabels = pm
      ? [...pm.querySelectorAll('.lqm-pm-btn span')].map(s => s.textContent) : [];
    panel.classList.remove('lqm-panel-open');
    return {
      searchCollapsed, searchExpanded,
      tagGone: !document.getElementById('profile-mode-tag'),
      rowGone: getComputedStyle(qm).display === 'none',
      menuShown, menuLabels,
      bubblesTop: br ? Math.round(br.top) : null,
    };
  });
  await p.close();
  ok('the row under the logo is gone', m.rowGone);
  ok('its buttons live in the account panel instead, Updates and Messages included',
     m.menuShown && JSON.stringify(m.menuLabels)
       === JSON.stringify(['Settings', 'Navigation', 'Tutorial', 'Credits',
                           'Feedback', 'Updates', 'Messages']),
     JSON.stringify(m.menuLabels));
  ok('the collapsed search bar is just its two buttons, hugging the corner',
     m.searchCollapsed.w <= 120 && m.searchCollapsed.right <= 12,
     JSON.stringify(m.searchCollapsed));
  ok('and expanding it opens a field wide enough to read',
     m.searchExpanded >= 250, String(m.searchExpanded));
  ok('the mode tag is gone here too', m.tagGone);
}

console.log('\n3. the choice is remembered, and old friends are never quizzed');
{
  // A returning Lite-ning visitor: no question, straight to their trimmed app.
  const p1 = await boot({ gwcfc_mode: 'lite', gwcfc_tutorial_seen: '1' });
  const r1 = await p1.evaluate(() => ({
    picker: !!document.querySelector('#mode-modal.open'),
    body: document.body.classList.contains('lite-mode'),
    bubbles: [...document.querySelectorAll('#sub-bubbles .sb-label')].map(x => x.textContent),
    radarOn: activeLayers.nexrad === true && currentProduct === 'mrms',
    dotsOn: activeLayers.forecasts === true,
  }));
  ok('a returning Lite-ning visitor is not asked again', !r1.picker);
  ok('and lands in their own mode, no bubbles', r1.body === true
     && r1.bubbles.length === 0, JSON.stringify(r1.bubbles));
  ok('with the radar and forecast dots already on',
     r1.radarOn && r1.dotsOn, JSON.stringify(r1));
  await p1.close();

  // An existing user from before modes existed: tutorial seen, mode unset.
  const p2 = await boot({ gwcfc_tutorial_seen: '1' });
  const r2 = await p2.evaluate(() => ({
    picker: !!document.querySelector('#mode-modal.open'),
    body: document.body.classList.contains('lite-mode'),
    bubbles: document.querySelectorAll('#sub-bubbles .sub-bubble-main').length,
  }));
  ok('an existing visitor is never interrupted with the question', !r2.picker);
  ok('and keeps the full app exactly as it was',
     !r2.body && r2.bubbles === 8, String(r2.bubbles));
  await p2.close();
}

await browser.close();
ok('and nothing threw on any page', errsAll.length === 0,
   errsAll.slice(0, 3).join(' | '));

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
