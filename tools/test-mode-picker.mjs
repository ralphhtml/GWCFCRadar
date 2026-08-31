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
  ok('choosing Lite-ning waives the full tutorial, not the welcome',
     /_modePick[\s\S]{0,900}gwcfc_tutorial_seen', '1'/.test(PAGE)
     && /_liteIntroClose[\s\S]{0,200}_runWelcome\(\)/.test(PAGE));
  ok('the mode is worn on the account pill and changed in Settings',
     /id="profile-mode-tag"/.test(PAGE) && /id="lqm-set-mode"/.test(PAGE)
     && !/id="lqm-mode-btn"/.test(PAGE));
  ok('Lite-ning trims the bubble column in the renderer',
     /renderSubBubbles[\s\S]{0,900}_isLite\(\)[\s\S]{0,200}b\.id === 'radar'/.test(PAGE));
  ok('and gives radar a plain-words menu',
     /function _liteRadarSub/.test(PAGE) && /Live Radar/.test(PAGE));
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
    railGone: getComputedStyle(document.getElementById('right-menu')).display === 'none',
    launcherGone: getComputedStyle(document.getElementById('overlay-toggle-btn')).display === 'none',
    modeLabel: document.getElementById('profile-mode-tag').textContent,
  }));
  ok('the choice is saved', lite.saved === 'lite', String(lite.saved));
  ok('the page wears the mode', lite.body === true);
  ok('a four-line intro opens instead of eighteen sections', lite.intro);
  ok('so the full tutorial will not ambush the next visit',
     lite.tutSeen === '1', String(lite.tutSeen));
  ok('the bubble column is just Radar',
     JSON.stringify(lite.bubbles) === JSON.stringify(['Radar']),
     JSON.stringify(lite.bubbles));
  ok('the drawing and measuring rail is gone', lite.railGone);
  ok('so is the overlay launcher', lite.launcherGone);
  // The account-pill tag states the current mode in both its names, the
  // themed one and the plain one, so each teaches the other.
  ok('the account pill wears the mode, both names',
     /LITE-NING/.test(lite.modeLabel) && /BEGINNER/.test(lite.modeLabel),
     lite.modeLabel);

  // Its radar menu speaks plain words.
  const radar = await p.evaluate(() => {
    _liteIntroClose();
    toggleRadarSub();
    return {
      welcomeRan: _welcomeRan === true,
      labels: [...document.querySelectorAll('#sub-bubbles .sb-label')].map(x => x.textContent),
    };
  });
  ok('closing the intro starts the welcome', radar.welcomeRan);
  ok('the radar menu says Live Radar and Time Machine, nothing cryptic',
     radar.labels.includes('Live Radar') && radar.labels.includes('Time Machine')
     && !radar.labels.includes('Level 2') && !radar.labels.includes('Level 3'),
     JSON.stringify(radar.labels));

  // And the way back up: one tap in the logo menu restores everything.
  const back = await p.evaluate(() => {
    renderSubBubbles('regular');
    _modeToggle();
    return {
      saved: localStorage.getItem('gwcfc_mode'),
      bubbles: document.querySelectorAll('#sub-bubbles .sub-bubble-main').length,
      railBack: getComputedStyle(document.getElementById('right-menu')).display !== 'none',
      modeLabel: document.getElementById('profile-mode-tag').textContent,
    };
  });
  ok('the switch flips back to Wx-pert', back.saved === 'expert', back.saved);
  ok('all eight bubbles return', back.bubbles === 8, String(back.bubbles));
  ok('and so do the tools', back.railBack);
  ok('with the tag following', /WX-PERT/.test(back.modeLabel)
     && /EXPERT/.test(back.modeLabel), back.modeLabel);
  await p.close();
}

console.log('\n4. on a phone: one straight row, the mode tag, and nothing hidden');
{
  // The regressions this pins: a sixth button once pushed the always-shown
  // quick menu past both screen edges and then wrapped alone onto a second
  // line; the mode lives on the account pill as a tag now, so the row is
  // five buttons, straight, and centered under the logo.
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
    // One straight row, centered under the logo: the sixth button used to
    // wrap alone onto a second line, which read as broken.
    const btns = [...qm.querySelectorAll('.lqm-btn')]
      .map(x => x.getBoundingClientRect());
    const logo = document.getElementById('topbar-logo-img').getBoundingClientRect();
    // The tag on the account pill, and what tapping it opens.
    const tagEl = document.getElementById('profile-mode-tag');
    const tagRect = tagEl.getBoundingClientRect();
    tagEl.click();
    const settingsOpened = !!document.querySelector('#lqm-settings-overlay.lqm-panel-open');
    if (typeof lqmToggleSettingsPanel === 'function' && settingsOpened) lqmToggleSettingsPanel();
    return {
      searchCollapsed, searchExpanded,
      oneRow: btns.every(x => Math.round(x.top) === Math.round(btns[0].top)),
      centerOff: Math.round(Math.abs(
        (r.left + r.right) / 2 - (logo.left + logo.right) / 2)),
      tag: { shown: tagRect.width > 0, text: tagEl.textContent },
      settingsOpened,
      open: qm.classList.contains('lqm-open'),
      left: Math.round(r.left), right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      vw: innerWidth,
      buttons: qm.querySelectorAll('.lqm-btn').length,
      bubblesTop: br ? Math.round(br.top) : null,
      clearVar: getComputedStyle(document.documentElement)
        .getPropertyValue('--lqm-clear').trim(),
    };
  });
  await p.close();
  ok('the menu is open with its five buttons, one straight row',
     m.open && m.buttons === 5, JSON.stringify(m));
  ok('and fits inside the screen, both edges',
     m.left >= 0 && m.right <= m.vw, `${m.left}..${m.right} of ${m.vw}`);
  ok('the clearance was measured off its real bottom edge',
     parseInt(m.clearVar) >= m.bottom, `${m.clearVar} vs bottom ${m.bottom}`);
  ok('so the layer bubbles start below it, not underneath it',
     m.bubblesTop === null || m.bubblesTop >= m.bottom,
     `bubbles ${m.bubblesTop} vs menu bottom ${m.bottom}`);
  ok('the collapsed search bar is just its two buttons, hugging the corner',
     m.searchCollapsed.w <= 120 && m.searchCollapsed.right <= 12,
     JSON.stringify(m.searchCollapsed));
  ok('and expanding it opens a field wide enough to read',
     m.searchExpanded >= 250, String(m.searchExpanded));
  ok('the five buttons sit in one straight row', m.oneRow);
  ok('centered under the logo', m.centerOff <= 30, m.centerOff + 'px off');
  ok('the account pill wears the mode tag',
     m.tag.shown && /WX-PERT/.test(m.tag.text) && /EXPERT/.test(m.tag.text),
     JSON.stringify(m.tag));
  ok('and tapping the tag opens Settings', m.settingsOpened);
}

console.log('\n3. the choice is remembered, and old friends are never quizzed');
{
  // A returning Lite-ning visitor: no question, straight to their trimmed app.
  const p1 = await boot({ gwcfc_mode: 'lite', gwcfc_tutorial_seen: '1' });
  const r1 = await p1.evaluate(() => ({
    picker: !!document.querySelector('#mode-modal.open'),
    body: document.body.classList.contains('lite-mode'),
    bubbles: [...document.querySelectorAll('#sub-bubbles .sb-label')].map(x => x.textContent),
  }));
  ok('a returning Lite-ning visitor is not asked again', !r1.picker);
  ok('and lands in their own mode', r1.body === true
     && JSON.stringify(r1.bubbles) === JSON.stringify(['Radar']),
     JSON.stringify(r1.bubbles));
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
