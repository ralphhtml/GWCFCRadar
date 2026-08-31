#!/usr/bin/env node
/*
 * The tutorial has to describe THIS app.
 *
 *     node tools/test-tutorial-truth.mjs
 *
 * A tutorial rots quietly. Nothing breaks when a menu is reorganised and the
 * tutorial keeps describing the old one; the only person who finds out is
 * somebody following it, and they conclude the app is broken rather than the
 * page. That is what had happened here. The tutorial said the Radar bubble
 * offered five products, when it offers five SOURCES and the products are a
 * level below. It said Models had two panels when it has three. It described
 * a quick menu of three buttons that has five, an overlay launcher of "20+"
 * rows that has 32, and a right-side bubble menu that had lost its container
 * and was rendering off the bottom of the page where nobody could reach it.
 *
 * So the specific claims that were wrong are pinned here, against the running
 * page rather than against the source, because "what does the app show" is a
 * question only a browser can answer honestly. Each check is written as the
 * claim the tutorial makes, so a failure names the sentence to fix.
 *
 * tools/audit-tutorial.mjs is the wider net: it reads every bolded term back
 * against a live inventory and prints the candidates. This file is the part
 * of that worth failing a build over.
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

// The tutorial body, as its own string, so a phrase found elsewhere in the
// 68,000-line page cannot be mistaken for the tutorial saying it.
const TUT = (() => {
  const a = PAGE.indexOf('<div id="tut-modal-body">');
  const b = PAGE.indexOf('function openTutorial', a);
  return PAGE.slice(a, b > 0 ? b : a + 120000);
})();
const says = (s) => TUT.includes(s);

console.log('\n1. the map style menu is gone, and nothing it held was lost');
{
  // Restoring this row was my call and it was the wrong one: it put seven
  // more buttons down the side of a map that is the whole point of the app.
  // Removed. What matters now is that nothing it carried became unreachable
  // a second time, which is the failure the row was rescued from.
  ok('the floating row is gone', !/id="map-style-menu"/.test(PAGE));
  ok('and so is the styling for it', !/\.right-bubble/.test(PAGE));
  ok('base map still has a control', /id="lqm-set-maptype"/.test(PAGE));
  ok('Smooth still has one', /id="lqm-set-smooth"/.test(PAGE));
  ok('Locate has a home in Settings rather than nowhere',
     /onclick="locateUser\(\)"/.test(PAGE));
  ok('Fullscreen is still on the animation bar', /id="fullscreen-btn"/.test(PAGE));
  // toggleSmooth reached for the removed row without a null check, so this is
  // the line that would have thrown on the first tap after the removal.
  ok('toggleSmooth no longer reaches for an element that is gone',
     !/getElementById\('rm-smooth'\)/.test(PAGE));
  ok('and nothing else refers to the dead ids',
     !/rm-dark|rm-locate|rm-topo|rm-fullscreen/.test(PAGE));
}

console.log('\n2. the claims that were wrong');
{
  // Radar opens SOURCES. Reflectivity and friends are one level below, under
  // Normal, and the dual-pol four are under Level 2.
  ok('Radar is described as five sources, not five products',
     says('Radar, and its five sources'));
  ['Normal', 'Level 2', 'Level 3', 'Composite'].forEach(s =>
    ok('  the ' + s + ' source is named', says('>' + s.toUpperCase() + '<')));
  ok('the dual-pol products are placed under Level 2, where they are',
     /LEVEL 2[\s\S]{0,600}Spectrum Width/.test(TUT));
  ok('Models is three panels, not two',
     says('Three sub-bubbles') && says('AI Cyclones'));
  // The row under the logo is retired; the five app buttons live at the top
  // of the account panel now, and the tutorial says so.
  ok('the account menu is described with all five of its buttons',
     ['Settings', 'Navigation', 'Tutorial', 'Credits', 'Feedback']
       .every(b => /ACCOUNT MENU[\s\S]{0,1600}/.exec(TUT)[0].includes(b)));
  ok('and as open to everyone, signed in or not',
     says('there whether or not you are signed in'));
  ok('the overlay launcher is counted, not estimated',
     says('32 optional layers') && !says('20+ optional layers'));
  ok('Settings is described as fifteen tabs',
     says('Fifteen tabs'));
  ok('rotation says three fingers everywhere, since that is the gesture',
     !/two-finger rotate/.test(TUT));
  ok('nothing still claims a Sea Surface Temp row (it reads Sea Surf. Temp)',
     !says('Sea Surface Temp'));
}

console.log('\n2b. the bubble diagram is generated, not drawn by hand');
{
  // It used to be static HTML that hung a badge on every row: NEXRAD, GOES,
  // MARINE, AQI, SPEED, 2M, MSLP, 3 PANELS. No bubble in this app has ever
  // had a badge, so anyone following the tutorial went hunting for a tag
  // that does not exist. It also used sprite icons rather than the bubbles'
  // own, and left off the info button and drag handle every real row has.
  ok('the invented badges are gone',
     !/class="lr-badge/.test(PAGE) && !/\.lr-badge\s*[{,]/.test(PAGE));
  ok('and so is the hand-drawn row', !/layer-row-demo/.test(PAGE));
  ok('the diagram is a container the page fills in',
     /<div id="tut-bubble-demo" class="tut-bubble-demo"><\/div>/.test(PAGE));
  ok('it is built from the same list the real column is built from',
     /BASE_BUBBLES/.test(
       (PAGE.match(/function _tutRenderBubbleDemo\(\)[\s\S]*?\n\}/) || [''])[0]));
  ok('and it renders every time the tutorial opens, by any route',
     /function openTutorial\(\)[\s\S]{0,800}_tutRenderBubbleDemo\(\)/.test(PAGE));
  ok('an unreadable list says so rather than drawing a fake one',
     /nothing to show here rather than a drawing/.test(PAGE));
}

console.log('\n3. the features it never mentioned at all');
{
  const sections = [...TUT.matchAll(/<section class="section" id="([a-z]+)"/g)]
    .map(m => m[1]);
  ['overview', 'chrome', 'account', 'layers', 'time', 'alerts', 'overlays',
   'radio', 'spc', 'tropical', 'models', 'cyclones', 'tools', 'settings',
   'nav', 'keys', 'tips', 'feedback']
    .forEach(id => ok('there is a #' + id + ' section', sections.includes(id)));
  ok('every section has a table-of-contents link',
     sections.every(id => TUT.includes('href="#' + id + '"')),
     sections.filter(id => !TUT.includes('href="#' + id + '"')).join(', '));
  ok('and every link has a section',
     [...TUT.matchAll(/class="toc-link[^"]*" href="#([a-z]+)"/g)]
       .every(m => sections.includes(m[1])));
  // The eight that were missing entirely.
  [['Time Machine', 'Time Machine'],
   ['AI Cyclones', 'AI CYCLONES'],
   ['Cross Section', 'CROSS SECTION'],
   ['the right-click menu', 'Right-click anywhere on the map'],
   ['soundings', 'SOUNDING HERE'],
   ['keyboard shortcuts', 'KEYBOARD SHORTCUTS'],
   ['starred search', 'SEARCH &amp; STARS'],
   ['the export tool', 'Exporting a loop']]
    .forEach(([what, needle]) => ok(what + ' is covered', says(needle)));
}

console.log('\n4. in a real browser');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping');
} else {
  const b = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('dialog', d => d.dismiss().catch(() => {}));
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  await p.goto('file://' + join(ROOT, 'index.html'),
               { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2800);
  const r = await p.evaluate(async () => {
    const out = {};
    out.styleRows = document.querySelectorAll('#map-style-menu .right-bubble').length;
    // The diagram against the real column, side by side. Labels, icons and
    // the order of the parts all have to agree, because the whole point of
    // generating it is that it cannot say anything the app does not.
    try { renderSubBubbles('regular'); } catch (e) {}
    const realRows = [...document.querySelectorAll('#sub-bubbles .sub-bubble-main')];
    out.realLabels = realRows.map(x => x.querySelector('.sb-label').textContent);
    out.realIcon = realRows[0]
      ? realRows[0].querySelector('.sb-icon').innerHTML : '';
    // The tutorial renders, with its sections and links intact.
    try { lqmOpenTutorial(); } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
    const body = document.getElementById('tut-modal-body');
    out.sections = [...body.querySelectorAll('.section')].map(s => s.id);
    out.cards = body.querySelectorAll('.feature-card').length;
    // A <use href="#ic-..."> pointing at a symbol that does not exist paints
    // nothing at all, and looks like a missing word rather than a bug.
    out.brokenIcons = [...body.querySelectorAll('use')]
      .map(u => u.getAttribute('href'))
      .filter(h => h && h.startsWith('#') && !document.querySelector(h));
    out.height = body.scrollHeight;
    const demoRows = [...body.querySelectorAll('.tut-bubble-row')];
    out.demoLabels = demoRows.map(x => x.querySelector('.sb-label').textContent);
    out.demoIcon = demoRows[0]
      ? demoRows[0].querySelector('.sb-icon').innerHTML : '';
    out.demoParts = demoRows[0]
      ? [...demoRows[0].children].map(c => c.className) : [];
    return out;
  });
  await b.close();

  ok('no floating map style row is on the screen', r.styleRows === 0,
     String(r.styleRows));

  ok('the tutorial renders all eighteen sections', r.sections.length === 18,
     String(r.sections.length));
  ok('with its cards intact', r.cards > 90, String(r.cards));
  ok('and no icon reference points at a symbol that does not exist',
     r.brokenIcons.length === 0, r.brokenIcons.join(', '));
  ok('it is a long read, as a complete tutorial should be',
     r.height > 15000, String(r.height));
  ok('the diagram lists exactly the real bubbles, in order',
     JSON.stringify(r.demoLabels) === JSON.stringify(r.realLabels),
     `${r.demoLabels} vs ${r.realLabels}`);
  ok('and draws them with the bubbles\' own icons',
     r.demoIcon === r.realIcon && r.demoIcon.length > 20);
  ok('with the info button and drag handle a real row has',
     r.demoParts.join(',')
       === 'sb-icon,sb-label,tut-bubble-info,tut-bubble-drag',
     r.demoParts.join(','));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n5. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-tutorial-truth.mjs',
                 'tools/audit-tutorial.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
  // This used to pin the update bar to the exact sentence shipped with the
  // tutorial rewrite, which made every LATER change fail a test about the
  // tutorial. The bar is rewritten on purpose at every change; what this
  // suite can honestly hold it to is that it says something at all.
  const bar = (PAGE.match(/const APP_LATEST_UPDATE = '([\s\S]*?)';\n/) || [])[1];
  ok('the update bar carries a message', !!bar && bar.length > 20,
     bar ? String(bar.length) : 'missing');
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
