#!/usr/bin/env node
/*
 * Satellite sectors: one tap, and you see it (tester: "selecting a region is
 * slow and glitchy; requires selecting the region several times in a row").
 *
 *     node tools/test-sat-region.mjs
 *
 * Picking a sector loaded its imagery but never moved the map, so from over
 * the lower 48 a Hawaii, Alaska or Meso sector drew off screen and the tap
 * looked like it had done nothing. Now a sector the map is not looking at
 * takes the map to it (the Meso boxes' position read from the satellite's
 * own capabilities), and a sector tapped with the satellite off turns it on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

// A capabilities answer with every sector of channel 13 in it, and Meso 1
// parked over Oklahoma today.
const chans = ['13', '02', '09', '08', '07', '14', '10', '01', '03', '04', '05', '06', '11', '12', '15', '16'];
const layer = (name, b) => `<Layer queryable="1"><Name>${name}</Name><Title>${name}</Title><LatLonBoundingBox minx="${b[0]}" miny="${b[1]}" maxx="${b[2]}" maxy="${b[3]}"/></Layer>`;
const caps = (w) => `<?xml version="1.0"?><WMT_MS_Capabilities><Capability><Layer>` + chans.map(c =>
  layer(`conus_ch${c}`, [-125, 20, -60, 52]) + layer(`fulldisk_ch${c}`, [-180, -80, 0, 80])
  + layer(`meso1_ch${c}`, [-101, 32, -94, 38]) + layer(`meso2_ch${c}`, [-90, 25, -83, 31])
  + (w ? layer(`alaska_ch${c}`, [-180, 50, -128, 72]) + layer(`hawaii_ch${c}`, [-166, 14, -148, 27]) : layer(`puertorico_ch${c}`, [-82, 9, -57, 27]))
).join('') + `</Layer></Capability></WMT_MS_Capabilities>`;

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  if (/GetCapabilities/i.test(u)) return r.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/xml', body: caps(/goes_west/.test(u)) });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);

const tap = (label) => p.evaluate(async (label) => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const btn = [...document.querySelectorAll('#sat-region-row .sat-region-btn')].find(x => x.textContent === label);
  if (!btn) return { missing: [...document.querySelectorAll('#sat-region-row .sat-region-btn')].map(x => x.textContent) };
  btn.click();
  await wait(1400);
  const c = map.getCenter();
  return { region: _goesRegionId, on: !!activeLayers.satellite, lat: c.lat, lng: c.lng,
           active: document.querySelector('#sat-region-row .sat-region-btn.active')?.textContent };
}, label);

await p.evaluate(async () => {
  map.setView([39, -97], 5, { animate: false });
  _goesProductId = GOES_PRODUCTS.find(x => x.ch === 'ch13')?.id || _goesProductId;
  toggleSatelliteSub();
  await new Promise(res => setTimeout(res, 1200));      // capabilities answer
});
let r = await tap('Hawaii');
ok('one tap on Hawaii, with the satellite off: it comes on', r.on && r.region === 'hawaii' && r.active === 'Hawaii', JSON.stringify(r));
ok('and the map goes to Hawaii', r.lat > 14 && r.lat < 27 && r.lng > -166 && r.lng < -148, JSON.stringify(r));
r = await tap('E. Meso 1');
ok('Meso 1 takes the map to where that box is today (Oklahoma here)', r.region === 'emeso1' && r.lat > 32 && r.lat < 38 && r.lng > -101 && r.lng < -94, JSON.stringify(r));
r = await tap('East CONUS');
ok('East CONUS from Oklahoma: already in view, so the map stays put', r.region === 'east' && r.lat > 32 && r.lat < 38, JSON.stringify(r));
r = await tap('E. Full Disk');
ok('a full disk never moves the map', r.region === 'efulldisk' && r.lat > 32 && r.lat < 38, JSON.stringify(r));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
