#!/usr/bin/env node
/*
 * The logo quick menu: the row of buttons under the logo.
 *
 *     node tools/test-quickmenu.mjs
 *
 * IT USED TO BE INVISIBLE. Settings, the tutorial, credits and feedback all
 * lived behind hovering or tapping the logo, and nothing on screen said so.
 * Somebody who never guessed to touch the logo never found any of them. It is
 * shown from the first paint now, and stays shown, until the switch in
 * Settings turns it off. Turning it off has to restore the old behaviour
 * exactly, because this is a change of default and not a removal.
 *
 * NAVIGATION IS A BUTTON NOW. It was a row inside Settings, which put a whole
 * mode two panels deep. It is a button in this row alongside the others.
 *
 * WHAT THE PIN COULD BREAK. The outside-click handler that closes the menu
 * also clears the search box, and it used to be mostly dormant because the
 * menu was mostly closed. With the menu open all the time it now runs on
 * every click on the page, so the search bar has to be exempt or typing a
 * place name gets wiped by the click that focused the field. That is the
 * regression this change could plausibly have shipped, so it is tested in a
 * real browser rather than reasoned about.
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

console.log('\n1. the pin, in the source');
{
  ok('it has its own saved key', /const LQM_PIN_KEY = 'gwcfc_lqm_pin';/.test(PAGE));
  // Absent means never chosen, and the new default is on. Only the literal
  // '0' is off, so no other stored value can read as "hide it".
  ok('never chosen means shown',
     /localStorage\.getItem\(LQM_PIN_KEY\) !== '0'/.test(PAGE));
  ok('a storage that throws does not cost the page its menu',
     /_menuPinned = true;[\s\S]{0,300}catch \(e\) \{\}/.test(PAGE));
  ok('the Settings switch is exported for the markup to call',
     /window\.lqmSetMenuPin = function\(on\)/.test(PAGE));
  ok('turning it off puts the menu away now, not just next time',
     /else \{ _menuOpen = true; _closeMenu\(\); \}/.test(PAGE));
  ok('there is a switch in Settings',
     /id="lqm-set-menupin"[^>]*onchange="lqmSetMenuPin\(this\.checked\)"/.test(PAGE));
  ok('and it starts checked, matching the default',
     /id="lqm-set-menupin" checked/.test(PAGE));
  ok('the switch says what turning it off restores',
     /appearing only when you hover or tap the logo/.test(PAGE));
}

console.log('\n2. Navigation is a button in the row');
{
  ok('the button exists', /id="lqm-nav-btn"/.test(PAGE));
  ok('and opens navigation directly',
     /id="lqm-nav-btn" onclick="_navOpen\(\)"/.test(PAGE));
  ok('_navOpen is a real top-level function it can reach',
     /\nfunction _navOpen\(\) \{/.test(PAGE));
  // The Settings row stays. Removing it would break the habit of anyone who
  // already knows where it is, for no gain.
  ok('the Settings row still offers it too',
     /<button class="lqm-settings-btn" onclick="_navOpen\(\)">Open Navigation<\/button>/
       .test(PAGE));
}

console.log('\n3. in a real browser');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(async () => {
    const out = {};
    const menu = document.getElementById('logo-quick-menu');
    const vis = () => getComputedStyle(menu).opacity;
    // The menu fades over 0.22s. Reading opacity the instant the class
    // changes reads the value it is fading FROM, so every check of what is
    // painted waits the transition out first.
    const settled = () => new Promise(r => setTimeout(r, 400));

    // On a first visit, with nothing stored, the buttons are simply there.
    out.openOnLoad = menu.classList.contains('lqm-open');
    out.opacityOnLoad = vis();
    out.labels = Array.from(menu.querySelectorAll('.lqm-label'))
      .map(s => s.textContent.trim());
    // Every button has to be clickable, not just painted: the wrapper turns
    // pointer events off and the children opt back in.
    out.clickable = Array.from(menu.querySelectorAll('.lqm-btn'))
      .every(el => getComputedStyle(el).pointerEvents !== 'none');
    out.settingsBoxChecked =
      !!document.getElementById('lqm-set-menupin').checked;

    // A click on the map must not put it away while it is pinned.
    document.getElementById('map').click();
    out.openAfterMapClick = menu.classList.contains('lqm-open');

    // The search box is the thing the always-on outside-click handler could
    // break: focusing it counts as a click outside the menu.
    lqmOpenSearch();
    const inp = document.getElementById('lqm-search-input');
    inp.value = 'norman ok';
    inp.click();
    out.searchSurvivesItsOwnClick = inp.value;

    // Turning it off restores the old behaviour, right now.
    lqmSetMenuPin(false);
    out.openAfterOff = menu.classList.contains('lqm-open');
    await settled();
    out.opacityAfterOff = vis();
    out.stored = localStorage.getItem('gwcfc_lqm_pin');
    // And hovering still brings it back, which is the whole of the old way.
    lqmOpenMenu();
    out.openAfterReopen = menu.classList.contains('lqm-open');
    document.getElementById('map').click();
    out.closesOnOutsideClickWhenOff = !menu.classList.contains('lqm-open');

    lqmSetMenuPin(true);
    out.storedOn = localStorage.getItem('gwcfc_lqm_pin');
    out.openAfterBackOn = menu.classList.contains('lqm-open');
    return out;
  });
  await b.close();

  ok('a first visit shows the menu without touching anything', r.openOnLoad);
  ok('and it is actually painted, not merely class-tagged',
     r.opacityOnLoad === '1', r.opacityOnLoad);
  ok('Navigation is one of the buttons', r.labels.includes('Navigation'),
     r.labels.join(', '));
  ok('alongside the four that were always there',
     ['Settings', 'Tutorial', 'Credits', 'Feedback']
       .every(l => r.labels.includes(l)), r.labels.join(', '));
  ok('every button can be clicked', r.clickable);
  ok('the Settings switch shows the state it is actually in',
     r.settingsBoxChecked);
  ok('clicking the map does not put it away while pinned', r.openAfterMapClick);
  ok('and typing in the search box survives the click that focused it',
     r.searchSurvivesItsOwnClick === 'norman ok', r.searchSurvivesItsOwnClick);
  ok('turning the switch off hides it immediately', r.openAfterOff === false);
  ok('and it stops being painted', r.opacityAfterOff === '0', r.opacityAfterOff);
  ok('the choice is remembered', r.stored === '0', String(r.stored));
  ok('with it off, the logo still opens it as it always did', r.openAfterReopen);
  ok('and a click outside closes it again', r.closesOnOutsideClickWhenOff);
  ok('turning it back on shows it again', r.openAfterBackOn);
  ok('and records that too', r.storedOn === '1', String(r.storedOn));
}

console.log('\n4. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-quickmenu.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
