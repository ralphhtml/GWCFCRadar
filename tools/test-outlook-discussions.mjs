#!/usr/bin/env node
/*
 * Tapping an SPC, WPC or NHC outlook area shows what the forecaster who
 * issued it actually wrote, not just the category it was colored for.
 *
 *     node tools/test-outlook-discussions.mjs
 *
 * All three centres narrate their outlook in a plain text discussion, one
 * per product rather than one per polygon, published alongside the
 * shapes. This reads that text and shows it in the same shared alert
 * popup style Env. CN Outlooks already uses: a short summary first, the
 * forecaster's own words underneath. Driven here against stand-in
 * responses for the geometry AND the discussion text, since neither
 * source is reachable from this sandbox - what is checked is the wiring:
 * which URL gets asked, that a tap opens immediately rather than waiting
 * on the network, that the real text lands where it should, and that a
 * failed fetch says so honestly instead of just showing nothing.
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
  ok('a shared opener shows the summary now and fills the discussion in once it lands',
     PAGE.includes('function _outlookOpenPopup(ev, mapped, color, discPromise, sourceUrl) {')
     && PAGE.includes("mapped.description = 'Reading the forecast discussion…';"));
  ok('a stale popup can never be overwritten by an answer for an area no longer open',
     PAGE.includes('if (map._popup !== pop) return;'));
  ok('a failed fetch says so honestly, with where to read it directly',
     /Could not reach the discussion text just now\. Read it directly at \$\{sourceUrl\}/.test(PAGE));
  ok('SPC\'s polygon click reads its own day\'s discussion, one per day not one per polygon',
     PAGE.includes("_fetchOutlookDiscussion(_spcDiscKey(dayNum), _spcDiscUrls(dayNum)), sourceUrl);"));
  ok('WPC\'s polygon click reads the one combined day1-3 discussion',
     PAGE.includes("_fetchOutlookDiscussion('wpc', _wpcDiscUrls())"));
  ok('NHC reads the modern product API first, the public page second',
     PAGE.includes('function _nhcTwoText(code)')
     && PAGE.includes('https://api.weather.gov/products/types/TWO${code}')
     && /return _fetchOutlookDiscussion\(key, \[`https:\/\/www\.nhc\.noaa\.gov\/text\/MIATWO\$\{code\}\.shtml`\]\);/.test(PAGE));
  ok('the three info descriptions say what tapping an area now does',
     PAGE.includes("forecaster's own written discussion of that day's outlook")
     && PAGE.includes("forecaster's own written Tropical Weather Outlook discussion")
     && PAGE.includes("Tap an area for the forecaster's own written discussion."));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-outlook-discussions.mjs'), 'utf8').includes(EM));
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

// Fake bodies, swapped per test. `asked` records every URL this ever
// reaches for, so the wiring (which door each source actually knocks on)
// is checked directly rather than assumed.
const asked = [];
let spcGeo = null, spcTxt = null, spcTxtStatus = 200;
let wpcGeo = null, wpcTxt = null;
let nhcInvest = null, nhcTwoList = null, nhcTwoBody = null;
let discDelayMs = 0;

await p.route('**://**', async route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  asked.push(url);

  if (url.includes('spc.noaa.gov/products/outlook/day') && url.endsWith('.nolyr.geojson'))
    return spcGeo ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(spcGeo) })
                  : route.fulfill({ status: 404, body: 'no' });
  if (url.includes('spc.noaa.gov/products/outlook/day') && url.endsWith('otlk.txt')) {
    if (discDelayMs) await new Promise(r => setTimeout(r, discDelayMs));
    return spcTxtStatus === 200
      ? route.fulfill({ contentType: 'text/plain', body: spcTxt || '' })
      : route.fulfill({ status: 500, body: 'down' });
  }
  if (url.includes('wpcprecip_hazards') || url.includes('wpc_precip_hazards'))
    return wpcGeo ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(wpcGeo) })
                  : route.fulfill({ status: 404, body: 'no' });
  if (url.includes('wpc.ncep.noaa.gov/qpf/day1-3ero_da.txt')) {
    if (discDelayMs) await new Promise(r => setTimeout(r, discDelayMs));
    return route.fulfill({ contentType: 'text/plain', body: wpcTxt || '' });
  }
  if (url.includes('cachefetch.sparkradar.app')) {
    const inner = decodeURIComponent(url.split('url=')[1] || '');
    const m = inner.match(/MapServer\/(\d+)\//);
    const layer = m ? m[1] : '';
    if (layer === '3') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(nhcInvest || { features: [] }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: [] }) });
  }
  if (url.includes('api.weather.gov/products/types/TWO'))
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(nhcTwoList || { '@graph': [] }) });
  if (url.includes('api.weather.gov/products/') && !url.includes('/types/')) {
    if (discDelayMs) await new Promise(r => setTimeout(r, discDelayMs));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ productText: nhcTwoBody || '' }) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);

const spcFeature = (label, hex) => ({ type: 'Feature',
  properties: { DN: label, LABEL: label, fill: hex },
  geometry: { type: 'Polygon', coordinates: [[[-98, 34], [-97, 34], [-97, 35], [-98, 35], [-98, 34]]] } });

console.log('\n2. SPC: a tap opens now, and the real discussion fills in underneath');
{
  spcGeo = { type: 'FeatureCollection', features: [spcFeature('SLGT', '#f6f67f')] };
  spcTxt = 'FXUS64 KWNS 121730\nAC KWNS\n\n' +
    'SLIGHT RISK OF SEVERE THUNDERSTORMS ACROSS THE SOUTHERN PLAINS TODAY. ' +
    'A COUPLE OF STRONG TO DAMAGING WIND GUSTS AND ISOLATED LARGE HAIL ARE EXPECTED ' +
    'WITH THE MOST ORGANIZED STORMS THIS AFTERNOON AND EVENING.';
  spcTxtStatus = 200;
  const r = await p.evaluate(async () => {
    await loadSPCOutlook(1, 'cat');
    let layer = null;
    spcOutlookLayer.eachLayer(l => { layer = l; });
    layer.fire('click', { latlng: L.latLng(34.5, -97.5), originalEvent: new Event('click') });
    const immediate = map._popup.getContent();
    await new Promise(res => setTimeout(res, 300));
    const settled = map._popup.getContent();
    return { immediate, settled };
  });
  const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('it opens immediately with the loading line, not blank and not waiting on the network',
     /Reading the forecast discussion/.test(r.immediate), r.immediate.slice(0, 200));
  ok('the category and its plain-English name are the headline',
     /SLGT\s*-\s*Slight Risk/.test(textOf(r.settled)), textOf(r.settled).slice(0, 200));
  ok('the routing header is gone and the forecaster\'s own words are there once it settles',
     !/FXUS64/.test(r.settled) && /SLIGHT RISK OF SEVERE THUNDERSTORMS/.test(textOf(r.settled)),
     textOf(r.settled).slice(0, 300));
  ok('day 1 asked for day1otlk.txt, the day it was actually shown for',
     asked.some(u => u.includes('day1otlk.txt')), asked.filter(u => u.includes('spc')).join(' | '));
}

console.log('\n3. SPC: a failed discussion fetch says so honestly, with the direct link');
{
  spcTxtStatus = 500;
  const r = await p.evaluate(async () => {
    _outlookDiscCache.clear();   // this test wants a fresh attempt, not yesterday's cached success
    let layer = null;
    spcOutlookLayer.eachLayer(l => { layer = l; });
    layer.fire('click', { latlng: L.latLng(34.5, -97.5), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 300));
    return map._popup.getContent();
  });
  const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('it says the text could not be reached and names the real source',
     /Could not reach the discussion text/.test(textOf(r))
     && /spc\.noaa\.gov\/products\/outlook\/day1otlk\.html/.test(textOf(r)), textOf(r).slice(0, 300));
  spcTxtStatus = 200;
}

console.log('\n4. WPC: the risk tier and the forecaster\'s discussion both come through');
{
  wpcGeo = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { dn: 'MODERATE' },
      geometry: { type: 'Polygon', coordinates: [[[-90, 33], [-89, 33], [-89, 34], [-90, 34], [-90, 33]]] } },
  ] };
  wpcTxt = 'FGUS21 KWNH 121030\nDAY 1-3 EXCESSIVE RAINFALL DISCUSSION\n\n' +
    'A SLOW MOVING SYSTEM WILL BRING HEAVY RAINFALL AND A MODERATE RISK OF FLASH ' +
    'FLOODING TO PARTS OF THE MID SOUTH THROUGH THE WEEKEND.';
  const r = await p.evaluate(async () => {
    _wpcDay = 1;
    await loadWPCOutlook(1);
    let layer = null;
    _wpcOutlookLayer.eachLayer(l => { layer = l; });
    layer.fire('click', { latlng: L.latLng(33.5, -89.5), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 300));
    return map._popup.getContent();
  });
  const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('the moderate tier and the real WPC discussion both appear',
     /Moderate Excessive Rainfall Risk/i.test(textOf(r))
     && /MODERATE RISK OF FLASH FLOODING/.test(textOf(r)), textOf(r).slice(0, 300));
}

console.log('\n5. NHC: the basin decides which Tropical Weather Outlook is read');
{
  nhcInvest = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { investname: 'Invest 92L', basin: 'AL', risk7day: 'Medium', risk2day: 'Low' },
      geometry: { type: 'Polygon', coordinates: [[[-60, 15], [-58, 15], [-58, 17], [-60, 17], [-60, 15]]] } },
  ] };
  nhcTwoList = { '@graph': [{ id: 'https://api.weather.gov/products/xyz' }] };
  nhcTwoBody = 'A broad area of low pressure near 92L continues to produce disorganized showers ' +
    'and thunderstorms. Environmental conditions are expected to become gradually more conducive ' +
    'for development, and this system has a medium chance of formation over the next 7 days.';
  const r = await p.evaluate(async () => {
    await loadNHC5dayOutlook();
    let layer = null;
    nhc5dayLayer.eachLayer(l => { layer = l; });
    layer.fire('click', { latlng: L.latLng(16, -59), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 300));
    return map._popup.getContent();
  });
  const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('the system\'s name, the risk, and the forecaster\'s own words all appear',
     /Invest 92L/.test(textOf(r)) && /Medium/.test(textOf(r))
     && /medium chance of formation over the next 7 days/.test(textOf(r)), textOf(r).slice(0, 300));
  ok('the Atlantic basin asked the Atlantic Tropical Weather Outlook product type',
     asked.some(u => u.includes('api.weather.gov/products/types/TWOAT')),
     asked.filter(u => u.includes('weather.gov')).join(' | '));
}

console.log('\n6. a second tap while the first is still loading is not clobbered by the stale answer');
{
  discDelayMs = 400;
  spcGeo = { type: 'FeatureCollection', features: [spcFeature('SLGT', '#f6f67f'), spcFeature('MDT', '#e8001f')] };
  spcTxt = 'FXUS64 KWNS 121730\nAC KWNS\n\nA SLOW-MOVING DISCUSSION FOR TODAY.';
  const r = await p.evaluate(async () => {
    await loadSPCOutlook(1, 'cat');
    const layers = [];
    spcOutlookLayer.eachLayer(l => layers.push(l));
    layers[0].fire('click', { latlng: L.latLng(34.5, -97.5), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 50));   // still loading
    layers[1].fire('click', { latlng: L.latLng(34.5, -97.5), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 600));  // both would have resolved by now
    return map._popup.getContent();
  });
  const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  ok('the popup that is actually open still shows the second area\'s own summary, not the first\'s stale one',
     !/SLGT\s*-/.test(textOf(r)), textOf(r).slice(0, 200));
  discDelayMs = 0;
  ok('and nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
