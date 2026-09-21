#!/usr/bin/env node
/*
 * ?shot=1 (body.shot-mode) hides the whole interface, not just the parts
 * that happen to hang directly off <body>. #map-compass, #right-menu, the
 * draw/measure/polygon toolbars, the GPS and nav HUDs and a dozen other
 * controls are all direct children of #map-wrap, right alongside #map
 * itself, so the earlier body-level catch-all never touched them - a bot
 * screenshot taken with ?shot=1 still showed them.
 *
 *     node tools/test-shot-mode-gui.mjs
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

console.log('\n1. the map-wrap catch-all is in the page');
{
  ok('every direct child of #map-wrap except #map is hidden in shot-mode',
     /body\.shot-mode #map-wrap > div:not\(#map\) \{[\s\S]{0,60}?display: none !important;/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-shot-mode-gui.mjs'), 'utf8').includes(EM));
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
const errs = [];

const p = await b.newPage({ viewport: { width: 1000, height: 640 } });
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
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
// Same pattern the other shot-mode tests use: the class is what the CSS
// keys off, and setting it directly sidesteps needing real tile network to
// reach the readiness flag this sandbox has no route to.
await p.evaluate(() => document.body.classList.add('shot-mode'));

console.log('\n2. a ?shot=1 load actually hides the interface');
{
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(() => {
    const vis = id => {
      const el = document.getElementById(id);
      if (!el) return 'missing';
      return getComputedStyle(el).display;
    };
    return {
      main: vis('main'),
      map: vis('map'),
      rightMenu: vis('right-menu'),
      compass: vis('map-compass'),
      subBubbles: vis('sub-bubbles'),
      drawToolbar: vis('draw-toolbar'),
      modelInfo: vis('model-info'),
      recenter: vis('recenter-float'),
    };
  });
  ok('#main (holding the map) stays visible', r.main !== 'none', JSON.stringify(r));
  ok('#map itself stays visible', r.map !== 'none', JSON.stringify(r));
  ok('#right-menu (the right-edge tool icons) is hidden', r.rightMenu === 'none', JSON.stringify(r));
  ok('#map-compass is hidden', r.compass === 'none', JSON.stringify(r));
  ok('#sub-bubbles is hidden', r.subBubbles === 'none', JSON.stringify(r));
  ok('#draw-toolbar is hidden', r.drawToolbar === 'none', JSON.stringify(r));
  ok('#model-info is hidden', r.modelInfo === 'none', JSON.stringify(r));
  ok('#recenter-float is hidden', r.recenter === 'none', JSON.stringify(r));
}

await p.close();

console.log('\n3. a shot shows ONLY what its link asks for');
{
  // The Discord bot's screenshots carried the app's friendly first-run
  // defaults on top of the requested layer: city temperatures, alert
  // polygons and the surface fronts, whatever the question was. Each boot
  // here is a fresh page on a real ?shot URL, checked after the readiness
  // flag the screenshot tool itself waits on.
  const boot = async (qs) => {
    const pg = await b.newPage({ viewport: { width: 1000, height: 640 } });
    pg.on('pageerror', e => errs.push(String(e).slice(0, 180)));
    await pg.addInitScript(() => {
      try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
    });
    await pg.route('**://**', route => {
      const url = route.request().url();
      if (url.startsWith('file://')) return route.continue();
      if (url.includes('leaflet') && url.endsWith('.js'))
        return route.fulfill({ contentType: 'application/javascript',
          body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
      if (url.includes('leaflet') && url.endsWith('.css'))
        return route.fulfill({ contentType: 'text/css',
          body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
      return route.abort();
    });
    await pg.goto('file://' + join(ROOT, 'index.html') + qs, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => document.body.dataset.shotReady === '1',
      { timeout: 30000 }).catch(() => {});
    await pg.waitForTimeout(1200);
    const r = await pg.evaluate(() => ({
      forecasts: activeLayers.forecasts,
      tornado: activeLayers.tornado,
      fronts: !!document.querySelector('.ov-pill[data-ovid="fronts"].active'),
      cityMarkers: (typeof cityMarkersLayer !== 'undefined' && cityMarkersLayer)
        ? cityMarkersLayer.getLayers().length : -1,
      alertsPane: (() => { const pn = map.getPane('alertsPane');
        return pn ? pn.style.display !== 'none' : null; })(),
      ready: document.body.dataset.shotReady === '1',
    }));
    await pg.close();
    return r;
  };

  const sst = await boot('?shot=1&lat=25&lon=-60&z=4&waves=sst');
  ok('a sea-temperature shot carries no city temps, no alerts, no fronts',
     sst.ready && sst.forecasts === false && sst.cityMarkers === 0
     && sst.tornado === false && sst.fronts === false && sst.alertsPane === false,
     JSON.stringify(sst));

  const al = await boot('?shot=1&lat=35&lon=-97&z=5&overlays=alerts');
  ok('asking for alerts keeps the polygons and their categories, nothing else',
     al.tornado === true && al.alertsPane === true
     && al.forecasts === false && al.cityMarkers === 0 && al.fronts === false,
     JSON.stringify(al));

  const fc = await boot('?shot=1&lat=35&lon=-97&z=5&layers=forecasts');
  ok('asking for the city temperatures keeps them',
     fc.forecasts === true && fc.cityMarkers > 0, JSON.stringify(fc));

  const deep = await boot('?lat=35&lon=-97&z=5');
  ok('a plain deep link (no shot) leaves the friendly defaults alone',
     deep.forecasts === true && deep.tornado === true && deep.fronts === true
     && deep.cityMarkers > 0, JSON.stringify(deep));

  ok('nothing threw across the boots', errs.length === 0, errs.slice(0, 3).join(' | '));

  // The dials the Discord bot's new options ride on: the URL must reach the
  // page's own state, or the bot would post the day-1 categorical picture
  // whatever was asked for.
  const dial = async (qs, read) => {
    const pg = await b.newPage({ viewport: { width: 1000, height: 640 } });
    pg.on('pageerror', e => errs.push(String(e).slice(0, 180)));
    await pg.addInitScript(() => {
      try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
    });
    await pg.route('**://**', route => {
      const url = route.request().url();
      if (url.startsWith('file://')) return route.continue();
      if (url.includes('leaflet') && url.endsWith('.js'))
        return route.fulfill({ contentType: 'application/javascript',
          body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
      if (url.includes('leaflet') && url.endsWith('.css'))
        return route.fulfill({ contentType: 'text/css',
          body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
      return route.abort();
    });
    await pg.goto('file://' + join(ROOT, 'index.html') + qs, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(4200);
    const r = await pg.evaluate(read);
    await pg.close();
    return r;
  };

  console.log('\n4. the bot\'s dials reach the page state');
  const spc = await dial('?shot=1&lat=38&lon=-97&z=5&overlays=spc-outlook&spcday=3&spchaz=wind',
    () => ({ day: _spcDay, haz: _spcHazard }));
  ok('spcday=3&spchaz=wind lands on day 3, wind view',
     spc.day === 3 && spc.haz === 'wind', JSON.stringify(spc));

  const days = await dial('?shot=1&lat=38&lon=-97&z=5&overlays=wpc-outlook,fire-outlook&wpcday=2&fwday=2',
    () => ({ wpc: _wpcDay, fw: _fwDay }));
  ok('wpcday and fwday land on their days',
     days.wpc === 2 && days.fw === 2, JSON.stringify(days));

  const cpc = await dial('?shot=1&lat=38&lon=-97&z=5&overlays=cpc-outlook&cpctype=8_14_prcp',
    () => ({ t: _cpcType }));
  ok('cpctype lands on the 8-14 day precipitation outlook',
     cpc.t === '8_14_prcp', JSON.stringify(cpc));

  const reg = await dial('?shot=1&lat=40&lon=-120&z=5&layers=satellite&satproduct=ch13&satregion=west',
    () => ({ region: _goesRegionId, product: _goesProductId }));
  ok('satregion=west aims the satellite at West CONUS',
     reg.region === 'west' && reg.product === 'ch13', JSON.stringify(reg));

  const junk = await dial('?shot=1&lat=38&lon=-97&z=5&spcday=99&spchaz=lava&satregion=moon&cpctype=nope',
    () => ({ day: _spcDay, haz: _spcHazard, region: _goesRegionId, t: _cpcType }));
  ok('nonsense values are ignored, defaults stand',
     junk.day === 1 && junk.haz === 'cat' && junk.region === 'auto'
     && junk.t === '6_10_temp', JSON.stringify(junk));

  ok('nothing threw across the dial boots', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
