#!/usr/bin/env node
/*
 * Satellite compare: the radar comparison's strips, applied to the GOES
 * pictures.
 *
 *     node tools/test-sat-compare.mjs
 *
 * Strip A is the satellite picture already on screen, untouched. Every
 * strip after it is another picture clipped to its own band: a different
 * channel or composite, a different sector, or the other satellite. A
 * strip snapshots the product AND sector chosen when it was added, which
 * is what lets one comparison mix all three axes. While the Compare
 * bubble is lit, a product tap adds a strip instead of replacing the main
 * picture, and a sector tap adds the current product from that sector.
 * Strips follow the playbar at their own frame nearest strip A's moment.
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

console.log('\n1. the pieces are in the page');
{
  ok('the strip containers exist beside the radar comparison\'s',
     /id="sc-dividers"/.test(PAGE) && /id="sc-labels"/.test(PAGE));
  ok('the Compare bubble is drawn at every level of the satellite menu',
     (PAGE.match(/_scCompareBubble\(wrap\);/g) || []).length === 3);
  ok('a product tap adds a strip while a comparison is running, picking up any pending sector',
     /if \(typeof _scOn !== 'undefined' && _scOn && activeLayers\.satellite\) \{[\s\S]{0,600}_scAddSlot\(p\.id, region !== null \? region : undefined\);/.test(PAGE));
  ok('a sector tap adds the current product from that sector',
     /_scAddSlot\(_goesProductId, r\.id\);/.test(PAGE));
  ok('the strip planners are the main picture\'s own, parameterised',
     /function _goesConfigFor\(product, regionId\)/.test(PAGE)
     && /function _goesPiTargetFor\(product, regionId\)/.test(PAGE)
     && /async function _goesPiFramesFor\(product, regionId\)/.test(PAGE));
  ok('the geometry helpers are shared with the radar comparison',
     PAGE.includes('function _stripGeometry(leftPct, rightPct, axis)')
     && PAGE.includes('function _gridGeometry(leftPct, rightPct, topPct, bottomPct)')
     // Both split systems position their shared lines through the same
     // one-axis geometry: two calls each (columns and rows).
     && (PAGE.match(/_stripGeometry\(pct, pct, 'x'\)/g) || []).length === 2
     && (PAGE.match(/_stripGeometry\(pct, pct, 'y'\)/g) || []).length === 2);
  ok('a bubble in a running comparison wears the strip ring',
     /\.sub-bubble\.in-compare \{/.test(PAGE));
  ok('and the info description says what it does',
     /'sat-compare': 'Splits the map/.test(PAGE));
  ok('a comparison IS a split, growing double to quad to octo exactly as the radars',
     /if \(!_scGrid\) _scSetGrid\(1, 2\);/.test(PAGE)
     && /function _scGridGrow\(\) \{/.test(PAGE)
     && /if \(_scSlots\.length >= _scMaxStrips\(\) && !_scGridGrow\(\)\) \{/.test(PAGE));
  ok('the satellite split lines wear the same drag grip and rotate handle as the radars',
     /function _scRefreshGridDOM[\s\S]{0,900}_cmpLineHandles\(d, _scToggleOrientation\);/.test(PAGE));
  ok('a parsing server strip reclips the instant its own image lands, not just on the next pan/zoom '
     + '(the same race radar compare had to fix)',
     /if \(!slot\.layer\) \{\s*\n\s*slot\.layer = L\.imageOverlay\(f\.url, f\.bounds,[\s\S]{0,600}_scUpdateClips\(\);\s*\n\s*\} else \{/.test(PAGE));
  ok('the rotate button transposes the split, same shape as radar\'s',
     PAGE.includes('id="sc-rotate-btn"')
     && /function _scToggleOrientation\(\) \{\s*\n\s*if \(!_scOn \|\| !_scGrid\) return;\s*\n\s*if \(!_scSetGrid\(_scGrid\.cols, _scGrid\.rows\)\) return;/.test(PAGE));
  ok('a peek button reuses the shared hide-for-ten-seconds function, and satellite off cleans it up',
     PAGE.includes('id="sc-peek-btn"') && PAGE.includes("onclick=\"_cmpPeek('sc')\"")
     && /function _scOff\(\) \{[\s\S]*?_cmpPeekReset\('sc'\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sat-compare.mjs'), 'utf8').includes(EM));
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
  // Otherwise the Lite/Expert mode picker sits over the whole map on
  // first load - invisible to clicks that call .click() on an element
  // directly, but not to a real screen-coordinate mouse click.
  try { localStorage.setItem('gwcfc_mode', 'expert'); } catch (e) {}
});
// A 1x1 PNG stands in for every tile, so WMS layers "load" instantly.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64');
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (/mesonet/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4500);
// Marking the tutorial seen (above) makes this a "returning visitor" as
// far as the What Changed modal is concerned, so it auto-opens over the
// whole map - invisible to every .click() call in this file since none
// of them read a real screen coordinate, but section 4/5/6 below do. The
// open attempt is on a delayed timer inside _actuallyDismiss, so closing
// it once here raced that timer rather than beating it outright; marking
// it seen stops the delayed attempt from ever opening it.
await p.evaluate(() => {
  try { if (typeof _clMarkSeen === 'function') _clMarkSeen(); } catch (e) {}
  const m = document.getElementById('changelog-modal');
  if (m) m.classList.remove('open');
});

console.log('\n2. strips are added, planned, clipped and labelled');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // Compare with the layer off turns the satellite on first: choosing
    // Compare IS asking for satellite pictures.
    _scToggle();
    out.onFromOff = _scOn && !!activeLayers.satellite;
    _scOff();
    _setGoesProduct('ch13');
    await new Promise(r2 => setTimeout(r2, 900));
    out.satOn = !!activeLayers.satellite;
    toggleSatelliteSub();   // the menu is where the Compare bubble lives
    _scToggle();
    out.on = _scOn;
    out.bubbleLit = document.getElementById('sub-sat-compare')
      ? document.getElementById('sub-sat-compare').classList.contains('active') : 'no bubble';
    // Another channel joins in the current sector.
    _scAddSlot('ch08');
    // The same channel from another sector: the East-vs-West comparison.
    _scAddSlot('ch13', 'west');
    out.slots = _scSlots.map(s => s.productId + '/' + s.regionId);
    const pane = map.getPane('sc-' + _scSlots[0].id);
    out.clipped = !!pane && /polygon/.test(pane.style.clipPath);
    out.photo = !!pane && pane.classList.contains('wx-photo');
    out.kind = _scSlots[0].kind;
    out.wmsLayers = _scSlots.map(s => s.layer && s.layer.wmsParams && s.layer.wmsParams.layers);
    out.dividers = document.querySelectorAll('#sc-dividers .rc-divider').length;
    out.labels = Array.from(document.querySelectorAll('#sc-labels .rc-label-text'))
      .map(t => t.textContent);
    // Strip A itself is refused as a strip.
    _scAddSlot('ch13');
    out.afterDup = _scSlots.length;
    return out;
  });
  ok('with the layer off, Compare turns the satellite on and starts', r.onFromOff === true);
  ok('with the satellite on it starts, and the bubble lights',
     r.satOn && r.on && r.bubbleLit === true, JSON.stringify(r.bubbleLit));
  ok('a channel strip and a sector strip both join',
     JSON.stringify(r.slots) === '["ch08/auto","ch13/west"]', JSON.stringify(r.slots));
  ok('each strip is a WMS layer of its own product and sector',
     r.kind === 'wms' && r.wmsLayers[0] === 'conus_ch08' && r.wmsLayers[1] === 'conus_ch13',
     JSON.stringify(r.wmsLayers));
  ok('the strip pane is clipped to its band, in photo rendering',
     r.clipped && r.photo, JSON.stringify({ c: r.clipped, p: r.photo }));
  // Three pictures on screen is a quad split: one column line, one row
  // line, and a corner label per pane lettered from B.
  ok('shared split lines only, and a corner label per pane, lettered from B',
     r.dividers === 2 && r.labels.length === 2 && /^B {2}Upper Water Vapor/.test(r.labels[0])
     && /^C {2}Clean IR · West CONUS/.test(r.labels[1]), JSON.stringify(r.labels));
  ok('pane A cannot be added to itself', r.afterDup === 2, String(r.afterDup));
}

console.log('\n3. the strips follow the playbar and leave cleanly');
{
  const r = await p.evaluate(async () => {
    const out = {};
    const before = _scSlots[0].frameIso;
    goesCurrentFrame = 0;
    await new Promise(r2 => setTimeout(r2, 700));
    out.retimed = _scSlots[0].frameIso !== before;
    out.timeApplied = _scSlots[0].layer.wmsParams.TIME === _scSlots[0].frameIso;
    // A strip's own product, tapped again, takes it out.
    _scAddSlot('ch08');
    out.afterToggle = _scSlots.map(s => s.productId);
    // The last strip out ends the comparison and clears the DOM.
    _scRemoveSlot(_scSlots[0].id);
    out.ended = !_scOn && _scSlots.length === 0;
    out.domCleared = document.getElementById('sc-dividers').innerHTML === ''
      && document.getElementById('sc-labels').innerHTML === '';
    // Restarted, the satellite going off ends it within a tick.
    _scToggle(); _scAddSlot('ch08');
    _disableSatellite();
    await new Promise(r2 => setTimeout(r2, 700));
    out.endedOnLayerOff = !_scOn && _scSlots.length === 0;
    return out;
  });
  ok('a playbar move re-times every strip to its nearest frame',
     r.retimed && r.timeApplied, JSON.stringify(r));
  ok('a strip\'s product, tapped again, takes that strip out',
     JSON.stringify(r.afterToggle) === '["ch13"]', JSON.stringify(r.afterToggle));
  ok('the last strip out ends the comparison and clears the map furniture',
     r.ended && r.domCleared);
  ok('the satellite layer going off ends it too', r.endedOnLayerOff === true);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n4. the rotate button transposes the split, same as radar\'s');
{
  const r = await p.evaluate(async () => {
    _scToggle();
    _scAddSlot('ch08');
    const btn = document.getElementById('sc-rotate-btn');
    const line = () => _scGridDividerEls.cols[0] || _scGridDividerEls.rows[0];
    const before = {
      shown: btn.style.display,
      grid: { ..._scGrid },
      cls: line().className,
      clip: map.getPane('sc-' + _scSlots[0].id).style.clipPath,
    };
    btn.click();
    const after = {
      grid: { ..._scGrid },
      cls: line().className,
      rowSplits: _scRowSplits.slice(),
      clip: map.getPane('sc-' + _scSlots[0].id).style.clipPath,
    };
    btn.click();   // and back
    const back = { grid: { ..._scGrid }, cls: line().className };
    _scOff();
    return { before, after, back };
  });
  ok('side by side to start: a 1x2 double with one vertical line, a rectangle-clipped pane',
     r.before.shown === 'flex' && r.before.grid.rows === 1 && r.before.grid.cols === 2
     && !r.before.cls.includes('horizontal') && !/99999/.test(r.before.clip),
     JSON.stringify(r.before));
  ok('one click transposes it: a stacked 2x1 with one horizontal line at the halfway mark',
     r.after.grid.rows === 2 && r.after.grid.cols === 1
     && r.after.cls.includes('horizontal') && r.after.rowSplits.join(',') === '50'
     && r.after.clip !== r.before.clip,
     JSON.stringify(r.after));
  ok('a second click transposes it straight back',
     r.back.grid.rows === 1 && r.back.grid.cols === 2 && !r.back.cls.includes('horizontal'),
     JSON.stringify(r.back));
}

console.log('\n5. peeking hides the divider, shared with radar compare, cleans up on satellite off');
{
  const r = await p.evaluate(async () => {
    _scToggle();
    _scAddSlot('ch08');
    const btn = document.getElementById('sc-peek-btn');
    const line = () => _scGridDividerEls.cols[0] || _scGridDividerEls.rows[0];
    const before = { shown: btn.style.display, opacity: getComputedStyle(line()).opacity };
    btn.click();
    await new Promise(res => setTimeout(res, 300));
    const during = {
      peeking: document.getElementById('sc-dividers').classList.contains('cmp-peeking'),
      active: btn.classList.contains('active'),
      opacity: getComputedStyle(line()).opacity,
    };
    _scOff();
    const stuckCheck = document.getElementById('sc-dividers').classList.contains('cmp-peeking');
    return { before, during, stuckCheck };
  });
  ok('the peek button appears once a comparison is running, divider fully visible',
     r.before.shown === 'flex' && r.before.opacity === '1', JSON.stringify(r.before));
  ok('clicking it hides the divider and lights the button, same mechanism as radar\'s',
     r.during.peeking && r.during.active && r.during.opacity === '0', JSON.stringify(r.during));
  ok('ending the comparison mid-peek clears the state, nothing left stuck for next time',
     r.stuckCheck === false, String(r.stuckCheck));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n6. the split grows as pictures arrive, the button cycles it, and a real drag moves the shared line');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _scToggle();
    _scAddSlot('ch08');                    // 2 pictures: double
    out.double = { ..._scGrid };
    _scAddSlot('ch13', 'west');            // 3rd picture: grows to quad
    out.quad = { ..._scGrid };
    const btn = document.getElementById('sc-grid-btn');
    out.btnAtQuad = btn.textContent;
    btn.click();                           // quad -> octo
    out.octo = { ..._scGrid, btn: btn.textContent,
                 lines: document.querySelectorAll('#sc-dividers .rc-divider').length };
    window.__noop = 0;
    btn.click();                           // octo -> double: refused, 3 pictures
    out.refusedShrink = _scGrid.rows === 2 && _scGrid.cols === 4;
    return out;
  });
  ok('a second picture is a double, a third grows it to quad',
     r.double.rows === 1 && r.double.cols === 2 && r.quad.rows === 2 && r.quad.cols === 2
     && r.btnAtQuad === 'Quad', JSON.stringify(r));
  ok('the button grows quad to octo: 2x4, four shared lines',
     r.octo.rows === 2 && r.octo.cols === 4 && r.octo.lines === 4 && r.octo.btn === 'Octo',
     JSON.stringify(r.octo));
  ok('and refuses to shrink past what the pictures fit', r.refusedShrink === true);

  // A real mouse drag on the shared column line moves it, and only it.
  const lineBox = await p.evaluate(() => {
    const el = _scGridDividerEls.cols[0];
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height * 0.35 };
  });
  const before = await p.evaluate(() => ({ col: _scColSplits[0], row: _scRowSplits[0] }));
  await p.mouse.move(lineBox.x, lineBox.y);
  await p.mouse.down();
  await p.mouse.move(lineBox.x + 100, lineBox.y, { steps: 5 });
  await p.mouse.up();
  await p.waitForTimeout(100);
  const after = await p.evaluate(() => ({ col: _scColSplits[0], row: _scRowSplits[0] }));
  ok('a real mouse drag moves the shared column line, leaving the row line alone',
     after.col !== before.col && after.row === before.row,
     JSON.stringify({ before, after }));

  await p.evaluate(() => _scOff());
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
