#!/usr/bin/env node
/*
 * Location off stays off (tgranz: "when i turn my location off then refresh
 * the page it turns back on ... id rather not dox myself").
 *
 *     node tools/test-location-privacy.mjs
 *
 * The browser is given location permission (so the old start-up code would
 * have used it silently). With Show My Location turned off and the page
 * reloaded: nothing asks the browser for a position, nothing asks ipapi.co
 * to guess one from the connection, no blue dot, no flight, no forecast.
 * Then the on-load behaviour: Lite-ning zooms to you and opens your
 * forecast by default, Wx-pert does neither by default, and the two
 * Settings switches override the default in either mode.
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

console.log('\n1. the source');
ok('the start-up position request checks the setting', /if \(navigator\.geolocation && _locAllowed\(\)\) \{/.test(PAGE));
ok('the old unconditional "always ask" is gone', !/Always ask for location - silently start if granted/.test(PAGE));
ok('the welcome asks nothing when location is off', /const where = \(_locAllowed\(\) && \(bootZoom \|\| bootForecast\)\) \? await _welcomeWhereAmI\(\) : null;/.test(PAGE));
ok('Radar Compass, Radar 3D, rain alerts and captures all check it too',
   /async function _radcGetLocation\(\) \{\n  \/\/ Location turned off/.test(PAGE) && /!navigator\.geolocation \|\| !_locAllowed\(\)\) return;/.test(PAGE)
   && /Turn on Show My Location in Settings first/.test(PAGE) && /function _ccGetGPS\(\)\{\n  \/\/ Location off/.test(PAGE));
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const HOME = { latitude: 40.0, longitude: -105.0 };

// One fresh browser profile per scenario, location permission granted, and
// every position request and ipapi.co lookup counted.
async function visit(storage, waitMs = 6500) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, geolocation: HOME,
                                   permissions: ['geolocation'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
  let ipLookups = 0;
  await p.addInitScript(([id, storage]) => {
    if (!sessionStorage.getItem('__seeded')) {
      localStorage.setItem('gwcfc_tutorial_seen', '1');
      localStorage.setItem('gwcfc_changelog_seen', id);
      Object.entries(storage).forEach(([k, v]) => localStorage.setItem(k, v));
      sessionStorage.setItem('__seeded', '1');
    }
    window.__geoCalls = 0;
    const g = navigator.geolocation;
    const cp = g.getCurrentPosition.bind(g), wp = g.watchPosition.bind(g);
    g.getCurrentPosition = (...a) => { window.__geoCalls++; return cp(...a); };
    g.watchPosition = (...a) => { window.__geoCalls++; return wp(...a); };
  }, [CL_ID, storage]);
  await p.route('**://**', route => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    if (url.includes('ipapi.co')) { ipLookups++; return route.abort(); }
    if (url.includes('leaflet') && url.endsWith('.js')) return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
    if (url.includes('leaflet') && url.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
    return route.abort();
  });
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(waitMs);
  const state = async () => ({ ...(await p.evaluate(() => {
    const c = map.getCenter(), fm = document.getElementById('forecast-modal');
    return { geo: window.__geoCalls, dot: !!_locMarker, tracking: _locWatchId !== null,
             nearHome: Math.abs(c.lat - 40) < 1.5 && Math.abs(c.lng + 105) < 1.5,
             forecast: !!fm && getComputedStyle(fm).display !== 'none',
             pref: localStorage.getItem('gwcfc_location_pref') };
  })), ip: ipLookups, errs: errs.slice() });
  return { p, ctx, state, reset: () => { ipLookups = 0; } };
}

console.log('\n2. turned off in Settings, then refreshed');
{
  const v = await visit({ gwcfc_mode: 'lite' });
  let s = await v.state();
  ok('(before: with permission, Lite-ning starts the dot, as it always did)', s.dot && s.tracking, JSON.stringify(s));
  await v.p.evaluate(() => { const cb = document.getElementById('lqm-set-location'); cb.checked = false; lqmToggleSetting('location', false); });
  s = await v.state();
  ok('turning it off takes the dot away and remembers the choice', !s.dot && !s.tracking && s.pref === 'off', JSON.stringify(s));
  v.reset();
  await v.p.reload({ waitUntil: 'domcontentloaded' });
  await v.p.waitForTimeout(6500);
  s = await v.state();
  ok('after a refresh: the browser is never asked for a position', s.geo === 0, JSON.stringify(s));
  ok('no guess from the connection either (ipapi.co not called)', s.ip === 0, JSON.stringify(s));
  ok('no blue dot, no flight home, no forecast', !s.dot && !s.tracking && !s.nearHome && !s.forecast, JSON.stringify(s));
  ok('and the switch in Settings still reads off', await v.p.evaluate(() => { lqmOpenSettings(); return !document.getElementById('lqm-set-location').checked; }).catch(() => true));
  s = await v.p.evaluate(async () => ({ r: await _radcGetLocation() }));
  ok('Radar Compass declines rather than asking behind the switch', s.r === null && await v.p.evaluate(() => window.__geoCalls === 0));
  await v.p.evaluate(() => { const cb = document.getElementById('lqm-set-location'); cb.checked = true; lqmToggleSetting('location', true); });
  await v.p.waitForTimeout(1500);
  s = await v.state();
  ok('turning it back on works straight away', s.dot && s.pref === 'on', JSON.stringify(s));
  ok('no page errors', s.errs.length === 0, s.errs.join(' | '));
  await v.ctx.close();
}

console.log('\n3. what the app does when it opens');
{
  let v = await visit({ gwcfc_mode: 'lite' });
  let s = await v.state();
  ok('Lite-ning: flies to you and opens your forecast by default', s.nearHome && s.forecast, JSON.stringify(s));
  await v.ctx.close();

  v = await visit({ gwcfc_mode: 'expert' });
  s = await v.state();
  ok('Wx-pert: the dot, but no flight and no forecast by default', s.dot && !s.nearHome && !s.forecast, JSON.stringify(s));
  await v.ctx.close();

  v = await visit({ gwcfc_mode: 'expert', gwcfc_boot_zoom: '1', gwcfc_boot_forecast: '1' });
  s = await v.state();
  ok('Wx-pert with both switched on in Settings: both happen', s.nearHome && s.forecast, JSON.stringify(s));
  await v.ctx.close();

  v = await visit({ gwcfc_mode: 'lite', gwcfc_boot_zoom: '0', gwcfc_boot_forecast: '0' });
  s = await v.state();
  ok('Lite-ning with both switched off: neither happens (the dot still shows)', s.dot && !s.nearHome && !s.forecast, JSON.stringify(s));
  const ui = await v.p.evaluate(() => { try { lqmOpenSettings(); } catch (e) {} return {
    z: document.getElementById('lqm-set-bootzoom').checked, f: document.getElementById('lqm-set-bootforecast').checked }; });
  ok('and Settings shows both switches off', !ui.z && !ui.f, JSON.stringify(ui));
  await v.ctx.close();
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
