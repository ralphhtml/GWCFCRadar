#!/usr/bin/env node
/*
 * The site popup, and comparing radar sites side by side.
 *
 *     node tools/test-radar-compare.mjs
 *
 * A tap on a radar pill opens a two-line popup above it: View this site, or
 * Compare radar sites. Compare cuts the map into strips the way the model
 * comparison does, strip A being the site already on screen and every later
 * strip another site in the same product from the same source. Driven in a
 * real browser with the network off, so what is checked is the wiring:
 * which layer each strip asks for, where the dividers sit, how the strips
 * follow the playbar, and that everything comes down cleanly.
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
  ok('a pill tap opens the popup, or adds a strip while comparing',
     /label\.on\('click', \(\) => \{\s*if \(typeof _rcOn !== 'undefined' && _rcOn\) \{ _rcAddSite\(s\.id\); return; \}\s*_sitePopOpen\(s\);/.test(PAGE));
  ok('the old load lives on, whole, as _siteView', PAGE.includes('async function _siteView(s) {')
     && /async function _siteView\(s\) \{[\s\S]*?_loadSingleSiteRef\(s\.id\);[\s\S]*?map\.setView\(\[s\.lat, s\.lon\]/.test(PAGE));
  ok('both comparisons share one strip geometry',
     PAGE.includes('function _stripGeometry(leftPct, rightPct, axis)')
     && PAGE.includes('function _cmpLineGeom(axis, pct, rot, size)')
     && PAGE.includes('function _stripPctFromClientX(clientX, splits, idx, axis, clientY)')
     && (PAGE.match(/_stripPctFromClientX\(/g) || []).length >= 3);
  ok('the axis argument is additive: the model and satellite comparisons still call '
     + 'with just three arguments, unaffected by radar compare\'s own axis/clientY calls',
     /_sevSetSplit\(idx, clientX\) \{\s*\n\s*const pct = _stripPctFromClientX\(clientX, _sevSplits, idx\);/.test(PAGE));
  ok('switching the radar off ends the comparison',
     /function _disableRadar\(\) \{[\s\S]*?_rcOff\(\)/.test(PAGE));
  // A switch now, not ten seconds: hidden stays hidden until tapped again.
  ok('a hide button and the shared hide switch exist, and radar off cleans it up',
     PAGE.includes('id="rc-peek-btn"') && PAGE.includes("onclick=\"_cmpPeek('rc')\"")
     && /function _cmpPeek\(prefix, want\) \{/.test(PAGE) && /function _cmpPeekReset\(prefix\) \{/.test(PAGE)
     && /function _rcOff\(\) \{[\s\S]*?_cmpPeekReset\('rc'\)/.test(PAGE));
  ok('the rotate/peek buttons sit clear of the search bar (top:18px, z-index:1150) '
     + 'and the tool rail (top:175px), not the old spot that collided with the search bar',
     /#rc-rotate-btn \{ top: 85px; right: 8px; \}/.test(PAGE)
     && /#sc-rotate-btn \{ top: 123px; right: 8px; \}/.test(PAGE)
     && !/#rc-rotate-btn \{ top: 8px;/.test(PAGE));
  ok('a comparison IS a split: the first added site opens the double, one more than it holds grows it',
     /if \(!_rcGrid\) _rcSetGrid\(1, 2\);/.test(PAGE)
     && /function _rcGridGrow\(\) \{/.test(PAGE)
     && /if \(_rcSlots\.length >= _rcMaxStrips\(\) && !_rcGridGrow\(\)\) \{/.test(PAGE));
  ok('the splits are double, quad and octo, on shared lines with a rectangle-bounded geometry',
     /let _rcGrid = null;/.test(PAGE) && /let _rcColSplits = \[\];/.test(PAGE) && /let _rcRowSplits = \[\];/.test(PAGE)
     && /function _gridGeometry\(leftPct, rightPct, topPct, bottomPct\) \{/.test(PAGE)
     && /function _rcGridCycle\(\) \{/.test(PAGE) && PAGE.includes('id="rc-grid-btn"')
     && /cells === 2 \? \[2, 2\] : cells === 4 \? \[2, 4\] : \[1, 2\];/.test(PAGE));
  ok('cycling to a split too small for the pictures already on screen is refused, not silently trimmed',
     /function _rcSetGrid\(rows, cols\) \{[\s\S]*?if \(_rcSlots\.length > need\) \{[\s\S]{0,200}return false;/.test(PAGE));
  ok('every split line carries the two handles: a drag grip and a rotate, shared by both comparisons',
     /function _cmpLineHandles\(d, line\) \{/.test(PAGE)
     && /cmp-drag-h/.test(PAGE) && /cmp-rot-h/.test(PAGE)
     && /_cmpLineHandles\(d, _cmpLineApi\(\(\) => _rcColRots, i, 'col'/.test(PAGE)
     && /_cmpLineHandles\(d, _cmpLineApi\(\(\) => _scColRots, i, 'col'/.test(PAGE)
     && /d\.title = 'Drag to resize the split';/.test(PAGE));
  ok('the rotate handle turns only its own line, to any angle, and the panes are cut along it',
     /function _cmpWireRotateHandle\(el, line\) \{/.test(PAGE)
     && /function _cmpCellGeometry\(row, col, colSplits, rowSplits, colRots, rowRots\) \{/.test(PAGE)
     && /function _cmpClipHalf\(poly, g, sign\) \{/.test(PAGE));
  ok('rotate transposes the split, so a side-by-side double becomes a stacked one',
     /function _rcToggleOrientation\(\) \{\s*\n\s*if \(!_rcOn \|\| !_rcGrid\) return;\s*\n\s*if \(!_rcSetGrid\(_rcGrid\.cols, _rcGrid\.rows\)\) return;/.test(PAGE));
  ok('the layer stack keeps the strips just above the radar',
     /function _stackApply\(\)\{[\s\S]*?_rcSyncPaneZ/.test(PAGE));
  ok('the playback decoder takes the tilt a strip needs',
     PAGE.includes('function _pbDecode(buffer, layer, extra)')
     // The MRRL noise filter rides along now; the strip's tilt still wins.
     && /options: Object\.assign\(\{ range_limit_km: far[^}]*\}, extra \|\| \{\}\) \}, \[buffer\]\);/.test(PAGE));
  ok('no panel, and no station name in the popup: the map label and the pill say those',
     !PAGE.includes('id="rc-panel"') && !PAGE.includes('site-pop-site')
     && PAGE.includes("x.className = 'rc-x';"));
  ok('a strip is reclipped the moment its own picture actually lands, not just on the next pan/zoom',
     /if \(!slot\.layer\) \{\s*\n\s*slot\.layer = L\.imageOverlay\(url, man\.bounds,[\s\S]{0,600}_rcUpdateClips\(\);\s*\n\s*\} else \{/.test(PAGE)
     && /slot\.layer = L\.imageOverlay\(slot\.blob, img\.leafletBounds,[\s\S]{0,600}_rcUpdateClips\(\);\s*\n\s*_rcRefreshLabels\(\);\s*\n\s*\} catch \(e\) \{/.test(PAGE));
  ok('the rotate button exists, hidden until a comparison is running',
     /<button type="button" id="rc-rotate-btn"[\s\S]{0,120}onclick="_rcToggleOrientation\(\)"[\s\S]{0,40}style="display:none;">/.test(PAGE));
  ok('the horizontal CSS is scoped to radar compare\'s own classes, not the shared .sev-cmp- ones',
     /\.rc-divider\.horizontal \{/.test(PAGE) && /\.rc-divider\.horizontal::before \{/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-radar-compare.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
  // Otherwise the Lite/Expert mode picker sits over the whole map on
  // first load - invisible to every other test here since they all
  // click elements directly rather than at real screen coordinates, but
  // it silently eats a real mouse click aimed at anything underneath it.
  try { localStorage.setItem('gwcfc_mode', 'expert'); } catch (e) {}
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
ok('the page boots clean', errs.length === 0, errs[0]);
// Marking the tutorial seen (above) makes this a "returning visitor" as
// far as the What Changed modal is concerned, so it auto-opens over the
// whole map - invisible to every click in this file since they all call
// .click() on an element directly rather than at a real screen point, but
// section 10 below does the latter, and a real click there would land on
// this instead of the divider handle underneath it. The open attempt
// itself is on a DELAYED timer inside _actuallyDismiss (a couple of
// seconds after the loading screen itself goes), so simply closing it
// once here raced that timer and lost some of the time: marking it seen
// stops the delayed attempt from ever opening it at all, rather than
// trying to out-time it.
await p.evaluate(() => {
  try { if (typeof _clMarkSeen === 'function') _clMarkSeen(); } catch (e) {}
  const m = document.getElementById('changelog-modal');
  if (m) m.classList.remove('open');
});

// Toasts are caught rather than shown, and the map is parked over Oklahoma
// so the pills used below are on screen.
await p.evaluate(() => {
  const real = window.showToast;
  window.__toasts = [];
  window.showToast = (t, ms) => { window.__toasts.push(String(t)); try { return real && real(t, ms); } catch (e) {} };
  map.setView([35.33, -97.28], 6, { animate: false });
  activeLayers.nexrad = true; _radarSource = 'normal'; currentProduct = 'ref';
  showNexradSites();
});

console.log('\n2. a tap on a pill asks, rather than acting');
{
  const r = await p.evaluate(() => {
    _nexradSiteMarkers['ktlx'].label.fire('click');
    const pop = document.getElementById('site-pop');
    const pill = document.getElementById('nxlbl-ktlx').getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    return { open: pop.classList.contains('open'),
             noName: !pop.querySelector('.site-pop-site') && !/KTLX/.test(pop.textContent),
             btns: [...pop.querySelectorAll('.site-pop-btn b')].map(x => x.textContent),
             above: pr.bottom <= pill.top + 1,
             centred: Math.abs((pr.left + pr.width / 2) - (pill.left + pill.width / 2)) < 2,
             ref: _refStation };
  });
  // View Past Radar joined these two (#69).
  ok('the popup opens with its three choices and nothing else',
     r.open && r.noName && r.btns.join('|') === 'View this site|Compare radar sites|View Past Radar', JSON.stringify(r));
  ok('above the pill, centred on it', r.above && r.centred, JSON.stringify(r));
  ok('and nothing has loaded yet', r.ref === null, String(r.ref));

  const v = await p.evaluate(async () => {
    document.querySelector('#site-pop .site-pop-view').click();
    await new Promise(res => setTimeout(res, 300));
    return { closed: !document.getElementById('site-pop').classList.contains('open'),
             ref: _refStation, on: _rcOn };
  });
  ok('View this site loads it, as the tap used to, and closes the popup',
     v.closed && v.ref === 'ktlx' && !v.on, JSON.stringify(v));

  const esc = await p.evaluate(() => {
    _nexradSiteMarkers['kfws'].label.fire('click');
    const was = document.getElementById('site-pop').classList.contains('open');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    return { was, now: document.getElementById('site-pop').classList.contains('open') };
  });
  ok('Escape closes it', esc.was && !esc.now, JSON.stringify(esc));
}

console.log('\n3. Compare radar sites opens the double split');
{
  const r = await p.evaluate(async () => {
    _nexradSiteMarkers['kfws'].label.fire('click');
    document.querySelector('#site-pop .site-pop-compare').click();
    await new Promise(res => setTimeout(res, 400));
    const slot = _rcSlots[0];
    const pane = slot && map.getPane('rc-' + slot.id);
    const rp = map.getPane('radarPane');
    return {
      on: _rcOn, n: _rcSlots.length, site: slot && slot.site, kind: slot && slot.kind,
      grid: { ..._rcGrid },
      layerName: slot && slot.layer && slot.layer.wmsParams && slot.layer.wmsParams.layers,
      time: slot && slot.layer && slot.layer.wmsParams && slot.layer.wmsParams.TIME,
      url: slot && slot.layer && slot.layer._url,
      clip: pane && pane.style.clipPath, z: pane && +pane.style.zIndex,
      radarZ: parseInt(rp.style.zIndex, 10) || parseInt(getComputedStyle(rp).zIndex, 10) || 400,
      dividers: document.querySelectorAll('#rc-dividers .sev-cmp-divider').length,
      labels: [...document.querySelectorAll('#rc-labels .sev-cmp-label')].map(e => e.textContent),
      noPanel: !document.getElementById('rc-panel'),
      x: !!document.querySelector('#rc-labels .rc-label .rc-x'),
      colSplit: _rcColSplits.slice(),
      btnText: document.getElementById('rc-grid-btn').textContent,
      ring: document.getElementById('nxlbl-kfws').classList.contains('in-compare'),
      main: _rcMainSite(),
    };
  });
  ok('compare is on as a DOUBLE split (1x2): KTLX pane A, KFWS pane B',
     r.on && r.n === 1 && r.site === 'kfws' && r.main === 'ktlx'
     && r.grid.rows === 1 && r.grid.cols === 2 && r.btnText === 'Double', JSON.stringify(r));
  ok('pane B draws KFWS reflectivity from the same per-site service, newest scan first',
     r.kind === 'wms' && r.layerName === 'kfws_sr_bref' && !r.time
     && /opengeo\.ncep\.noaa\.gov\/geoserver\/kfws\/ows/.test(r.url || ''),
     JSON.stringify({ k: r.kind, l: r.layerName, t: r.time, u: r.url }));
  ok('in its own clipped rectangular pane just above the radar',
     /^polygon\(/.test(r.clip || '') && !/99999/.test(r.clip || '')
     && r.z > r.radarZ && r.z < r.radarZ + 10,
     JSON.stringify({ clip: r.clip, z: r.z, radarZ: r.radarZ }));
  ok('exactly one shared split line at the halfway mark, and one corner label',
     r.dividers === 1 && r.labels.length === 1 && /^B  KFWS · Reflectivity/.test(r.labels[0])
     && r.colSplit.join(',') === '50',
     JSON.stringify({ d: r.dividers, l: r.labels, s: r.colSplit }));
  ok('no panel: the label on the map carries the ×, and the pill wears the compare ring',
     r.noPanel && r.x && r.ring, JSON.stringify({ noPanel: r.noPanel, x: r.x, ring: r.ring }));
}

console.log('\n4. while comparing, a pill tap adds a pane (growing the split), a second tap takes it out');
{
  const r = await p.evaluate(async () => {
    window.__toasts.length = 0;
    _nexradSiteMarkers['kdyx'].label.fire('click');   // 3rd picture: double grows to quad
    await new Promise(res => setTimeout(res, 200));
    const afterAdd = {
      n: _rcSlots.length, sites: _rcSlots.map(s => s.site), grid: { ..._rcGrid },
      pop: document.getElementById('site-pop').classList.contains('open'),
      dividers: document.querySelectorAll('#rc-dividers .sev-cmp-divider').length,
      letters: [...document.querySelectorAll('#rc-labels .sev-cmp-label')].map(e => e.textContent.slice(0, 1)),
      btnText: document.getElementById('rc-grid-btn').textContent,
    };
    _nexradSiteMarkers['ktlx'].label.fire('click');   // pane A itself
    const aToast = window.__toasts.join(' | ');
    _nexradSiteMarkers['kfws'].label.fire('click');   // already pane B: out it goes
    await new Promise(res => setTimeout(res, 200));
    const afterRemove = {
      n: _rcSlots.length, sites: _rcSlots.map(s => s.site), grid: { ..._rcGrid },
      letters: [...document.querySelectorAll('#rc-labels .sev-cmp-label')].map(e => e.textContent.slice(0, 1)),
      ring: document.getElementById('nxlbl-kfws').classList.contains('in-compare'),
    };
    return { afterAdd, afterRemove, aToast };
  });
  const a = r.afterAdd, d = r.afterRemove;
  ok('a third picture grows the double into a QUAD split, no popup: one column line, one row line',
     a.n === 2 && a.sites.join(',') === 'kfws,kdyx' && !a.pop
     && a.grid.rows === 2 && a.grid.cols === 2 && a.dividers === 2
     && a.letters.join('') === 'BC' && a.btnText === 'Quad', JSON.stringify(a));
  ok('tapping pane A only says so', /already pane A/.test(r.aToast), r.aToast);
  ok('tapping B again removes it, C becomes B, and the split shape stays put',
     d.n === 1 && d.sites.join(',') === 'kdyx' && d.letters.join('') === 'B'
     && d.grid.rows === 2 && d.grid.cols === 2 && !d.ring,
     JSON.stringify(d));
}

console.log('\n4b. the rotate button transposes the split, and back');
{
  const r = await p.evaluate(async () => {
    // Down to a clean double for this section: side by side first.
    _rcGridCycle();   // quad -> octo
    _rcGridCycle();   // octo -> double (1 slot fits)
    const btn = document.getElementById('rc-rotate-btn');
    // The rotate control lives in the Compare tool's menu bar now: live
    // (not greyed out) as soon as a split is running.
    _cmpToolbarRefresh();
    const shownWhileComparing = !document.getElementById('cmp-rotate').disabled;
    const slot = _rcSlots[0];
    const pane = map.getPane('rc-' + slot.id);
    const before = {
      grid: { ..._rcGrid },
      cols: document.querySelectorAll('#rc-dividers .rc-divider:not(.horizontal)').length,
      rows: document.querySelectorAll('#rc-dividers .rc-divider.horizontal').length,
      clip: pane.style.clipPath,
    };
    btn.click();
    await new Promise(res => setTimeout(res, 50));
    const after = {
      grid: { ..._rcGrid },
      cols: document.querySelectorAll('#rc-dividers .rc-divider:not(.horizontal)').length,
      rows: document.querySelectorAll('#rc-dividers .rc-divider.horizontal').length,
      clip: pane.style.clipPath,
      colSplits: _rcColSplits.slice(), rowSplits: _rcRowSplits.slice(),
    };
    btn.click();   // back to side by side, for the tests after this one
    await new Promise(res => setTimeout(res, 50));
    const restored = { grid: { ..._rcGrid } };
    // A synthetic .click() with no pointer events at all - the screen
    // reader / keyboard-activation path - still rotates.
    const line = _rcGridDividerEls.cols[0];
    line.querySelector('.cmp-rot-h').click();
    const viaHandle = { grid: { ..._rcGrid }, rot: _rcColRots[0] };
    document.getElementById('rc-rotate-btn').click();   // back again
    await new Promise(res => setTimeout(res, 50));
    return { shownWhileComparing, before, after, restored, viaHandle };
  });
  ok('the rotate control in the Compare menu is live once a comparison is running',
     r.shownWhileComparing, JSON.stringify(r.shownWhileComparing));
  ok('side by side to start: a 1x2 with one vertical line',
     r.before.grid.rows === 1 && r.before.grid.cols === 2
     && r.before.cols === 1 && r.before.rows === 0, JSON.stringify(r.before));
  ok('one click transposes it: a stacked 2x1 with one horizontal line at the halfway mark',
     r.after.grid.rows === 2 && r.after.grid.cols === 1
     && r.after.cols === 0 && r.after.rows === 1
     && r.after.rowSplits.join(',') === '50' && r.after.colSplits.length === 0,
     JSON.stringify(r.after));
  ok('a second click transposes it straight back',
     r.restored.grid.rows === 1 && r.restored.grid.cols === 2, JSON.stringify(r.restored));
  ok('a synthetic click on the handle (no pointer events) turns just that line a quarter, the split stays',
     r.viaHandle.grid.rows === 1 && r.viaHandle.grid.cols === 2 && r.viaHandle.rot === 90, JSON.stringify(r.viaHandle));
  // The evaluate above already restored double (the "back again" click
  // right after viaHandle), so nothing further is needed here.
}

console.log('\n4c. the rotate handle turns only its own line, to the angle you drag it to');
{
  // A quad, so there is a second line that must NOT turn.
  await p.evaluate(() => { _rcSetGrid(2, 2); _rcRefreshDOM(); _rcUpdateClips(); });
  await p.waitForTimeout(50);
  // Drag the handle round the line's pivot to `deg` degrees past straight.
  const turn = async (deg, release = true) => {
    const g = await p.evaluate(() => {
      const h = document.querySelector('#rc-dividers .rc-divider:not(.horizontal) .cmp-rot-h').getBoundingClientRect();
      const piv = _cmpLineApi(() => _rcColRots, 0, 'col', () => _rcColSplits, () => {}).pivot();
      return { hx: h.left + h.width / 2, hy: h.top + h.height / 2, px: piv.x, py: piv.y };
    });
    const r0 = Math.hypot(g.hx - g.px, g.hy - g.py);
    const a0 = Math.atan2(g.hy - g.py, g.hx - g.px);
    await p.mouse.move(g.hx, g.hy);
    await p.mouse.down();
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const a = a0 + (deg * Math.PI / 180) * (i / steps);
      await p.mouse.move(g.px + Math.cos(a) * r0, g.py + Math.sin(a) * r0);
    }
    const mid = await p.evaluate(() => ({ rot: _rcColRots[0],
      transform: _rcGridDividerEls.cols[0].style.transform }));
    if (release) await p.mouse.up();
    await p.waitForTimeout(40);
    return mid;
  };
  const state = () => p.evaluate(() => ({
    grid: { ..._rcGrid }, colRots: _rcColRots.slice(), rowRots: _rcRowRots.slice(),
    rowTransform: _rcGridDividerEls.rows[0].style.transform,
    clip: map.getPane(_rcPaneName(_rcSlots[0])).style.clipPath,
    dragStarted: _rcGridDrag !== null,
  }));
  const mid = await turn(30);
  const after30 = await state();
  await turn(13);          // 30 + 13 = 43, within the snap of 45
  const after43 = await state();
  // A tap (no movement) turns it a further quarter.
  const hc = await p.evaluate(() => {
    const h = document.querySelector('#rc-dividers .rc-divider:not(.horizontal) .cmp-rot-h').getBoundingClientRect();
    return { x: h.left + h.width / 2, y: h.top + h.height / 2 };
  });
  await p.mouse.move(hc.x, hc.y); await p.mouse.down(); await p.mouse.up();
  await p.waitForTimeout(40);
  const afterTap = await state();
  await p.evaluate(() => { _rcSetGrid(1, 2); _rcRefreshDOM(); _rcUpdateClips(); });

  const pts = (after30.clip.match(/px/g) || []).length / 2;
  ok('the line follows the drag while held, and the line itself turns on screen',
     Math.abs(mid.rot - 30) < 3 && /rotate\(/.test(mid.transform), JSON.stringify(mid));
  ok('let go, it stays at that angle: no snap back, and the split is still a quad',
     Math.abs(after30.colRots[0] - 30) < 3 && after30.grid.rows === 2 && after30.grid.cols === 2,
     JSON.stringify(after30));
  ok('only that line turned: the other line did not move', after30.rowRots[0] === 0 && after30.rowTransform === '',
     JSON.stringify(after30));
  ok('the picture beside it is cut along the angled line, not a rectangle',
     /^polygon\(/.test(after30.clip) && !/-99999px/.test(after30.clip), after30.clip.slice(0, 120));
  ok('near a diagonal it snaps onto 45 degrees', after43.colRots[0] === 45, JSON.stringify(after43.colRots));
  ok('a tap turns it a further quarter', afterTap.colRots[0] === 135, JSON.stringify(afterTap.colRots));
  ok('turning never started a resize drag of the line', !after30.dragStarted && !afterTap.dragStarted);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n5. the split line follows the pointer, and stays put when the map is dragged');
{
  const r = await p.evaluate(async () => {
    const rect = document.getElementById('map').getBoundingClientRect();
    const drag = (x) => { _rcGridDrag = { axis: 'col', idx: 0 }; _rcSetGridSplit(x, 300); _rcGridDrag = null; };
    drag(rect.left + rect.width * 0.7);
    const dv = _rcGridDividerEls.cols[0];
    const at70 = { pct: _rcColSplits[0], left: parseFloat(dv.style.left), want: rect.width * 0.7 };
    drag(rect.left + rect.width * 0.01);   // past the edge: clamped
    const clamped = _rcColSplits[0];
    drag(rect.left + rect.width * 0.7);
    map.panBy([150, 0], { animate: false });
    await new Promise(res => setTimeout(res, 100));
    const pos = L.DomUtil.getPosition(map._mapPane);
    const pane = map.getPane('rc-' + _rcSlots[0].id);
    const m = /polygon\((-?[\d.]+)px/.exec(pane.style.clipPath);
    return { at70, clamped,
             afterPan: { left: parseFloat(dv.style.left), posX: pos.x,
                         clipLeft: m && parseFloat(m[1]), want: rect.width * 0.7 } };
  });
  ok('dragging to 70% puts the split line at 70%',
     Math.abs(r.at70.pct - 70) < 0.6 && Math.abs(r.at70.left - r.at70.want) < 2, JSON.stringify(r.at70));
  ok('and it cannot be dragged off the map', r.clamped === 4, String(r.clamped));
  ok('after a pan the line stays at 70% of the view while the clip subtracts the slide',
     Math.abs(r.afterPan.left - r.afterPan.want) < 2 && r.afterPan.posX !== 0
     && Math.abs(r.afterPan.clipLeft - (r.afterPan.want - r.afterPan.posX)) < 2, JSON.stringify(r.afterPan));
}

console.log('\n6. strips follow the playbar, and switch product with strip A');
{
  const r = await p.evaluate(() => {
    const slot = _rcSlots[0];
    const T = m => Date.UTC(2026, 8, 12, 12, m);
    const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
    slot.frames = [0, 5, 10, 15].map(m => ({ iso: iso(T(m)), time: T(m) / 1000 }));
    _refSiteFrames = [{ time: T(4) / 1000, iso: iso(T(4)) }, { time: T(11) / 1000, iso: iso(T(11)) }];
    currentFrame = 1; _rcTimeMs = 0;
    _rcTickFn();
    const first = slot.layer.wmsParams.TIME;
    currentFrame = 0;
    _rcTickFn();
    return { first, second: slot.layer.wmsParams.TIME, label: slot.labelEl.textContent };
  });
  ok('the strip picks its own scan nearest the frame on the bar',
     r.first === '2026-09-12T12:10:00Z' && r.second === '2026-09-12T12:05:00Z', JSON.stringify(r));
  ok('and its label says when', /KDYX · Reflectivity · \d\d:\d\d/.test(r.label), r.label);

  const m = await p.evaluate(async () => {
    currentProduct = 'vel'; _velStation = 'ktlx'; velFrames = []; velCurrentFrame = 0;
    _rcTickFn();
    await new Promise(res => setTimeout(res, 200));
    const slot = _rcSlots[0];
    return { kind: slot.kind, layer: slot.layer && slot.layer.wmsParams.layers,
             label: slot.labelEl.textContent };
  });
  ok('switching strip A to velocity redraws every strip as velocity',
     m.kind === 'wms' && m.layer === 'kdyx_sr_bvel' && /KDYX · Velocity/.test(m.label),
     JSON.stringify(m));

  // The other sources, as plans only: the network is off, so what is
  // checked is which file each strip would go and decode.
  const plans = await p.evaluate(() => {
    const out = {};
    _radarSource = 'l2'; currentProduct = 'cc'; _l2Site = 'ktlx';
    out.l2 = _rcPlan('kdyx');
    _radarSource = 'l3'; _prOn = true; _prBucketSite = 'KTLX'; _prProduct = 'reflectivity'; _prTilt = 2; _prIndex = null;
    out.l3 = _rcPlan('kdyx');
    out.tdwr = _rcPlan('tdal');
    _prProduct = 'corrcoeff';
    out.cant = _rcPlan('tdal');
    // back to where the rest of the suite expects things
    _prProduct = 'reflectivity'; _prTilt = 1; _prOn = false; _prBucketSite = null;
    _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'ktlx';
    return out;
  });
  ok('in Level 2 a strip decodes that site\'s volume for the same product',
     plans.l2.kind === 'mesh-l2' && plans.l2.product === 'cc', JSON.stringify(plans.l2));
  ok('in Level 3 a strip decodes the bucket at the same tilt',
     plans.l3.kind === 'mesh-l3' && plans.l3.code === 'N1B', JSON.stringify(plans.l3));
  ok('a terminal radar speaks its own dialect', plans.tdwr.kind === 'mesh-l3' && plans.tdwr.code === 'TZ1', JSON.stringify(plans.tdwr));
  ok('and a product it cannot make is refused with a reason',
     plans.cant.kind === 'none' && /TDAL does not publish Corr/.test(plans.cant.why), JSON.stringify(plans.cant));
}

console.log('\n7. ending the comparison, from the last label\'s × and from the radar switch');
{
  const r = await p.evaluate(async () => {
    _rcTickFn();                       // settle back onto reflectivity
    await new Promise(res => setTimeout(res, 100));
    const paneId = 'rc-' + _rcSlots[0].id;
    window.__toasts.length = 0;
    document.querySelector('#rc-labels .rc-label .rc-x').click();
    const off = { on: _rcOn, n: _rcSlots.length,
                  dividers: document.querySelectorAll('#rc-dividers *').length,
                  labels: document.querySelectorAll('#rc-labels *').length,
                  layers: map.getPane(paneId).children.length,
                  ring: document.getElementById('nxlbl-kdyx').classList.contains('in-compare'),
                  toasts: window.__toasts.join(' | ') };
    _nexradSiteMarkers['kfws'].label.fire('click');
    document.querySelector('#site-pop .site-pop-compare').click();
    await new Promise(res => setTimeout(res, 200));
    const again = { on: _rcOn, n: _rcSlots.length };
    _disableRadar();
    const after = { on: _rcOn, n: _rcSlots.length,
                    labels: document.querySelectorAll('#rc-labels *').length };
    return { off, again, after };
  });
  ok('the × on the last strip takes the strip, divider and ring down and ends the comparison',
     !r.off.on && r.off.n === 0 && r.off.dividers === 0 && r.off.labels === 0 && r.off.layers === 0 && !r.off.ring
     && /Radar compare ended/.test(r.off.toasts), JSON.stringify(r.off));
  ok('it comes back on demand', r.again.on && r.again.n === 1, JSON.stringify(r.again));
  ok('and switching the radar off ends it too', !r.after.on && r.after.n === 0 && r.after.labels === 0, JSON.stringify(r.after));
}

console.log('\n8. with nothing on screen yet, Compare makes the tapped site strip A');
{
  const r = await p.evaluate(async () => {
    activeLayers.nexrad = true; _radarSource = 'normal'; currentProduct = 'ref';
    _clearSingleSiteRef();
    showNexradSites();
    window.__toasts.length = 0;
    _nexradSiteMarkers['kama'].label.fire('click');
    document.querySelector('#site-pop .site-pop-compare').click();
    await new Promise(res => setTimeout(res, 300));
    const out = { on: _rcOn, n: _rcSlots.length, main: _rcMainSite(), ref: _refStation,
                  toasts: window.__toasts.join(' | ') };
    _rcOff();
    return out;
  });
  ok('KAMA loads as strip A and the comparison waits for a second pill',
     r.on && r.n === 0 && r.main === 'kama' && r.ref === 'kama' && /Tap another radar pill/.test(r.toasts),
     JSON.stringify(r));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n9. peeking hides the divider for ten seconds, and cleans up if compare ends mid-peek');
{
  const r = await p.evaluate(async () => {
    // A station must already be on screen for this tap to add a real
    // comparison SLOT rather than adopting kfws itself as strip A (that
    // no-station case is section 8's own scenario, not this one's).
    if (!_refStation) { _loadSingleSiteRef('ktlx'); }
    _nexradSiteMarkers['kfws'].label.fire('click');
    document.querySelector('#site-pop .site-pop-compare').click();
    await new Promise(res => setTimeout(res, 300));
    const btn = document.getElementById('rc-peek-btn');
    const line = () => _rcGridDividerEls.cols[0] || _rcGridDividerEls.rows[0];
    const before = { shown: btn.style.display, opacity: getComputedStyle(line()).opacity };
    btn.click();
    await new Promise(res => setTimeout(res, 300));   // the CSS fade takes 0.2s
    const during = {
      peeking: document.getElementById('rc-dividers').classList.contains('cmp-peeking'),
      active: btn.classList.contains('active'),
      opacity: getComputedStyle(line()).opacity,
    };
    // Ending the comparison mid-peek must not leave the NEXT one stuck invisible.
    _rcOff();
    const stuckCheck = document.getElementById('rc-dividers').classList.contains('cmp-peeking');
    _nexradSiteMarkers['kfws'].label.fire('click');
    document.querySelector('#site-pop .site-pop-compare').click();
    await new Promise(res => setTimeout(res, 300));
    const after = { opacity: getComputedStyle(line()).opacity,
                     shown: document.getElementById('rc-peek-btn').style.display };
    _rcOff();
    return { before, during, stuckCheck, after };
  });
  ok('the peek button appears the moment a comparison is running, split line fully visible',
     r.before.shown === 'flex' && r.before.opacity === '1', JSON.stringify(r.before));
  ok('clicking it hides the split line and lights the button',
     r.during.peeking && r.during.active && r.during.opacity === '0', JSON.stringify(r.during));
  ok('ending the comparison mid-peek clears the peeking state, nothing left stuck',
     r.stuckCheck === false, String(r.stuckCheck));
  ok('a brand new comparison afterward starts fully visible, not stuck invisible from before',
     r.after.opacity === '1' && r.after.shown === 'flex', JSON.stringify(r.after));
}

console.log('\n10. the split grows as pictures arrive: double, quad, octo, then genuinely full');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _loadSingleSiteRef('ktlx');
    _rcOn = true;
    // Eight distinct real stations straight off the site list, so the
    // ladder below can climb to a full octo and then one past it.
    const ids = NEXRAD_STATIONS.filter(s => s.id !== 'ktlx').slice(0, 8).map(s => s.id);
    out.ladder = [];
    for (let i = 0; i < 7; i++) {
      _rcAddSite(ids[i]);
      out.ladder.push({ slots: _rcSlots.length, cells: _rcGrid.rows * _rcGrid.cols });
    }
    window.__toasts.length = 0;
    _rcAddSite(ids[7]);   // a ninth picture: refused
    out.ninthRefused = _rcSlots.length === 7 && window.__toasts.some(t => /octo split.*most it can hold/.test(t));
    out.btnText = document.getElementById('rc-grid-btn').textContent;
    out.octoLines = document.querySelectorAll('#rc-dividers .rc-divider').length;
    const clips = _rcSlots.map(s => map.getPane('rc-' + s.id).style.clipPath);
    out.allBounded = clips.every(c => !/99999/.test(c) && /^polygon\(/.test(c));
    _rcOff();
    return out;
  });
  ok('one picture is a double, a third grows it to quad, a fifth to octo, never dropping anything',
     r.ladder.map(x => x.cells).join(',') === '2,4,4,8,8,8,8'
     && r.ladder.map(x => x.slots).join(',') === '1,2,3,4,5,6,7',
     JSON.stringify(r.ladder));
  ok('a ninth picture is refused with the octo message', r.ninthRefused === true);
  ok('a full octo is 2x4: three column lines plus one row line, every cell a real rectangle',
     r.btnText === 'Octo' && r.octoLines === 4 && r.allBounded === true,
     JSON.stringify({ btn: r.btnText, lines: r.octoLines, bounded: r.allBounded }));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n11. the split button cycles double, quad, octo, refusing any size the pictures no longer fit');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _loadSingleSiteRef('ktlx');
    _rcOn = true;
    ['kfws', 'kdyx', 'kama'].forEach(id => _rcAddSite(id));   // 4 pictures: a quad
    await new Promise(res => setTimeout(res, 300));
    out.start = { ..._rcGrid };
    const btn = document.getElementById('rc-grid-btn');
    btn.click();   // quad -> octo
    out.afterFirst = { grid: { ..._rcGrid }, btn: btn.textContent,
                       lines: document.querySelectorAll('#rc-dividers .rc-divider').length };
    window.__toasts.length = 0;
    btn.click();   // octo -> double: refused, four pictures do not fit two cells
    out.refused = { grid: { ..._rcGrid }, toast: window.__toasts.some(t => /only holds 2 pictures/.test(t)) };
    // Down to one picture and the full cycle opens up again.
    while (_rcSlots.length > 1) _rcRemoveSlot(_rcSlots[_rcSlots.length - 1].id);
    btn.click();   // octo -> double
    out.backToDouble = { grid: { ..._rcGrid }, btn: btn.textContent };
    _rcOff();
    return out;
  });
  ok('four pictures arrive as a quad', r.start.rows === 2 && r.start.cols === 2, JSON.stringify(r.start));
  ok('one click grows it to octo: 2x4, four shared lines, the button saying so',
     r.afterFirst.grid.rows === 2 && r.afterFirst.grid.cols === 4
     && r.afterFirst.lines === 4 && r.afterFirst.btn === 'Octo', JSON.stringify(r.afterFirst));
  ok('cycling on to double is refused while four pictures are up, nothing dropped',
     r.refused.grid.rows === 2 && r.refused.grid.cols === 4 && r.refused.toast, JSON.stringify(r.refused));
  ok('with one picture left the cycle reaches double again',
     r.backToDouble.grid.rows === 1 && r.backToDouble.grid.cols === 2 && r.backToDouble.btn === 'Double',
     JSON.stringify(r.backToDouble));
}

console.log('\n12. shared lines move every cell they touch');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _loadSingleSiteRef('ktlx');
    _rcOn = true;
    ['kfws', 'kdyx', 'kama'].forEach(id => _rcAddSite(id));   // a quad
    out.gridBuilt = { ..._rcGrid };
    const rowSplitBefore = _rcRowSplits[0];
    const clipsBefore = _rcSlots.map(s => map.getPane('rc-' + s.id).style.clipPath);

    _rcGridDrag = { axis: 'col', idx: 0 };
    _rcSetGridSplit(500, 400);
    out.colSplitAfter = _rcColSplits[0];
    out.rowSplitUnchangedByColumnDrag = _rcRowSplits[0] === rowSplitBefore;
    const clipsAfter = _rcSlots.map(s => map.getPane('rc-' + s.id).style.clipPath);
    out.everyCellReclipped = clipsBefore.every((c, i) => c !== clipsAfter[i]);
    _rcGridDrag = null;

    _rcOff();
    return out;
  });
  ok('four pictures build the quad', r.gridBuilt.rows === 2 && r.gridBuilt.cols === 2, JSON.stringify(r.gridBuilt));
  ok('dragging the shared column line reclips every cell, and leaves the row line untouched',
     r.colSplitAfter !== undefined && r.rowSplitUnchangedByColumnDrag && r.everyCellReclipped,
     JSON.stringify(r));
}

console.log('\n13. a pane can pick its OWN product, and its own Level 2/Level 3 source');
{
  ok('the plan takes the pane, and the pane carries its choices',
     /function _rcPlan\(site, slot\) \{/.test(PAGE)
     && /prodSel: null, srcSel: null/.test(PAGE)
     && /const plan = _rcPlan\(slot\.site, slot\);/.test(PAGE));
  ok('the label wears a ≡ that opens the picker, and compare-off closes it',
     /className = 'rc-gear';/.test(PAGE)
     && /function _rcCfgOpen\(slot, labelEl\) \{/.test(PAGE)
     && /function _rcOff\(\) \{[\s\S]*?_rcCfgClose\(\);/.test(PAGE));
  const r = await p.evaluate(async () => {
    const out = {};
    _loadSingleSiteRef('ktlx');
    _rcOn = true;
    _rcAddSite('kfws');
    await new Promise(res => setTimeout(res, 200));
    const slot = _rcSlots[0];
    // Its own product on the standard per-site service.
    slot.prodSel = 'vel';
    out.velPlan = _rcPlan(slot.site, slot);
    // Its own source: the same product as Level 2.
    slot.srcSel = 'l2';
    _rcRenderSlot(slot);
    out.l2Plan = { ...slot.plan };
    // Level 3 with a dual-pol product resolves to a real bucket code.
    slot.prodSel = 'cc'; slot.srcSel = 'l3';
    out.l3Plan = _rcPlan(slot.site, slot);
    // The label says what the pane chose, not what pane A shows.
    _rcRenderSlot(slot);
    _rcRefreshLabels();
    out.label = slot.labelEl.querySelector('.rc-label-text').textContent;
    // Same as A hands the choice back to the globals.
    slot.prodSel = null; slot.srcSel = null;
    out.followPlan = _rcPlan(slot.site, slot);
    // The picker itself: the ≡ opens it beside the label, a choice
    // applies to this pane and closes it.
    slot.labelEl.querySelector('.rc-gear').click();
    const box = document.getElementById('rc-slot-cfg');
    out.boxOpen = !!box;
    out.rows = box ? box.querySelectorAll('.rc-cfg-row').length : 0;
    const velBtn = box && [...box.querySelectorAll('button')].find(b => b.textContent === 'Vel');
    if (velBtn) velBtn.click();
    out.picked = slot.prodSel;
    out.boxClosed = !document.getElementById('rc-slot-cfg');
    out.labelAfterPick = slot.labelEl.querySelector('.rc-label-text').textContent;
    _rcOff();
    return out;
  });
  ok('a pane set to velocity plans the velocity layer of ITS site',
     r.velPlan.kind === 'wms' && r.velPlan.layer === 'kfws_sr_bvel', JSON.stringify(r.velPlan));
  ok('a pane set to Level 2 plans the Level 2 decode of that product',
     r.l2Plan.kind === 'mesh-l2' && r.l2Plan.product === 'vel', JSON.stringify(r.l2Plan));
  ok('a pane set to Level 3 CC resolves the real bucket code',
     r.l3Plan.kind === 'mesh-l3' && r.l3Plan.code === 'N0C', JSON.stringify(r.l3Plan));
  ok('its label says what it chose: the product and the source',
     /KFWS · Corr\. Coeff\. · L3/.test(r.label), r.label);
  ok('Same as A hands the pane back to the main picture\'s own switches',
     r.followPlan.kind === 'wms' && r.followPlan.layer === 'kfws_sr_bref', JSON.stringify(r.followPlan));
  ok('the ≡ opens a two-row picker, and picking Vel applies it and closes',
     r.boxOpen && r.rows === 2 && r.picked === 'vel' && r.boxClosed
     && /KFWS · Velocity/.test(r.labelAfterPick),
     JSON.stringify({ open: r.boxOpen, rows: r.rows, picked: r.picked, closed: r.boxClosed, label: r.labelAfterPick }));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n14. a corner label slides out from under the page furniture instead of hiding');
{
  ok('the dodge is shared and checks the real on-screen rectangles',
     /const _CMP_LABEL_BLOCKERS = \['logo-wrap', 'top-search-bar', 'load-status', 'lqm-profile-btn'\];/.test(PAGE)
     && /function _cmpDodgeLabel\(el\) \{/.test(PAGE)
     && (PAGE.match(/_cmpDodgeLabel\(slot\.labelEl\);/g) || []).length === 2);
  const r = await p.evaluate(async () => {
    const out = {};
    _loadSingleSiteRef('ktlx');
    _rcOn = true;
    _rcAddSite('kfws');
    await new Promise(res => setTimeout(res, 200));
    const label = _rcSlots[0].labelEl;
    // Park the status banner exactly where this label stands, the way the
    // logo covered a real pane label: the label must step below it.
    _rcUpdateClips();
    const lr = label.getBoundingClientRect();
    const banner = document.getElementById('load-status');
    const oldCss = banner.style.cssText;
    banner.style.cssText = `display:block;position:fixed;left:${lr.left - 10}px;`
      + `top:${lr.top - 10}px;width:${lr.width + 40}px;height:40px;z-index:1;`;
    const br = banner.getBoundingClientRect();
    _rcUpdateClips();
    const after = label.getBoundingClientRect();
    out.movedBelow = after.top >= br.bottom;
    out.stillOverlapsX = after.left < br.right && after.right > br.left;
    banner.style.cssText = oldCss;
    _rcUpdateClips();
    const restored = label.getBoundingClientRect();
    out.backToCorner = Math.abs(restored.top - lr.top) < 2;
    _rcOff();
    return out;
  });
  ok('a label covered by a floating element steps below it, same column',
     r.movedBelow && r.stillOverlapsX, JSON.stringify(r));
  ok('and returns to its corner once nothing covers it', r.backToCorner === true);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
