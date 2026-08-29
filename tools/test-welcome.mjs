#!/usr/bin/env node
/*
 * The welcome: what a person gets when they close the tutorial.
 *
 *     node tools/test-welcome.mjs
 *
 * Closing the tutorial used to leave somebody looking at an empty map over
 * the middle of the country with every layer off. They now get their own
 * weather: the map flies to them, the 1 km MRMS composite comes on, and the
 * forecast for where they are opens over it.
 *
 * The things worth checking rather than clicking through by hand:
 *
 *   1. IT MUST NOT FIRE ON A REGULAR. The tutorial can be reopened from the
 *      menu, and rearranging the map of somebody rereading a section would be
 *      the app arguing with them. Section 3 opens it the manual way and
 *      demands nothing happens.
 *   2. A SAVED PRESET WINS. Saving a layer preset is a person saying how they
 *      want the map. Overriding that is the one behaviour here that would be
 *      actively wrong, and section 4 checks it.
 *   3. A REFUSED LOCATION PROMPT STILL WORKS. Asking is a real question and
 *      the answer may be no. Section 5 refuses it and checks the welcome
 *      falls back rather than giving up, and section 6 checks that with both
 *      sources gone it says so instead of silently doing half the job.
 *   4. IT RUNS ONCE. Sections 2 and 7.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('playwright is not installed, skipping. npm i playwright');
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  // The rough-location fallback, answered here so the test never touches the
  // network. Sections that want it gone override this from the page.
  if (url.includes('ipapi.co'))
    return route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ latitude: 35.47, longitude: -97.52,
                             city: 'Oklahoma City', region_code: 'OK' }) });
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// Everything the welcome touches, recorded rather than really run: the map
// must not actually fly and MRMS must not really be fetched for a test to
// know whether they were asked to.
const arm = (opts = {}) => page.evaluate((o) => {
  window.__w = { flew: null, composite: 0, forecast: null, toasts: [] };
  _welcomeRan = false;
  _tutAutoOpened = false;
  _currentUser = o.signedIn ? { uid: 'u1', displayName: 'Test' } : null;
  _aiSyncProfileData = o.profile || {};
  _lastGpsPos = o.gps
    ? { coords: { latitude: o.gps[0], longitude: o.gps[1], accuracy: 20 } } : null;
  activeLayers.nexrad = false;
  currentProduct = 'ref';

  map.flyTo = (ll, z) => { window.__w.flew = { lat: ll[0], lon: ll[1], zoom: z }; };
  window._loadMrmsComposite = () => { window.__w.composite++; };
  window.openForecastModal = (c) => { window.__w.forecast = c; };
  window.showToast = (m) => { window.__w.toasts.push(m); };
  // Geolocation is replaced wholesale: a headless browser has no real one,
  // and each section needs a different answer out of it.
  navigator.geolocation.getCurrentPosition = (okCb, errCb) => {
    if (o.geo === 'grant') return okCb({ coords: { latitude: 32.78, longitude: -96.80, accuracy: 15 } });
    if (o.geo === 'deny') return errCb ? errCb({ code: 1, message: 'denied' }) : null;
    /* 'hang' answers neither, which is a real device behaviour */
  };
}, opts);

const result = () => page.evaluate(() => window.__w);

console.log('\n1. the pieces are wired up');
{
  ok('no page errors on boot', errors.length === 0, errors[0]);
  const r = await page.evaluate(() => ({
    fns: ['_runWelcome', '_welcomeWhereAmI', '_welcomeHasSavedPreset',
          'closeTutorial', 'openTutorial'].filter(n => typeof window[n] !== 'function'),
    flag: typeof _tutAutoOpened,
  }));
  ok('every welcome function is defined', r.fns.length === 0, r.fns.join(','));
  ok('and the auto-open flag exists', r.flag === 'boolean', r.flag);
}

console.log('\n2. closing the auto-opened tutorial gives them their weather');
{
  await arm({ geo: 'grant' });
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  await page.waitForTimeout(2600);
  const r = await result();
  ok('the 1 km composite is switched on', r.composite === 1, String(r.composite));
  ok('the map flies to them', !!r.flew && Math.abs(r.flew.lat - 32.78) < 0.01,
     JSON.stringify(r.flew));
  ok('at a zoom that shows a metro area, not a continent',
     r.flew && r.flew.zoom >= 7 && r.flew.zoom <= 10, String(r.flew && r.flew.zoom));
  ok('and the forecast opens for that same point',
     r.forecast && Math.abs(r.forecast.lat - 32.78) < 0.01, JSON.stringify(r.forecast));
  const state = await page.evaluate(() => ({
    nexrad: activeLayers.nexrad, product: currentProduct,
    // The menu's own elements, so this checks the app agrees with itself
    // rather than that a particular line of code ran.
    radarBubble: document.getElementById('sub-radar')?.classList.contains('active'),
    // The radar sub-row is built on demand, so this element does not exist
    // until somebody opens that menu. Marking it has to be conditional, and
    // the test says so rather than demanding an element that is not there.
    mrmsBubbleExists: !!document.getElementById('sub-mrms'),
  }));
  ok('the radar layer really is on, not just requested', state.nexrad === true);
  ok('with MRMS as the product', state.product === 'mrms', state.product);
  ok('the radar bubble is lit, so the menu agrees with the map',
     state.radarBubble === true, String(state.radarBubble));
  ok('and the sub-row is left to build itself when opened',
     state.mrmsBubbleExists === false, String(state.mrmsBubbleExists));
}

console.log('\n3. it does NOT fire when a regular opens the tutorial themselves');
{
  await arm({ geo: 'grant' });
  // The menu path: openTutorial without the app setting the flag.
  await page.evaluate(() => { openTutorial(); closeTutorial(); });
  await page.waitForTimeout(1200);
  const r = await result();
  ok('nothing is loaded', r.composite === 0, String(r.composite));
  ok('the map is not moved', r.flew === null, JSON.stringify(r.flew));
  ok('and no panel is put in front of them', r.forecast === null,
     JSON.stringify(r.forecast));
}

console.log('\n4. a signed-in account with a saved preset is left alone');
{
  await arm({ signedIn: true, geo: 'grant',
              profile: { savedLayers: { nexrad: false, satellite: true } } });
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  await page.waitForTimeout(1200);
  const r = await result();
  // Saving a preset is somebody saying how they want the map. Overriding it
  // is the one thing here that would be actively wrong.
  ok('their saved layers are not overridden', r.composite === 0, String(r.composite));
  ok('and their view is not moved', r.flew === null, JSON.stringify(r.flew));
  const has = await page.evaluate(() => _welcomeHasSavedPreset());
  ok('the preset is recognised as a preset', has === true, String(has));
}

console.log('\n4b. signed in WITHOUT a preset still gets the welcome');
{
  await arm({ signedIn: true, geo: 'grant', profile: { displayName: 'Test' } });
  const has = await page.evaluate(() => _welcomeHasSavedPreset());
  ok('an account that has saved nothing has no preset', has === false, String(has));
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  await page.waitForTimeout(2600);
  const r = await result();
  ok('so they are treated like anyone who has not chosen', r.composite === 1,
     String(r.composite));
  ok('and get the forecast too', !!r.forecast, JSON.stringify(r.forecast));
}

console.log('\n4c. an empty saved-layers object is not an instruction');
{
  const has = await page.evaluate(() => {
    _currentUser = { uid: 'u1' };
    _aiSyncProfileData = { savedLayers: {} };
    return _welcomeHasSavedPreset();
  });
  ok('an empty preset written by an older build does not count',
     has === false, String(has));
}

console.log('\n5. a refused location prompt falls back rather than giving up');
{
  await arm({ geo: 'deny' });
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  await page.waitForTimeout(3000);
  const r = await result();
  ok('the radar still comes on', r.composite === 1, String(r.composite));
  // The rough location served by the route handler above: Oklahoma City.
  ok('and a rough location carries the forecast',
     r.forecast && Math.abs(r.forecast.lat - 35.47) < 0.05, JSON.stringify(r.forecast));
  ok('named as a place rather than as coordinates',
     r.forecast && /Oklahoma City/.test(r.forecast.name), r.forecast && r.forecast.name);
}

console.log('\n5b. a prompt that never answers does not hang the welcome');
{
  await arm({ geo: 'hang' });
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  // Longer than the internal timeout, shorter than forever.
  await page.waitForTimeout(11000);
  const r = await result();
  ok('it times out and carries on', r.composite === 1, String(r.composite));
  ok('with the rough location', !!r.forecast, JSON.stringify(r.forecast));
}

console.log('\n6. with no location at all it says so instead of half working');
{
  // Kill the fallback too, so neither source can answer.
  await page.route('**ipapi.co**', route => route.abort());
  await arm({ geo: 'deny' });
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  await page.waitForTimeout(3000);
  const r = await result();
  ok('the radar is still switched on, which is most of the value',
     r.composite === 1, String(r.composite));
  ok('no forecast is invented for a place it does not know',
     r.forecast === null, JSON.stringify(r.forecast));
  ok('and it says why, plus what to do about it',
     r.toasts.some(t => /location|search/i.test(t)), r.toasts.join(' | '));
  await page.unroute('**ipapi.co**');
}

console.log('\n7. it runs once, not once per close');
{
  await arm({ geo: 'grant' });
  await page.evaluate(() => {
    _tutAutoOpened = true; closeTutorial();
    _tutAutoOpened = true; closeTutorial();
    _tutAutoOpened = true; closeTutorial();
  });
  await page.waitForTimeout(2600);
  const r = await result();
  ok('three closes load the composite once', r.composite === 1, String(r.composite));
}

console.log('\n8. an existing GPS fix is used rather than asking again');
{
  await arm({ gps: [40.71, -74.01], geo: 'deny' });
  await page.evaluate(() => { _tutAutoOpened = true; closeTutorial(); });
  await page.waitForTimeout(2600);
  const r = await result();
  // Location tracking already on means the answer is already known, and
  // asking a second time would be a prompt for something already granted.
  ok('the fix already in hand is what is used',
     r.forecast && Math.abs(r.forecast.lat - 40.71) < 0.01, JSON.stringify(r.forecast));
  ok('even though the prompt would have been refused',
     r.flew && Math.abs(r.flew.lat - 40.71) < 0.01, JSON.stringify(r.flew));
}

console.log('\n9. screenshot mode is left alone');
{
  await arm({ geo: 'grant' });
  await page.evaluate(() => {
    document.body.classList.add('shot-mode');
    _tutAutoOpened = true; closeTutorial();
  });
  await page.waitForTimeout(1200);
  const r = await result();
  // A headless capture has empty storage, so it is always a first visit, and
  // a forecast panel over every shot is not what the shots are for.
  ok('no welcome runs during a capture', r.composite === 0, String(r.composite));
  await page.evaluate(() => document.body.classList.remove('shot-mode'));
}

console.log('\n10. nothing threw along the way');
ok('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
