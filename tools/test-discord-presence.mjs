#!/usr/bin/env node
/*
 * Discord Rich Presence: an opt-in Settings toggle that posts what's on
 * screen to a local bridge program (services/presence/), which is the
 * piece that actually talks to Discord.
 *
 *     node tools/test-discord-presence.mjs
 *
 * The bridge itself has its own tests (services/presence/test-presence-
 * bridge.mjs) against a fake Discord connection. This file only checks the
 * site's half: the setting is off by default, turning it on starts a
 * timer that POSTs a summary built from whatever layer, product and
 * overlays are actually active, and turning it off (or never turning it
 * on) leaves every request unsent.
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
  ok('the settings toggle exists, unchecked by default',
     /<input type="checkbox" id="lqm-set-discordrp" onchange="lqmToggleSetting\('discordrp',this\.checked\)">/.test(PAGE)
     && !/<input type="checkbox" id="lqm-set-discordrp" checked/.test(PAGE));
  ok('it is wired into the shared settings dispatcher',
     /key === 'discordrp'/.test(PAGE)
     && /localStorage\.setItem\('gwcfc_discord_rp', val \? '1' : '0'\)/.test(PAGE)
     && /_presenceStart/.test(PAGE) && /_presenceStop/.test(PAGE));
  ok('a saved yes turns it on at boot, same as every other opt-in toggle',
     /localStorage\.getItem\('gwcfc_discord_rp'\)==='1'/.test(PAGE));
  ok('the bridge URL points at the documented default port',
     /const _PRESENCE_BRIDGE_URL = 'http:\/\/127\.0\.0\.1:32473\/update';/.test(PAGE));
  ok('the summary builder and the start/stop timer functions exist',
     /function _presenceSummary\(\)/.test(PAGE)
     && /function _presenceStart\(\)/.test(PAGE)
     && /function _presenceStop\(\)/.test(PAGE));
  ok('the alerts entry names the pill people actually see ("Alert Polygons"), reading the same '
     + 'alertsLayerVisible switch that pill itself toggles, not the warning-type filters under it',
     /if \(typeof alertsLayerVisible !== 'undefined' && alertsLayerVisible\) overlays\.push\('Alert Polygons'\);/.test(PAGE)
     && !/tornado: 'Tornado Warnings'/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-discord-presence.mjs'), 'utf8').includes(EM));
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

// Every POST to the bridge's address is caught here instead of actually
// leaving the machine, standing in for the local presence-bridge program.
const posts = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.startsWith('http://127.0.0.1:32473/')) {
    posts.push({ url, body: route.request().postData() });
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  }
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

console.log('\n2. off by default, and off sends nothing');
{
  const r = await p.evaluate(() => (
    { timer: _presenceTimer, checked: document.getElementById('lqm-set-discordrp').checked }
  ));
  ok('the toggle is unchecked and no timer is running on a fresh load',
     r.checked === false && r.timer === null);
  ok('nothing has been posted on its own while the feature has never been turned on',
     posts.length === 0);
}

console.log('\n3. turning it on starts posting a summary of the actual view');
{
  const r = await p.evaluate(async () => {
    activeLayers.nexrad = true;
    currentProduct = 'ref';
    document.getElementById('lqm-set-discordrp').checked = true;
    lqmToggleSetting('discordrp', true);
    await new Promise(res => setTimeout(res, 200));
    return { timerRunning: _presenceTimer !== null, saved: localStorage.getItem('gwcfc_discord_rp') };
  });
  ok('the toggle starts the timer and remembers the choice', r.timerRunning === true && r.saved === '1');
  ok('turning it on immediately posts once, not waiting a full interval', posts.length === 1);
  const body = JSON.parse(posts[0].body);
  ok('the radar product and site make it into details',
     /^Radar: Reflectivity/.test(body.details), body.details);
  ok('active overlays make it into state, named the way the pill itself reads '
     + '("Alert Polygons", not the warning-type filters underneath it) - forecasts is on by default too',
     body.state.includes('Alert Polygons') && body.state.includes('City Temps'), body.state);
}

console.log('\n4. the summary follows what is actually active, not a fixed line');
{
  const r = await p.evaluate(async () => {
    activeLayers.nexrad = false;
    activeLayers.satellite = true;
    _goesProductId = 'ch13';
    alertsLayerVisible = false;
    // Every overlay this feature reads, off, to check the "nothing on" line.
    ['spc1', 'spc2', 'spc3', 'spcrpts',
     'nhc', 'invest', 'sst', 'models', 'lightning', 'ltg30', 'forecasts', 'radio',
     'cloudcam'].forEach(k => { activeLayers[k] = false; });
    await _presenceTick();
    return true;
  });
  ok('the tick actually ran', r === true);
  const body = JSON.parse(posts[posts.length - 1].body);
  ok('switching to satellite changes details to the satellite band',
     /^Satellite:/.test(body.details), body.details);
  ok('with every overlay off, state says so plainly',
     body.state === 'No overlays', body.state);
}

console.log('\n5. comparing, Radar 3D, and a single radar site each name themselves');
{
  const r = await p.evaluate(() => {
    const out = {};
    // A single radar site.
    activeLayers.satellite = false; activeLayers.nexrad = true;
    currentProduct = 'ref'; _refStation = 'ktlx';
    out.site = _presenceSummary().details;
    // Radar compare, in a grid.
    _rcOn = true;
    _rcSlots.push({ site: 'kama' }, { site: 'kfdr' });
    _rcGrid = { rows: 2, cols: 2 };
    out.rc = _presenceSummary().details;
    _rcGrid = null; _rcSlots.length = 0; _rcOn = false;
    // Satellite compare.
    activeLayers.nexrad = false; activeLayers.satellite = true;
    _goesProductId = 'ch13';
    const other = GOES_PRODUCTS.find(p => p.id !== 'ch13' && p.label);
    _scOn = true;
    _scSlots.push({ productId: other.id });
    out.otherLabel = other.label;
    out.sc = _presenceSummary().details;
    _scSlots.length = 0; _scOn = false;
    // Radar 3D outranks everything else on screen.
    _r3dOn = true; _r3dStation = 'ktlx';
    out.r3d = _presenceSummary().details;
    _r3dOn = false; _r3dStation = null;
    _refStation = null; activeLayers.satellite = false; activeLayers.nexrad = true;
    return out;
  });
  ok('a single radar site is named as the thing being viewed',
     /^Radar site KTLX:/.test(r.site), r.site);
  ok('a radar comparison lists every site, and says when it is a grid',
     r.rc === 'Comparing radar: KTLX vs KAMA vs KFDR in a 2x2 grid', r.rc);
  ok('a satellite comparison lists the products being compared',
     r.sc.startsWith('Comparing satellite: ')
     && r.sc.includes(' vs ') && r.sc.includes(r.otherLabel), r.sc);
  ok('Radar 3D wins over every other state and names the station',
     r.r3d === 'Radar 3D: orbiting a storm volume (KTLX)', r.r3d);
}

console.log('\n6. turning it back off stops the timer and the posting');
{
  const before = posts.length;
  const r = await p.evaluate(async () => {
    document.getElementById('lqm-set-discordrp').checked = false;
    lqmToggleSetting('discordrp', false);
    await new Promise(res => setTimeout(res, 200));
    return { timer: _presenceTimer, saved: localStorage.getItem('gwcfc_discord_rp') };
  });
  ok('the timer stops and the choice is remembered', r.timer === null && r.saved === '0');
  await p.waitForTimeout(300);
  ok('nothing new was posted after switching off', posts.length === before);
}

console.log('\n7. a bridge that is not running fails silently');
{
  await p.route('http://127.0.0.1:32473/**', route => route.abort('connectionrefused'));
  const r = await p.evaluate(async () => {
    let threw = false;
    try { await _presenceTick(); } catch (e) { threw = true; }
    return threw;
  });
  ok('a refused connection is swallowed, never thrown up to the caller', r === false);
  ok('and nothing on the page errored because of it', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
