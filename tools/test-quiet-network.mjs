#!/usr/bin/env node
/*
 * The app stops making requests it does not need.
 *
 *     node tools/test-quiet-network.mjs
 *
 * A tester's network tab showed the page never going quiet: the parsing
 * server's address read every five seconds, both alert feeds every minute,
 * zones asked for by guessing their type (404s), and failed zones retried on
 * every refresh. Each is checked here with fetch replaced by a counter.
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
ok('the parsing server address is read once a minute, not every five seconds', /const HD_WATCH_MS = 60 \* 1000;/.test(PAGE));

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
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const real = window.fetch;
  let log = [], mode = 'ok';
  const square = { type: 'Polygon', coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 41], [-100, 40]]] };
  window.fetch = async (url) => {
    url = String(url); log.push(url);
    if (mode === 'down') throw new TypeError('network');
    if (/\/zones\//.test(url)) return new Response(JSON.stringify({ geometry: square }), { status: 200 });
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  };
  const out = {};
  // 1. A fire zone named in affectedZones is fetched at that address only.
  const f = { geometry: null, properties: { geocode: { UGC: ['NVZ421'] },
    affectedZones: ['https://api.weather.gov/zones/fire/NVZ421'] } };
  await _fillMissingAlertGeometry([f]);
  out.fireUrls = log.slice(); out.fireShape = !!f.geometry;
  // 2. A failed zone is not asked again on the next refresh.
  log = []; mode = 'down';
  const g = () => ({ geometry: null, properties: { geocode: { UGC: ['KSZ999'] } } });
  await _fillMissingAlertGeometry([g()]);
  out.firstTry = log.length;
  log = [];
  await _fillMissingAlertGeometry([g()]);
  out.secondTry = log.length;
  // 3. The expired-alert list is read once per five minutes, the live one every time.
  mode = 'ok'; log = [];
  _alertsPastAt = 0; _alertsPastCache = null;
  await _doLoadAlerts(false);
  await _doLoadAlerts(false);
  await _doLoadAlerts(false);
  out.active = log.filter(u => /alerts\/active/.test(u)).length;
  out.past = log.filter(u => /\/alerts\?/.test(u)).length;
  window.fetch = real;
  return out;
});
ok('a fire zone is fetched at the address the alert gives, with no forecast-zone 404 first',
   r.fireUrls.length === 1 && r.fireUrls[0] === 'https://api.weather.gov/zones/fire/NVZ421' && r.fireShape, JSON.stringify(r));
ok('a zone that failed is left alone on the next refresh', r.firstTry > 0 && r.secondTry === 0, JSON.stringify(r));
ok('the live alert list is read every refresh, the expired list only once in five minutes',
   r.active === 3 && r.past === 1, JSON.stringify(r));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
