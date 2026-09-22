#!/usr/bin/env node
/*
 * Comparing an ABI band against an RGB composite (or either against the
 * global mosaic) in a sector that isn't whatever strip A happens to be
 * showing.
 *
 *     node tools/test-sat-cross-region.mjs
 *
 * A raw ABI band is served by the WMS, which publishes eleven real
 * sectors (CONUS east/west, Alaska, Hawaii, Caribbean, both Full Disks,
 * all four mesoscale boxes). An RGB composite is built on the Pi instead,
 * which only ever builds eight of those (no Alaska, Hawaii or Caribbean,
 * which are the WMS's own reprojections rather than ABI products it
 * scans). The sector row used to always judge itself against strip A's
 * own product, wherever in the menu it was drawn - so browsing into RGB
 * Composites while an ABI band was on screen kept offering Alaska, and
 * the other way round hid sectors a band genuinely has. It now judges
 * itself by whichever kind of picture the menu is actually showing.
 *
 * Cross-product comparison also could not put two different products in
 * two different sectors at all: a sector tap only ever added strip A's
 * OWN product again, never whatever else was being browsed. A sector
 * tapped while a specific kind's menu is open now sits "pending" until a
 * product is tapped, and that product carries it - any kind, not just
 * whichever one the sector list happened to be judged against.
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
  ok('region availability can be judged against a kind instead of always strip A',
     /function _goesRegionAvailable\(region, ch, ctx\) \{/.test(PAGE)
     && /const isGlobal = ctx \? ctx\.isGlobal : \(_goesProduct\(\)\.gsat === 'global'\);/.test(PAGE)
     && /const isPi = ctx \? ctx\.isPi : \(typeof _goesIsPi === 'function' && _goesIsPi\(\)\);/.test(PAGE));
  ok('the region row takes an optional kind id, and both deeper menu levels pass their own',
     /function _satRegionRow\(wrap, kindId\) \{/.test(PAGE)
     && (PAGE.match(/_satRegionRow\(wrap, k\.id\);/g) || []).length === 2
     && PAGE.includes('_satRegionRow(wrap);'));
  ok('a pending-region state exists, cleared when compare ends',
     /let _scPendingRegion = null;/.test(PAGE)
     && /function _scOff\(\) \{[\s\S]*?_scPendingRegion = null;/.test(PAGE));
  ok('a sector tap inside a kind\'s menu marks it pending instead of adding strip A again',
     /if \(kindId\) \{\s*\n\s*_scPendingRegion = \(_scPendingRegion === r\.id\) \? null : r\.id;/.test(PAGE));
  ok('a product tap while comparing picks up whatever sector was pending, of any kind',
     /const region = _scPendingRegion;\s*\n\s*_scPendingRegion = null;/.test(PAGE)
     && /_scAddSlot\(p\.id, region !== null \? region : undefined\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sat-cross-region.mjs'), 'utf8').includes(EM));
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
await p.waitForTimeout(4500);
// The What Changed modal's own open attempt is on a delayed timer inside
// _actuallyDismiss, so closing it once here would only race that timer;
// marking it seen stops the delayed attempt from ever opening it.
await p.evaluate(() => {
  try { if (typeof _clMarkSeen === 'function') _clMarkSeen(); } catch (e) {}
  const m = document.getElementById('changelog-modal');
  if (m) m.classList.remove('open');
});

console.log('\n2. browsing a kind shows THAT kind\'s own real sectors, not strip A\'s');
{
  const r = await p.evaluate(async () => {
    _setGoesProduct('ch13');   // an ABI band, strip A
    await new Promise(res => setTimeout(res, 300));
    toggleSatelliteSub();
    const rgbKind = GOES_KINDS.find(k => k.id === 'rgb');
    const abiKind = GOES_KINDS.find(k => k.id === 'abi');
    _satKindSub(rgbKind);
    const rgbRegions = [...document.querySelectorAll('#sat-region-row .sat-region-btn')]
      .map(b => b.dataset.regionId);
    _satKindSub(abiKind);
    const abiRegions = [...document.querySelectorAll('#sat-region-row .sat-region-btn')]
      .map(b => b.dataset.regionId);
    return { rgbRegions, abiRegions };
  });
  ok('RGB Composites never offers Alaska, Hawaii or the Caribbean - the Pi cannot build them',
     !r.rgbRegions.includes('alaska') && !r.rgbRegions.includes('hawaii') && !r.rgbRegions.includes('caribbean'),
     JSON.stringify(r.rgbRegions));
  ok('RGB Composites does offer the sectors the Pi genuinely builds',
     ['east', 'west', 'efulldisk', 'wfulldisk', 'emeso1', 'emeso2', 'wmeso1', 'wmeso2']
       .every(id => r.rgbRegions.includes(id)),
     JSON.stringify(r.rgbRegions));
  ok('ABI Bands offers real sectors RGB Composites was just hiding, even though strip A is an ABI band either way',
     r.abiRegions.includes('alaska') && r.abiRegions.includes('hawaii') && r.abiRegions.includes('caribbean'),
     JSON.stringify(r.abiRegions));
}

console.log('\n3. a sector picked from a kind\'s menu carries over to whatever product is tapped next');
{
  const r = await p.evaluate(async () => {
    const out = {};
    _scToggle();   // strip A (ch13) is already showing, compare starts
    out.on = _scOn;
    toggleSatelliteSub();
    const rgbKind = GOES_KINDS.find(k => k.id === 'rgb');
    _satKindSub(rgbKind);
    document.querySelector('#sat-region-row .sat-region-btn[data-region-id="west"]').click();
    // The click rebuilds the whole row (paintRegions), so the button that
    // now carries the pending class is a fresh element, not the one just
    // clicked - re-query rather than reuse the now-detached reference.
    out.pendingAfterTap = _scPendingRegion;
    out.pendingClass = document.querySelector('#sat-region-row .sat-region-btn[data-region-id="west"]')
      .classList.contains('pending');
    out.slotsBeforeProduct = _scSlots.length;
    // Now actually reach the RGB product list and tap one.
    const cat = GOES_CATS.find(c => c.kind === 'rgb');
    const items = GOES_PRODUCTS.filter(p => p.group === cat.id);
    _satCatSub(rgbKind, cat, items);
    const prodBtn = document.querySelector(`#sub-bubbles [data-product-id="${items[0].id}"]`);
    prodBtn.click();
    out.slotsAfter = _scSlots.map(s => ({ productId: s.productId, regionId: s.regionId }));
    out.pendingClearedAfter = _scPendingRegion;
    _scOff();
    return out;
  });
  ok('compare starts from strip A', r.on === true);
  ok('tapping a sector inside the RGB menu marks it pending, adds nothing yet',
     r.pendingAfterTap === 'west' && r.pendingClass === true && r.slotsBeforeProduct === 0,
     JSON.stringify(r));
  ok('tapping the RGB product afterward adds it in the pending sector, not the default one',
     r.slotsAfter.length === 1 && r.slotsAfter[0].regionId === 'west' && r.slotsAfter[0].productId.startsWith('rgb-'),
     JSON.stringify(r.slotsAfter));
  ok('the pending sector is consumed, not left for the next unrelated tap',
     r.pendingClearedAfter === null, String(r.pendingClearedAfter));
}

console.log('\n4. the top-level row keeps its original one-tap meaning: strip A vs itself in another sector');
{
  const r = await p.evaluate(async () => {
    _setGoesProduct('ch13');
    await new Promise(res => setTimeout(res, 300));
    _scToggle();
    toggleSatelliteSub();   // no kind chosen: the original, unscoped row
    const westBtn = document.querySelector('#sat-region-row .sat-region-btn[data-region-id="west"]');
    westBtn.click();
    const out = {
      slots: _scSlots.map(s => ({ productId: s.productId, regionId: s.regionId })),
      pendingUntouched: _scPendingRegion,
    };
    _scOff();
    return out;
  });
  ok('a sector tap at the top level still adds strip A\'s own product immediately, exactly as before',
     r.slots.length === 1 && r.slots[0].productId === 'ch13' && r.slots[0].regionId === 'west',
     JSON.stringify(r.slots));
  ok('and never touches the pending-region state, which only a kind\'s own menu uses',
     r.pendingUntouched === null);
}

console.log('\n5. ending the comparison clears a sector left pending mid-browse');
{
  const r = await p.evaluate(async () => {
    _setGoesProduct('ch13');
    await new Promise(res => setTimeout(res, 300));
    _scToggle();
    toggleSatelliteSub();
    const rgbKind = GOES_KINDS.find(k => k.id === 'rgb');
    _satKindSub(rgbKind);
    document.querySelector('#sat-region-row .sat-region-btn[data-region-id="east"]').click();
    const wasPending = _scPendingRegion;
    _scOff();
    return { wasPending, afterOff: _scPendingRegion };
  });
  ok('it really was pending before ending', r.wasPending === 'east');
  ok('ending the comparison clears it, so the next one starts clean', r.afterOff === null);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
