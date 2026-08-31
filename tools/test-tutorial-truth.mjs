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

console.log('\n1. the map style menu is reachable again');
{
  // It was six loose .right-bubble divs parented straight to #map-wrap, with
  // nothing positioning them. They stacked full-width past the bottom of a
  // wrapper that clips overflow, so they were in the DOM and off the screen.
  ok('the rows live inside a container now',
     /<div id="map-style-menu">[\s\S]{0,2600}?id="rm-fullscreen"/.test(PAGE));
  ok('and it is positioned rather than left to flow',
     /#map-style-menu \{[\s\S]{0,300}position: absolute;/.test(PAGE));
  // Dark is the default basemap, and rmActivate has always tried to
  // un-highlight an #rm-dark that did not exist.
  ok('Dark has a row, so you can get back to the default',
     /id="rm-dark"[^>]*onclick="setMapType\('dark'\)/.test(PAGE));
  ok('and picking Topo un-highlights the others',
     /\['rm-dark','rm-satellite','rm-light','rm-topo'\]/.test(PAGE));
  ok('clean mode hides it with the rest of the chrome',
     /body\.clean-mode #map-style-menu,/.test(PAGE));
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
  ok('the quick menu is described with all five of its buttons',
     ['Settings', 'Navigation', 'Tutorial', 'Credits', 'Feedback']
       .every(b => /LOGO QUICK MENU[\s\S]{0,1600}/.exec(TUT)[0].includes(b)));
  ok('and as shown by default rather than hidden behind the logo',
     says('shown from the first paint'));
  ok('the overlay launcher is counted, not estimated',
     says('32 optional layers') && !says('20+ optional layers'));
  ok('Settings is described as fifteen tabs',
     says('Fifteen tabs'));
  ok('rotation says three fingers everywhere, since that is the gesture',
     !/two-finger rotate/.test(TUT));
  ok('nothing still claims a Sea Surface Temp row (it reads Sea Surf. Temp)',
     !says('Sea Surface Temp'));
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
    const seen = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2
          && r.top < innerHeight && r.bottom > 0
          && r.left < innerWidth && r.right > 0;
    };
    // The whole point: these are on the screen, not merely in the DOM.
    out.styleRows = [...document.querySelectorAll('#map-style-menu .right-bubble')]
      .map(e => ({ id: e.id, on: seen(e), text: e.textContent.trim() }));
    // And they do not sit on top of the tool rail or the overlay button.
    const box = (id) => {
      const e = document.getElementById(id);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    out.menu = document.getElementById('map-style-menu').getBoundingClientRect().toJSON();
    out.rail = box('right-menu');
    out.ovBtn = box('overlay-toggle-btn');
    // Picking a style highlights exactly one row.
    try { setMapType('topo'); rmActivate('rm-topo'); } catch (e) {}
    out.litAfterTopo = ['rm-dark', 'rm-satellite', 'rm-light', 'rm-topo']
      .filter(i => document.getElementById(i).classList.contains('active'));
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
    return out;
  });
  await b.close();

  ok('all seven map style rows are on the screen',
     r.styleRows.length === 7 && r.styleRows.every(x => x.on),
     r.styleRows.filter(x => !x.on).map(x => x.id).join(', '));
  ok('and they read Dark, Satellite, Light, Topo, Locate, Smooth, Fullscreen',
     r.styleRows.map(x => x.text).join(',')
       === 'Dark,Satellite,Light,Topo,Locate,Smooth,Fullscreen',
     r.styleRows.map(x => x.text).join(','));
  ok('the menu sits below the tool rail, not across it',
     r.rail && r.menu.top >= r.rail.bottom,
     `menu ${Math.round(r.menu.top)} vs rail ${r.rail && Math.round(r.rail.bottom)}`);
  ok('and clear of the overlay button underneath it',
     r.ovBtn && r.menu.bottom <= r.ovBtn.top,
     `menu ${Math.round(r.menu.bottom)} vs button ${r.ovBtn && Math.round(r.ovBtn.top)}`);
  ok('picking a base map lights exactly one row',
     r.litAfterTopo.length === 1 && r.litAfterTopo[0] === 'rm-topo',
     r.litAfterTopo.join(', '));

  ok('the tutorial renders all eighteen sections', r.sections.length === 18,
     String(r.sections.length));
  ok('with its cards intact', r.cards > 90, String(r.cards));
  ok('and no icon reference points at a symbol that does not exist',
     r.brokenIcons.length === 0, r.brokenIcons.join(', '));
  ok('it is a long read, as a complete tutorial should be',
     r.height > 15000, String(r.height));
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
