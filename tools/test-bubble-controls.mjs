#!/usr/bin/env node
/*
 * Every bubble, at every depth, has an info button - and, now, nothing else.
 *
 *     node tools/test-bubble-controls.mjs
 *
 * There are about twenty places in index.html that build a bubble, and they
 * had drifted apart: the top row had an info button, the product rows had
 * one only where somebody had happened to write a description. Asking twenty
 * builders to stay in step forever is asking for exactly that drift, so the
 * column is decorated after the fact instead.
 *
 * A drag handle used to sit beside that info button on every row, reordering
 * the BUTTONS in this menu - never what draws on top of what on the map,
 * which people kept assuming it did. That handle is gone: the real way to
 * restack the map is Settings -> Layer Order, which now covers every layer
 * there is, so this file checks the drag handle's absence instead of its
 * presence.
 *
 * Which makes this the test that matters: it opens every menu the app has,
 * walks down into every level of every one, and checks what is actually in
 * the DOM. A test that checked the decorator function in isolation would pass
 * on a menu the observer never saw.
 *
 * The counts are checked as an absence, because they were asked to go.
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

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
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
await page.evaluate(() => { if (typeof closeTutorial === 'function') closeTutorial(); });

// Stand in an MRMS manifest so the MRMS menus have something to build from
// without a parsing server. The labels are real ones off the catalogue.
await page.evaluate(() => {
  _mrmsManifest = { products: {
    rotation:   { label: 'Rotation Tracks', unit: 's-1', min: 0, max: 0.01 },
    mesh:       { label: 'Max Estimated Hail Size', unit: 'mm', min: 0, max: 100 },
    posh:       { label: 'Prob of Severe Hail', unit: '%', min: 0, max: 100 },
    composite:  { label: 'Composite Reflectivity', unit: 'dBZ', min: -10, max: 75 },
    hsr:        { label: 'Hybrid Scan Reflectivity', unit: 'dBZ', min: -10, max: 75 },
    echotop18:  { label: 'Echo Top 18 dBZ', unit: 'kft', min: 0, max: 70 },
    preciprate: { label: 'Precip Rate', unit: 'mm/hr', min: 0, max: 100 },
    ltgdensity: { label: 'Lightning Density', unit: '', min: 0, max: 10 },
    h0c:        { label: 'Freezing Level Height', unit: 'm', min: 0, max: 5000 },
  } };
  // The MRMS menu reads its catalogue off the parsing server, and there is no parsing server here.
  // Hand it the stub above rather than letting it fall back to "No MRMS
  // built yet", which is a status line and not a menu to walk.
  window._mrmsFetchManifest = async () => _mrmsManifest;

  // Read the column the way a person sees it, one level at a time.
  window.__read = () => {
    const w = document.getElementById('sub-bubbles');
    const rows = [...w.querySelectorAll('.sub-bubble')];
    return rows.map(el => ({
      label: ((el.querySelector('.sb-label') || {}).textContent
              || el.textContent || '').trim().slice(0, 40),
      back: el.classList.contains('sb-back') || el.classList.contains('sb-note'),
      main: el.classList.contains('sub-bubble-main'),
      info: !!el.querySelector('.ov-info-btn'),
      drag: !!el.querySelector('.sb-drag'),   // must never be true any more
      count: !!el.querySelector('.sb-count'),
    }));
  };
});

// Walk into a menu and report every row, at every level it opens into.
async function walk(open, downSelectors) {
  return page.evaluate(async ({ open, downSelectors }) => {
    const w = () => document.getElementById('sub-bubbles');
    const settle = () => new Promise(r => requestAnimationFrame(
      () => requestAnimationFrame(() => setTimeout(r, 30))));
    const seen = [];
    // eslint-disable-next-line no-new-func
    new Function(open)();
    await settle();
    seen.push({ level: 0, rows: window.__read() });
    let depth = 1;
    for (const sel of downSelectors) {
      const btn = w().querySelector(sel);
      if (!btn) break;
      btn.click();
      await settle();
      seen.push({ level: depth++, rows: window.__read() });
    }
    return seen;
  }, { open, downSelectors });
}

const menus = [
  ['the top row', 'renderSubBubbles("regular")', []],
  ['satellite', 'toggleSatelliteSub()', ['[data-sat-kind="rgb"]', '[data-sat-cat]']],
  ['satellite, the other branch', 'toggleSatelliteSub()',
    ['[data-sat-kind="abi"]', '[data-sat-cat]']],
  ['MRMS', 'toggleMrmsSub()', ['[data-mrms-group="severe"]']],
  ['radar', 'toggleRadarSub()', []],
  ['waves', 'toggleWavesSub()', []],
  ['air quality', 'toggleAirSub()', []],
  ['temperature', 'toggleTemperatureSub()', []],
  ['pressure', 'togglePressureSub()', []],
  ['wind', 'toggleWindSub()', []],
];

console.log('\n1. every bubble in every menu has both buttons');
let totalRows = 0, totalLevels = 0;
for (const [name, open, down] of menus) {
  let levels;
  try { levels = await walk(open, down); }
  catch (e) { ok(`${name} opens`, false, e.message); continue; }
  const rows = levels.flatMap(l => l.rows).filter(r => !r.back);
  totalRows += rows.length;
  totalLevels += levels.length;
  const noInfo = rows.filter(r => !r.info).map(r => r.label);
  const hasDrag = rows.filter(r => r.drag).map(r => r.label);
  ok(`${name}: it built something to check`, rows.length > 0,
     `${levels.length} levels`);
  ok(`${name}: every bubble has an info button`,
     noInfo.length === 0, noInfo.join(', ').slice(0, 120));
  ok(`${name}: no bubble has a drag handle any more`,
     hasDrag.length === 0, hasDrag.join(', ').slice(0, 120));
}
// The decorator runs off a MutationObserver, so it has to have really fired
// across every one of those rebuilds rather than once at boot.
ok('and that was a real walk, not one menu opened twice',
   totalLevels >= 14 && totalRows >= 40, `${totalLevels} levels, ${totalRows} rows`);

console.log('\n2. the stray counts are gone');
{
  const r = await page.evaluate(async () => {
    const settle = () => new Promise(res => setTimeout(res, 80));
    toggleSatelliteSub(); await settle();
    const top = window.__read();
    document.querySelector('[data-sat-kind="abi"]').click(); await settle();
    const cats = window.__read();
    toggleMrmsSub(); await settle();
    const mrms = window.__read();
    return { top, cats, mrms, css: !!document.querySelector('.sb-count') };
  });
  const anyCount = [...r.top, ...r.cats, ...r.mrms].some(x => x.count);
  ok('no bubble carries a count chip any more', !anyCount);
  ok('and none is left anywhere in the document', !r.css);
  // The label itself must survive: removing the number must not have taken
  // the name with it.
  ok('the labels are still there', r.top.some(x => /ABI Bands/i.test(x.label)),
     JSON.stringify(r.top.map(x => x.label)));
}

console.log('\n3. the info buttons say something real');
{
  const r = await page.evaluate(async () => {
    const settle = () => new Promise(res => setTimeout(res, 80));
    toggleSatelliteSub(); await settle();
    const w = document.getElementById('sub-bubbles');
    const texts = [];
    // A hand-written description for a new grouping bubble.
    w.querySelector('[data-sat-kind="rgb"] .ov-info-btn').click(); await settle();
    texts.push(document.getElementById('ov-info-tooltip').textContent);
    document.querySelector('[data-sat-kind="rgb"]').click(); await settle();
    w.querySelector('[data-sat-cat] .ov-info-btn').click(); await settle();
    texts.push(document.getElementById('ov-info-tooltip').textContent);
    // And one built from the catalogue for a product nobody wrote about.
    const bare = document.createElement('div');
    bare.innerHTML = '<span class="sb-label">Rotation Tracks</span>';
    const auto = _sbAutoInfo(bare);
    const el = document.createElement('div');
    el.innerHTML = '<span class="sb-label">Rotation Tracks</span>';
    el.dataset.mrmsId = 'rotation';
    return { texts, auto, fromCatalogue: _sbAutoInfo(el) };
  });
  ok('a grouping bubble explains what is behind it',
     r.texts[0].length > 60 && /composite/i.test(r.texts[0]),
     r.texts[0].slice(0, 90));
  ok('and so does a category', r.texts[1].length > 40, r.texts[1].slice(0, 90));
  // Not filler: the fallback is built from what the catalogue really holds.
  ok('an undescribed product still gets its real units and scale',
     /Rotation Tracks/.test(r.fromCatalogue) && /s-1/.test(r.fromCatalogue)
     && /0 to 0\.01/.test(r.fromCatalogue), r.fromCatalogue);
  // And where nothing at all is known it says so rather than inventing.
  ok('and where nothing is known it says so plainly',
     /No description has been written/.test(r.auto), r.auto.slice(0, 80));
}

console.log('\n4. the way back out is not a layer');
{
  const r = await page.evaluate(async () => {
    const settle = () => new Promise(res => setTimeout(res, 80));
    toggleMrmsSub(); await settle();
    const back = document.querySelector('#sub-bubbles .sb-back');
    return back ? { info: !!back.querySelector('.ov-info-btn'),
                    drag: !!back.querySelector('.sb-drag'),
                    first: back === document.getElementById('sub-bubbles')
                             .querySelector('.sub-bubble') } : null;
  });
  ok('there is a back pill', !!r);
  // It turns nothing on and it belongs at the top, so it has nothing to
  // describe, and it never carried a drag handle even before that was
  // removed from every other row too.
  ok('it carries no info button, and no drag handle', r && !r.info && !r.drag, JSON.stringify(r));
  ok('and it stays first', r && r.first, JSON.stringify(r));
}

console.log('\n5. nothing above threw');
{
  const real = errors.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await browser.close();
console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`all ${pass} passed`);
