#!/usr/bin/env node
/*
 * The two history machines: Forecast Time Machine (what the thermometer
 * really read on a past date) and Climate Time Machine (what is normal for
 * that day), both riding NOAA's climate archive.
 *
 *     node tools/test-time-machines.mjs
 *
 * The archive replies are built in this file to the exact shape the real
 * data/v1 service answers with (arrays of string-valued rows), so the whole
 * engine runs offline: pills, modal, dots, colors, popups, switcher,
 * exclusivity and teardown, all driven in a real browser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const SERVE = readFileSync(join(ROOT, 'pi/serve.py'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

// Three stations: one that ran hot against its normal, one that ran cold,
// and one that publishes no normal at all (gray, by design).
const DAILY = JSON.stringify([
  { DATE: '2025-09-01', STATION: 'USW0001', NAME: 'ATLANTA HARTSFIELD, GA US',
    LATITUDE: '33.63', LONGITUDE: '-84.44', TMAX: '94', TMIN: '71',
    PRCP: '0.00', SNOW: '0.0' },
  { DATE: '2025-09-01', STATION: 'USW0002', NAME: 'DULUTH, MN US',
    LATITUDE: '46.84', LONGITUDE: '-92.19', TMAX: '48', TMIN: '39',
    PRCP: '0.42', SNOW: '0.0' },
  { DATE: '2025-09-01', STATION: 'USC0003', NAME: 'SMALL GAUGE, KS US',
    LATITUDE: '38.50', LONGITUDE: '-98.00', TMAX: '70', TMIN: '55',
    PRCP: '1.25', SNOW: '0.0' },
]);
const NORMALS = JSON.stringify([
  { DATE: '2010-09-01', STATION: 'USW0001', LATITUDE: '33.63', LONGITUDE: '-84.44',
    'DLY-TMAX-NORMAL': '88', 'DLY-TMIN-NORMAL': '69' },
  { DATE: '2010-09-01', STATION: 'USW0002', LATITUDE: '46.84', LONGITUDE: '-92.19',
    'DLY-TMAX-NORMAL': '58', 'DLY-TMIN-NORMAL': '48' },
]);

console.log('\n1. the machines are wired the way the site expects');
{
  ok('both pills sit in the overlay row',
     /id="op-ftm" data-ovid="ftm"/.test(PAGE)
     && /id="op-ctm" data-ovid="ctm"/.test(PAGE));
  ok('the toggle branch keeps them mutually exclusive',
     /if \(_htmMode\) _htmOff\(true\);/.test(PAGE));
  ok('the badge joins the stacked time-machine badges',
     /\['tm-badge', 'tm-badge-sat', 'tm-badge-htm'\]/.test(PAGE));
  ok('the archive floor is the real one', /HTM_FLOOR = '1763-01-01'/.test(PAGE));
  ok('the Pi grows a scoped NCEI door, never a general proxy',
     /def _relay_ncei\(self\):/.test(SERVE)
     && /NCEI_DATASETS = \{"daily-summaries", "normals-daily"\}/.test(SERVE)
     && /urlencode\(\{/.test(SERVE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here, in the page, or in serve.py',
     !PAGE.includes(EM) && !SERVE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-time-machines.mjs'), 'utf8').includes(EM));
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
  if (url.includes('ncei.noaa.gov/access/services/data/v1')) {
    const body = /dataset=normals-daily/.test(url) ? NORMALS : DAILY;
    return route.fulfill({ contentType: 'application/json', body });
  }
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'),
             { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. the Forecast Time Machine reads the archive honestly');
{
  const r = await p.evaluate(async () => {
    const out = {};
    map.setView([39, -90], 4);
    toggleOverlayPill('ftm');
    out.modalOpen = document.getElementById('htm-modal').classList.contains('open');
    document.querySelector('#htm-date').value = '2025-09-01';
    _htmApply();
    await new Promise(res => setTimeout(res, 900));
    out.mode = _htmMode;
    out.pillLit = document.getElementById('op-ftm').classList.contains('active');
    out.modalClosed = !document.getElementById('htm-modal').classList.contains('open');
    const layers = _htmLayer ? _htmLayer.getLayers() : [];
    out.count = layers.length;
    const html = layers.map(l => l.options.icon.options.html);
    // 94 over an 88 normal ran +6: the hot orange. 48 under 58 ran -10: deep blue.
    out.hot = html.some(x => x.includes('94°') && x.includes('#ff6a00'));
    out.cold = html.some(x => x.includes('48°') && x.includes('#0050d4'));
    // The gauge with no published normal shows its 70 in gray.
    out.gray = html.some(x => x.includes('70°') && x.includes('#5a6572'));
    const atl = layers.find(l => l.options.icon.options.html.includes('94°'));
    out.popup = atl ? String(atl.getPopup().getContent()) : '';
    out.badge = (document.getElementById('tm-badge-htm') || {}).textContent || '';
    return out;
  });
  ok('turning the pill on opens the picker', r.modalOpen);
  ok('TRAVEL closes it and lights the pill',
     r.mode === 'ftm' && r.pillLit && r.modalClosed);
  ok('every reporting station is a dot', r.count === 3, String(r.count));
  ok('a day that ran +6 wears the hot orange', r.hot);
  ok('a day that ran -10 wears the deep blue', r.cold);
  ok('a station with no normal is honest gray', r.gray);
  ok('the popup is the full day: high, low, rain, snow, departure, station',
     /94°/.test(r.popup) && /71°/.test(r.popup) && /0\.00"/.test(r.popup)
     && /\+6°F/.test(r.popup) && /USW0001/.test(r.popup)
     && /ATLANTA/.test(r.popup), r.popup.slice(0, 140));
  ok('the standing badge says the map is in the past',
     /PAST WEATHER/.test(r.badge) && /2025-09-01/.test(r.badge), r.badge);
}

console.log('\n3. the switcher, the climate machine, and off');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // Switch the dots to rain without refetching.
    _htmVar = 'rain'; _htmRender();
    const rainHtml = _htmLayer.getLayers().map(l => l.options.icon.options.html);
    out.rain = rainHtml.some(x => x.includes('1.25"'));
    // The climate machine takes over: same date, dots become the NORMALS.
    toggleOverlayPill('ctm');
    await new Promise(res => setTimeout(res, 900));
    out.ftmOff = !document.getElementById('op-ftm').classList.contains('active');
    out.ctmOn = document.getElementById('op-ctm').classList.contains('active');
    out.mode = _htmMode;
    const html = (_htmLayer ? _htmLayer.getLayers() : []).map(l => l.options.icon.options.html);
    // The dot shows the 88 normal, still colored by how the real day ran.
    out.normalDot = html.some(x => x.includes('88°') && x.includes('#ff6a00'));
    // Only stations with a normal can be drawn here.
    out.count = html.length;
    // Rain has no daily normal, so its chip sits this mode out.
    _htmOpenModal();
    const chips = [...document.querySelectorAll('.htm-varchip')];
    out.rainDisabled = chips.some(c => c.textContent === 'RAIN' && c.disabled);
    _htmCloseModal();
    // And off is off.
    toggleOverlayPill('ctm');
    out.offMode = _htmMode;
    out.layerGone = _htmLayer === null;
    out.badgeGone = !document.getElementById('tm-badge-htm');
    return out;
  });
  ok('the switcher redraws rain from what is already fetched', r.rain);
  ok('the climate machine replaces the forecast one',
     r.ftmOff && r.ctmOn && r.mode === 'ctm');
  ok('its dots are the normals, still colored by the real departure',
     r.normalDot);
  ok('only stations that publish a normal appear', r.count === 2, String(r.count));
  ok('rain sits out the climate machine, with its chip disabled', r.rainDisabled);
  ok('off means off: mode, layer and badge all gone',
     r.offMode === null && r.layerGone && r.badgeGone);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
