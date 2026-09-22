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
     && (PAGE.match(/_stripGeometry\(/g) || []).length >= 3
     && PAGE.includes('function _stripPctFromClientX(clientX, splits, idx, axis, clientY)')
     && (PAGE.match(/_stripPctFromClientX\(/g) || []).length >= 3);
  ok('the axis argument is additive: the model and satellite comparisons still call '
     + 'with just three arguments, unaffected by radar compare\'s own axis/clientY calls',
     /_sevSetSplit\(idx, clientX\) \{\s*\n\s*const pct = _stripPctFromClientX\(clientX, _sevSplits, idx\);/.test(PAGE));
  ok('switching the radar off ends the comparison',
     /function _disableRadar\(\) \{[\s\S]*?_rcOff\(\)/.test(PAGE));
  ok('the layer stack keeps the strips just above the radar',
     /function _stackApply\(\)\{[\s\S]*?_rcSyncPaneZ/.test(PAGE));
  ok('the playback decoder takes the tilt a strip needs',
     PAGE.includes('function _pbDecode(buffer, layer, extra)')
     && PAGE.includes("options: Object.assign({ range_limit_km: far }, extra || {}) }, [buffer]);"));
  ok('no panel, and no station name in the popup: the map label and the pill say those',
     !PAGE.includes('id="rc-panel"') && !PAGE.includes('site-pop-site')
     && PAGE.includes("x.className = 'rc-x';"));
  ok('a strip is reclipped the moment its own picture actually lands, not just on the next pan/zoom',
     /if \(!slot\.layer\) \{\s*\n\s*slot\.layer = L\.imageOverlay\(url, man\.bounds,[\s\S]{0,600}_rcUpdateClips\(\);\s*\n\s*\} else \{/.test(PAGE)
     && /slot\.layer = L\.imageOverlay\(slot\.blob, img\.leafletBounds,[\s\S]{0,600}_rcUpdateClips\(\);\s*\n\s*_rcRefreshLabels\(\);\s*\n\s*\} catch \(e\) \{/.test(PAGE));
  ok('the rotate button exists, hidden until a comparison is running',
     /<button type="button" id="rc-rotate-btn"[\s\S]{0,120}onclick="_rcToggleOrientation\(\)"[\s\S]{0,40}style="display:none;">/.test(PAGE));
  ok('toggling orientation flips the state and re-renders, without touching whether compare is even on',
     /function _rcToggleOrientation\(\) \{\s*\n\s*if \(!_rcOn\) return;\s*\n\s*_rcOrientation = _rcOrientation === 'h' \? 'v' : 'h';\s*\n\s*_rcRefreshDOM\(\);\s*\n\s*_rcUpdateClips\(\);/.test(PAGE));
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
  ok('the popup opens with the two choices and nothing else',
     r.open && r.noName && r.btns.join('|') === 'View this site|Compare radar sites', JSON.stringify(r));
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

console.log('\n3. Compare radar sites cuts the map into strips');
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
      layerName: slot && slot.layer && slot.layer.wmsParams && slot.layer.wmsParams.layers,
      time: slot && slot.layer && slot.layer.wmsParams && slot.layer.wmsParams.TIME,
      url: slot && slot.layer && slot.layer._url,
      clip: pane && pane.style.clipPath, z: pane && +pane.style.zIndex,
      radarZ: parseInt(rp.style.zIndex, 10) || parseInt(getComputedStyle(rp).zIndex, 10) || 400,
      dividers: document.querySelectorAll('#rc-dividers .sev-cmp-divider').length,
      labels: [...document.querySelectorAll('#rc-labels .sev-cmp-label')].map(e => e.textContent),
      noPanel: !document.getElementById('rc-panel'),
      x: !!document.querySelector('#rc-labels .rc-label .rc-x'),
      split: _rcSplits.slice(),
      ring: document.getElementById('nxlbl-kfws').classList.contains('in-compare'),
      main: _rcMainSite(),
    };
  });
  ok('compare is on with KTLX as strip A and KFWS as strip B',
     r.on && r.n === 1 && r.site === 'kfws' && r.main === 'ktlx', JSON.stringify(r));
  ok('strip B draws KFWS reflectivity from the same per-site service, newest scan first',
     r.kind === 'wms' && r.layerName === 'kfws_sr_bref' && !r.time
     && /opengeo\.ncep\.noaa\.gov\/geoserver\/kfws\/ows/.test(r.url || ''),
     JSON.stringify({ k: r.kind, l: r.layerName, t: r.time, u: r.url }));
  ok('in its own clipped pane just above the radar',
     /^polygon\(/.test(r.clip || '') && r.z > r.radarZ && r.z < r.radarZ + 10,
     JSON.stringify({ clip: r.clip, z: r.z, radarZ: r.radarZ }));
  ok('one divider and one label, at the halfway split',
     r.dividers === 1 && r.labels.length === 1 && /^B  KFWS · Reflectivity/.test(r.labels[0]) && r.split[0] === 50,
     JSON.stringify({ d: r.dividers, l: r.labels, s: r.split }));
  ok('no panel: the label on the map carries the ×, and the pill wears the compare ring',
     r.noPanel && r.x && r.ring, JSON.stringify({ noPanel: r.noPanel, x: r.x, ring: r.ring }));
}

console.log('\n4. while comparing, a pill tap adds a strip, and a second tap takes it out');
{
  const r = await p.evaluate(async () => {
    window.__toasts.length = 0;
    _nexradSiteMarkers['kdyx'].label.fire('click');
    await new Promise(res => setTimeout(res, 200));
    const afterAdd = {
      n: _rcSlots.length, sites: _rcSlots.map(s => s.site), splits: _rcSplits.slice(),
      pop: document.getElementById('site-pop').classList.contains('open'),
      dividers: document.querySelectorAll('#rc-dividers .sev-cmp-divider').length,
      letters: [...document.querySelectorAll('#rc-labels .sev-cmp-label')].map(e => e.textContent.slice(0, 1)),
    };
    _nexradSiteMarkers['ktlx'].label.fire('click');   // strip A itself
    const aToast = window.__toasts.join(' | ');
    _nexradSiteMarkers['kfws'].label.fire('click');   // already strip B: out it goes
    await new Promise(res => setTimeout(res, 200));
    const afterRemove = {
      n: _rcSlots.length, sites: _rcSlots.map(s => s.site), splits: _rcSplits.slice(),
      letters: [...document.querySelectorAll('#rc-labels .sev-cmp-label')].map(e => e.textContent.slice(0, 1)),
      ring: document.getElementById('nxlbl-kfws').classList.contains('in-compare'),
    };
    return { afterAdd, afterRemove, aToast };
  });
  const a = r.afterAdd, d = r.afterRemove;
  ok('KDYX becomes strip C with no popup, thirds all round',
     a.n === 2 && a.sites.join(',') === 'kfws,kdyx' && !a.pop && a.dividers === 2
     && a.splits.join(',') === '33.33,66.67' && a.letters.join('') === 'BC', JSON.stringify(a));
  ok('tapping strip A only says so', /already strip A/.test(r.aToast), r.aToast);
  ok('tapping B again removes it, and C becomes B',
     d.n === 1 && d.sites.join(',') === 'kdyx' && d.letters.join('') === 'B' && d.splits.join(',') === '50' && !d.ring,
     JSON.stringify(d));
}

console.log('\n4b. the rotate button flips side-by-side to stacked, and back');
{
  const r = await p.evaluate(async () => {
    const btn = document.getElementById('rc-rotate-btn');
    const shownWhileComparing = getComputedStyle(btn).display !== 'none';
    const slot = _rcSlots[0];
    const pane = map.getPane('rc-' + slot.id);
    const before = {
      orientation: _rcOrientation,
      dividerClass: slot.dividerEl.className,
      dividerLeft: slot.dividerEl.style.left,
      dividerTop: slot.dividerEl.style.top,
      clip: pane.style.clipPath,
    };
    btn.click();
    await new Promise(res => setTimeout(res, 50));
    const after = {
      orientation: _rcOrientation,
      dividerClass: slot.dividerEl.className,
      dividerLeft: slot.dividerEl.style.left,
      dividerTop: slot.dividerEl.style.top,
      clip: pane.style.clipPath,
      split: _rcSplits.slice(),
    };
    btn.click();   // back to vertical, for the tests after this one
    await new Promise(res => setTimeout(res, 50));
    const restored = { orientation: _rcOrientation, dividerClass: slot.dividerEl.className };
    return { shownWhileComparing, before, after, restored };
  });
  ok('the rotate button is on screen once a comparison is running',
     r.shownWhileComparing, JSON.stringify(r.shownWhileComparing));
  ok('vertical to start: a left-positioned divider, an x-clipped pane',
     r.before.orientation === 'v' && !r.before.dividerClass.includes('horizontal')
     && r.before.dividerLeft && !r.before.dividerTop
     && /^polygon\(-?[\d.]+px -99999px,/.test(r.before.clip), JSON.stringify(r.before));
  ok('one click rotates it: a top-positioned divider, a y-clipped pane, same split percent',
     r.after.orientation === 'h' && r.after.dividerClass.includes('horizontal')
     && r.after.dividerTop && !r.after.dividerLeft
     && /^polygon\(-99999px -?[\d.]+px,/.test(r.after.clip)
     && r.after.split.join(',') === '50', JSON.stringify(r.after));
  ok('a second click rotates it straight back',
     r.restored.orientation === 'v' && !r.restored.dividerClass.includes('horizontal'),
     JSON.stringify(r.restored));
}

console.log('\n5. the divider follows the pointer, and stays put when the map is dragged');
{
  const r = await p.evaluate(async () => {
    const rect = document.getElementById('map').getBoundingClientRect();
    _rcSetSplit(0, rect.left + rect.width * 0.7);
    const dv = _rcSlots[0].dividerEl;
    const at70 = { pct: _rcSplits[0], left: parseFloat(dv.style.left), want: rect.width * 0.7 };
    _rcSetSplit(0, rect.left + rect.width * 0.01);   // past the edge: clamped
    const clamped = _rcSplits[0];
    _rcSetSplit(0, rect.left + rect.width * 0.7);
    map.panBy([150, 0], { animate: false });
    await new Promise(res => setTimeout(res, 100));
    const pos = L.DomUtil.getPosition(map._mapPane);
    const pane = map.getPane('rc-' + _rcSlots[0].id);
    const m = /polygon\((-?[\d.]+)px/.exec(pane.style.clipPath);
    return { at70, clamped,
             afterPan: { left: parseFloat(dv.style.left), posX: pos.x,
                         clipLeft: m && parseFloat(m[1]), want: rect.width * 0.7 } };
  });
  ok('dragging to 70% puts the divider at 70%',
     Math.abs(r.at70.pct - 70) < 0.6 && Math.abs(r.at70.left - r.at70.want) < 2, JSON.stringify(r.at70));
  ok('and it cannot be dragged off the map', r.clamped === 4, String(r.clamped));
  ok('after a pan the divider stays at 70% of the view while the clip subtracts the slide',
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

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
