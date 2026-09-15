#!/usr/bin/env node
/*
 * ECCC Alerts: Environment and Climate Change Canada's public weather
 * alerts as an overlay, coloured by ECCC's own Minor/Moderate/High/Extreme
 * risk scale rather than the old three colours this used to guess at.
 *
 *     node tools/test-eccc-alerts.mjs
 *
 * The pill and its rename, the four-tier colour mapping (grey/yellow/
 * orange/red -> Minor/Moderate/High/Extreme), the dotted pattern fill
 * Extreme alerts get instead of a flat colour, and the layer drawn against
 * a stand-in feed with one alert of each risk colour plus one with none at
 * all (the unknown-value fallback).
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
  ok('the pill is in the Overlays row, named ECCC Alerts',
     /id="op-canada-alerts" data-ovid="canada-alerts"/.test(PAGE)
     && /toggleOverlayPill\('canada-alerts'\)">ECCC Alerts</.test(PAGE));
  ok('the four-tier risk scale table exists, one row per ECCC colour word',
     /const ECCC_RISK_LEVELS = \{[\s\S]{0,500}grey:[\s\S]{0,120}gray:[\s\S]{0,120}yellow:[\s\S]{0,120}orange:[\s\S]{0,120}red:/.test(PAGE));
  ok('grey and gray both read as Minor (the API could send either spelling)',
     /grey:\s*\{ level: 'Minor'/.test(PAGE) && /gray:\s*\{ level: 'Minor'/.test(PAGE));
  ok('yellow is Moderate, orange is High, red is Extreme',
     /yellow:\s*\{ level: 'Moderate'/.test(PAGE)
     && /orange:\s*\{ level: 'High'/.test(PAGE)
     && /red:\s*\{ level: 'Extreme'/.test(PAGE));
  ok('an unrecognised colour word falls back to the same tier it always did',
     /return ECCC_RISK_LEVELS\[r\] \|\| ECCC_RISK_LEVELS\.yellow;/.test(PAGE));
  ok('Extreme is filled with a dotted pattern, not a flat colour',
     /red:\s*\{ level: 'Extreme',\s*stroke: '#c62828', fill: 'url\(#eccc-extreme-dots\)' \}/.test(PAGE));
  ok('the dot pattern itself is defined once, in the icon sprite',
     /<pattern id="eccc-extreme-dots" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#d9534f"\/><circle cx="4" cy="4" r="1\.3" fill="#ffffff"/.test(PAGE));
  ok('the popup never receives the pattern URL - only a plain colour can border a popup',
     /const popupColor = risk\.stroke;/.test(PAGE));
  ok('the status messages were renamed too',
     PAGE.includes("updateLoadStatus('Loading ECCC Alerts…');")
     && PAGE.includes("updateLoadStatus('ECCC alert data unavailable.');")
     && PAGE.includes("updateLoadStatus('No active ECCC weather alerts.');"));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-eccc-alerts.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const now = Date.now();
const box = (w, s, e, n) => ({ type: 'Polygon',
  coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const alert = (id, lon, lat, risk, extra) => ({ type: 'Feature', id,
  geometry: box(lon - 3, lat - 2, lon + 3, lat + 2),
  properties: Object.assign({
    id, feature_id: id, alert_type: 'Weather Statement', alert_short_name_en: id + ' alert',
    feature_name_en: id + ' Region', province: 'ON',
    publication_datetime: iso(now - 3600000), validity_datetime: iso(now - 3600000),
    expiration_datetime: iso(now + 6 * 3600000), event_end_datetime: iso(now + 6 * 3600000),
    confidence_en: 'High', alert_text_en: 'Stand-in text for ' + id, status_en: 'alert',
    risk_colour_en: risk,
  }, extra || {}) });
const FEED = { type: 'FeatureCollection', features: [
  alert('minor-1', -113, 51, 'grey'),
  alert('moderate-1', -97, 50, 'yellow'),
  alert('high-1', -80, 45, 'orange'),
  alert('extreme-1', -63, 46, 'red'),
  alert('unknown-1', -123, 49, 'teal'), // not a colour ECCC is known to send - the fallback path
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
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('weather-alerts')) {
    asked.push(url);
    return route.fulfill({ contentType: 'application/geo+json', body: JSON.stringify(FEED) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. the pill itself');
{
  const r = await p.evaluate(() => {
    const pill = document.getElementById('op-canada-alerts');
    return {
      ovid: pill && pill.dataset.ovid,
      name: pill && (pill.querySelector('.ov-rowname') || {}).textContent,
      desc: (OV_DESCRIPTIONS || {})['canada-alerts'] || '',
    };
  });
  ok('the pill exists under its own (unchanged) id', r.ovid === 'canada-alerts', r.ovid);
  ok('named ECCC Alerts', r.name === 'ECCC Alerts', r.name);
  ok('its description names ECCC and the risk scale', /ECCC/.test(r.desc) && /Minor/.test(r.desc) && /Extreme/.test(r.desc), r.desc);
}

console.log('\n3. turning it on draws every risk tier with the right colours');
{
  const r = await p.evaluate(async () => {
    toggleOverlayPill('canada-alerts');
    await new Promise(res => setTimeout(res, 900));
    const out = { on: _canadaAlertsActive,
                  pillOn: document.getElementById('op-canada-alerts').classList.contains('active'),
                  layer: !!_canadaAlertsLayer, polys: [] };
    if (_canadaAlertsLayer) {
      _canadaAlertsLayer.eachLayer(g => g.eachLayer(l => {
        if (!l.feature || !l.options || l.options.fill === false) return;
        out.polys.push({ id: l.feature.id, color: l.options.color, fill: l.options.fillColor });
      }));
    }
    return out;
  });
  ok('the layer turns on and the pill lights', r.on && r.pillOn && r.layer, JSON.stringify(r));
  ok('the collection was asked for once', asked.length === 1 && /weather-alerts\/items/.test(asked[0]), asked.join(' | '));
  const by = Object.fromEntries(r.polys.map(x => [x.id, x]));
  ok('all five alerts are drawn', r.polys.length === 5, JSON.stringify(r.polys.map(x => x.id)));
  ok('Minor (grey) is the grey fill', by['minor-1'] && by['minor-1'].fill === '#c9c9c9', JSON.stringify(by['minor-1']));
  ok('Moderate (yellow) is the cream fill', by['moderate-1'] && by['moderate-1'].fill === '#eeecc0', JSON.stringify(by['moderate-1']));
  ok('High (orange) is the tan fill', by['high-1'] && by['high-1'].fill === '#e3c599', JSON.stringify(by['high-1']));
  ok('Extreme (red) is the dotted pattern, not a flat colour',
     by['extreme-1'] && by['extreme-1'].fill === 'url(#eccc-extreme-dots)', JSON.stringify(by['extreme-1']));
  ok('an unrecognised colour word falls back to the Moderate tier',
     by['unknown-1'] && by['unknown-1'].fill === '#eeecc0', JSON.stringify(by['unknown-1']));
}

console.log('\n4. the dot pattern actually renders, not just the reference to it');
{
  const r = await p.evaluate(() => {
    const pat = document.getElementById('eccc-extreme-dots');
    if (!pat) return null;
    const rect = pat.querySelector('rect');
    const circle = pat.querySelector('circle');
    // The path Leaflet drew for the Extreme alert really does carry the
    // pattern reference as its live fill, not just in the options object.
    let pathFill = null;
    if (typeof _canadaAlertsLayer !== 'undefined' && _canadaAlertsLayer) {
      _canadaAlertsLayer.eachLayer(g => g.eachLayer(l => {
        if (l.feature && l.feature.id === 'extreme-1' && l._path) pathFill = l._path.getAttribute('fill');
      }));
    }
    return {
      hasRect: !!rect, rectFill: rect && rect.getAttribute('fill'),
      hasCircle: !!circle, circleFill: circle && circle.getAttribute('fill'),
      pathFill,
    };
  });
  ok('the pattern element exists with a solid red base', r && r.hasRect && r.rectFill === '#d9534f', JSON.stringify(r));
  ok('and a white dot on top of it', r && r.hasCircle && r.circleFill === '#ffffff', JSON.stringify(r));
  ok('the Extreme polygon\'s own rendered path carries that pattern as its fill',
     r && r.pathFill === 'url(#eccc-extreme-dots)', JSON.stringify(r));
}

console.log('\n5. the popup reads the real risk level, and borders in a plain colour');
{
  const r = await p.evaluate(async () => {
    const shown = () => {
      const html = map._popup ? map._popup.getContent() : '';
      const d = document.createElement('div'); d.innerHTML = html;
      return d.textContent.replace(/\s+/g, ' ');
    };
    const poly = id => {
      let hit = null;
      _canadaAlertsLayer.eachLayer(g => g.eachLayer(l => {
        if (l.feature && l.feature.id === id && l.options.fill !== false) hit = l; }));
      return hit;
    };
    poly('extreme-1').fire('click', { latlng: L.latLng(46, -63), originalEvent: new Event('click') });
    await new Promise(res => setTimeout(res, 150));
    const text = shown();
    const wrapBorder = (map._popup.getElement().querySelector('.leaflet-popup-content-wrapper') || {}).style.borderColor;
    map.closePopup();
    return { text, wrapBorder };
  });
  ok('the popup says Extreme, ECCC\'s own word, not a generic "Severe"',
     /Extreme/.test(r.text) && /ECCC/.test(r.text), r.text.slice(0, 160));
  ok('the popup border is the plain stroke colour, never the pattern URL',
     r.wrapBorder === 'rgb(198, 40, 40)', r.wrapBorder);
}

console.log('\n6. off');
{
  const r = await p.evaluate(async () => {
    toggleOverlayPill('canada-alerts');
    await new Promise(res => setTimeout(res, 100));
    return { on: _canadaAlertsActive, layer: !!_canadaAlertsLayer,
             pillOn: document.getElementById('op-canada-alerts').classList.contains('active') };
  });
  ok('switching off takes the layer down', !r.on && !r.layer && !r.pillOn, JSON.stringify(r));
  ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
