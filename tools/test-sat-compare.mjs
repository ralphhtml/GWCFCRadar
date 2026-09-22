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
  ok('a product tap adds a strip while a comparison is running',
     /if \(typeof _scOn !== 'undefined' && _scOn && activeLayers\.satellite\) \{\s*\n\s*_scAddSlot\(p\.id\);/.test(PAGE));
  ok('a sector tap adds the current product from that sector',
     /_scAddSlot\(_goesProductId, r\.id\);/.test(PAGE));
  ok('the strip planners are the main picture\'s own, parameterised',
     /function _goesConfigFor\(product, regionId\)/.test(PAGE)
     && /function _goesPiTargetFor\(product, regionId\)/.test(PAGE)
     && /async function _goesPiFramesFor\(product, regionId\)/.test(PAGE));
  ok('the clip geometry is shared with the other two comparisons',
     PAGE.includes('function _stripGeometry(leftPct, rightPct, axis)')
     && (PAGE.match(/_stripGeometry\(leftPct, rightPct\)/g) || []).length >= 2);
  ok('a bubble in a running comparison wears the strip ring',
     /\.sub-bubble\.in-compare \{/.test(PAGE));
  ok('and the info description says what it does',
     /'sat-compare': 'Cuts the map into vertical strips/.test(PAGE));
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
  ok('one divider and one label per strip, lettered from B',
     r.dividers === 2 && r.labels.length === 2 && /^B {2}Upper Water Vapor/.test(r.labels[0])
     && /^C {2}Clean IR · West CONUS/.test(r.labels[1]), JSON.stringify(r.labels));
  ok('strip A cannot be added to itself', r.afterDup === 2, String(r.afterDup));
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

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
