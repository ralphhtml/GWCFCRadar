#!/usr/bin/env node
/*
 * ECCC Outlooks: Environment and Climate Change Canada's thunderstorm
 * outlooks as an overlay, with a floating legend panel like SPC Outlook's.
 *
 *     node tools/test-ec-outlook.mjs
 *
 * The pill, its info button and drag handle, its floating panel, and the
 * layer it draws, held down against a stand-in GeoMet answer: three outlook
 * polygons (severe likely, severe possible, ordinary thunderstorms) plus
 * one that expired yesterday, served in place of api.weather.gc.ca with
 * everything else off. What is checked is which URL is asked, which
 * polygons are drawn in which colours, what the popup says, and that the
 * layer (and the panel) come down.
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
  ok('the pill is in the Overlays row, named ECCC Outlooks',
     /id="op-ec-outlook" data-ovid="ec-outlook"/.test(PAGE)
     && /toggleOverlayPill\('ec-outlook'\)">ECCC Outlooks</.test(PAGE));
  ok('with a drag handle in its markup',
     /id="op-ec-outlook"[\s\S]{0,400}?class="ov-drag"/.test(PAGE));
  ok('the collection read is the thunderstorm outlook, as GeoJSON, in English',
     /thunderstorm_outlook\/items\?f=json&limit=\d+&lang=en/.test(PAGE));
  ok('it refreshes on a timer and the switch-off clears it',
     /id === 'ec-outlook'[\s\S]*?setInterval\(loadEcOutlook, 15 \* 60 \* 1000\)[\s\S]*?map\.removeLayer\(_ecOutlookLayer\)/.test(PAGE));
  ok('it has its own floating panel, like SPC/WPC/CPC/Fire Weather do',
     /<div id="ec-controls">/.test(PAGE)
     && /ec-float-title[\s\S]{0,100}ECCC Outlooks/.test(PAGE)
     && /_makeDraggable\(document\.getElementById\('ec-controls'\),\s*document\.getElementById\('ec-drag'\)\)/.test(PAGE));
  ok('the panel shows and hides with the pill',
     /id === 'ec-outlook'\) \{[\s\S]{0,500}getElementById\('ec-controls'\)[\s\S]{0,150}display = _ecOutlookOn \? 'flex' : 'none'/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-ec-outlook.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// A stand-in answer in the GeoMet OGC API's shape. The field names are the
// ones Environment Canada publishes for this collection today; the loader
// reads a few spellings of each, and the fourth feature carries a different
// spelling on purpose so that tolerance is exercised too.
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const now = Date.now();
const box = (w, s, e, n) => ({ type: 'Polygon',
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const FEED = { type: 'FeatureCollection', features: [
  { type: 'Feature', id: 'ont-1', geometry: box(-84, 43, -78, 46),
    properties: { identifier: 'ont-1', region_en: 'Southern Ontario', threat_level_en: 'Severe thunderstorms likely',
                  publication_datetime: iso(now - 3600000), start_datetime: iso(now - 3600000),
                  end_datetime: iso(now + 10 * 3600000), day: 1,
                  text_en: 'A line of storms crossing the lower lakes this evening.' } },
  { type: 'Feature', id: 'pnr-1', geometry: box(-106, 49, -98, 53),
    properties: { identifier: 'pnr-1', region_en: 'Southern Saskatchewan and Manitoba', threat_level_en: 'Severe thunderstorms possible',
                  publication_datetime: iso(now - 3600000), start_datetime: iso(now),
                  end_datetime: iso(now + 12 * 3600000), day: 1 } },
  { type: 'Feature', id: 'atl-1', geometry: box(-66, 44, -60, 47),
    properties: { identifier: 'atl-1', region: 'Nova Scotia', threat: 'thunderstorm',
                  issuance_datetime: iso(now - 7200000), effective_datetime: iso(now + DAY),
                  expiry_datetime: iso(now + 2 * DAY), outlook_day: 2 } },
  { type: 'Feature', id: 'old-1', geometry: box(-120, 49, -114, 52),
    properties: { identifier: 'old-1', region_en: 'Alberta', threat_level_en: 'Severe thunderstorms likely',
                  publication_datetime: iso(now - 2 * DAY), start_datetime: iso(now - 2 * DAY),
                  end_datetime: iso(now - DAY), day: 1 } },
] };

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
const asked = [];
let serve = true;
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('thunderstorm_outlook')) {
    asked.push(url);
    if (!serve) return route.fulfill({ status: 503, body: 'down' });
    return route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(FEED) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. the pill, with both of its controls');
{
  const r = await p.evaluate(() => {
    const pill = document.getElementById('op-ec-outlook');
    if (!pill) return null;
    return {
      ovid: pill.dataset.ovid,
      name: (pill.querySelector('.ov-rowname') || {}).textContent,
      drag: !!pill.querySelector('.ov-drag'),
      info: !!pill.querySelector('.ov-info-btn'),
      desc: (OV_DESCRIPTIONS || {})['ec-outlook'] || '',
      icon: !!pill.querySelector('svg, .ov-icon'),
    };
  });
  ok('the pill exists in Overlays under its own id', r && r.ovid === 'ec-outlook', r && r.ovid);
  ok('named ECCC Outlooks', r && r.name === 'ECCC Outlooks', r && r.name);
  ok('it has a drag handle', r && r.drag);
  ok('and an info button', r && r.info);
  ok('which explains the colours and where the data comes from',
     r && /ECCC/.test(r.desc) && /Yellow/.test(r.desc) && /red/i.test(r.desc) && /GeoMet/.test(r.desc),
     String(r && r.desc.length));
}

console.log('\n3. turning it on draws the outlooks that are in effect');
{
  const r = await p.evaluate(async () => {
    toggleOverlayPill('ec-outlook');
    await new Promise(res => setTimeout(res, 900));
    const out = { on: _ecOutlookOn, pillOn: document.getElementById('op-ec-outlook').classList.contains('active'),
                  layer: !!_ecOutlookLayer,
                  panelShown: document.getElementById('ec-controls').style.display === 'flex',
                  polys: [] };
    if (_ecOutlookLayer) {
      _ecOutlookLayer.eachLayer(g => g.eachLayer(l => {
        if (!l.feature || !l.options || l.options.fill === false) return;
        out.polys.push({ id: l.feature.id, color: l.options.color, fill: l.options.fillColor,
                         pane: l.options.pane, hasPopupClick: !!(l._events && l._events.click) });
      }));
    }
    return out;
  });
  ok('the layer turns on and the pill lights', r.on && r.pillOn && r.layer, JSON.stringify(r));
  ok('and its floating legend panel shows, the same as SPC/WPC/CPC/Fire Weather', r.panelShown, JSON.stringify(r));
  ok('the collection was asked for once', asked.length === 1 && /thunderstorm_outlook\/items/.test(asked[0]), asked.join(' | '));
  const by = Object.fromEntries(r.polys.map(x => [x.id, x]));
  ok('three outlooks in effect are drawn; the one that expired yesterday is not',
     r.polys.length === 3 && !by['old-1'], JSON.stringify(r.polys.map(x => x.id)));
  ok('severe likely is red, severe possible is orange, thunderstorms yellow',
     by['ont-1'] && by['ont-1'].color === '#ff2121' && by['pnr-1'] && by['pnr-1'].color === '#ff6600'
     && by['atl-1'] && by['atl-1'].color === '#ffcc00', JSON.stringify(by));
  ok('drawn in the overlay\'s own pane, the most serious on top',
     r.polys.every(x => x.pane === 'ovp-ec-outlook') && r.polys[r.polys.length - 1].id === 'ont-1',
     JSON.stringify(r.polys.map(x => [x.id, x.pane])));
  ok('every area answers a tap', r.polys.every(x => x.hasPopupClick));
}

console.log('\n4. the popup says what the forecasters said');
{
  const r = await p.evaluate(async () => {
    // Read the popup Leaflet currently holds rather than the first one in
    // the DOM: a closed popup lingers there while it fades out.
    const shown = () => {
      const html = map._popup ? map._popup.getContent() : '';
      const d = document.createElement('div'); d.innerHTML = html;
      return d.textContent.replace(/\s+/g, ' ');
    };
    const poly = id => {
      let hit = null;
      _ecOutlookLayer.eachLayer(g => g.eachLayer(l => {
        if (l.feature && l.feature.id === id && l.options.fill !== false) hit = l; }));
      return hit;
    };
    poly('ont-1').fire('click', { latlng: L.latLng(44.5, -81), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 150));
    const text = shown();
    map.closePopup();
    poly('atl-1').fire('click', { latlng: L.latLng(45.5, -63), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 150));
    const text2 = shown();
    map.closePopup();
    return { text, text2 };
  });
  ok('the category, the region, the sender and the notes are all there',
     /Severe thunderstorms likely/i.test(r.text) && /Southern Ontario/.test(r.text)
     && /ECCC/.test(r.text) && /line of storms/.test(r.text), r.text.slice(0, 200));
  ok('a day-2 outlook under different field names still reads as one',
     /Thunderstorms possible/i.test(r.text2) && /Nova Scotia/.test(r.text2) && /Day 2/.test(r.text2), r.text2.slice(0, 200));
}

console.log('\n5. off, and a dead API');
{
  const r = await p.evaluate(async () => {
    toggleOverlayPill('ec-outlook');
    await new Promise(res => setTimeout(res, 100));
    return { on: _ecOutlookOn, layer: !!_ecOutlookLayer,
             pillOn: document.getElementById('op-ec-outlook').classList.contains('active'),
             onMap: !!document.querySelector('.leaflet-ovp-ec-outlook-pane path'),
             panelHidden: document.getElementById('ec-controls').style.display === 'none' };
  });
  ok('switching off takes the layer down', !r.on && !r.layer && !r.pillOn && !r.onMap, JSON.stringify(r));
  ok('and its floating panel too', r.panelHidden, JSON.stringify(r));
  serve = false;
  const d = await p.evaluate(async () => {
    const seen = [];
    const real = window.updateLoadStatus;
    window.updateLoadStatus = t => { seen.push(String(t)); return real(t); };
    toggleOverlayPill('ec-outlook');
    await new Promise(res => setTimeout(res, 1500));
    window.updateLoadStatus = real;
    const out = { on: _ecOutlookOn, layer: !!_ecOutlookLayer, seen: seen.join(' | ') };
    toggleOverlayPill('ec-outlook');
    return out;
  });
  ok('an API that will not answer says so instead of drawing nothing quietly',
     d.on && !d.layer && /unavailable/i.test(d.seen), d.seen);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
