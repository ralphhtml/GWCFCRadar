#!/usr/bin/env node
/*
 * Clicking an alert polygon opens its popup, even under other canvases.
 *
 *     node tools/test-alert-click.mjs
 *
 * History: the city temperature dots moved onto one shared canvas for
 * performance, and that canvas lives in an overlay pane ABOVE the alerts
 * pane. A Leaflet canvas renderer is one element covering the whole view
 * and it takes every click on it, not only clicks on its own shapes - so
 * with city dots on (the default), a tap on an alert polygon died on the
 * dot canvas and no popup opened, anywhere. The fix teaches every canvas
 * renderer to hand a click it has no interactive layer under to whatever
 * map layer sits beneath it, and to stop the original event when the
 * receiver stops the forwarded one, so the map's click-closes-popups
 * behaviour cannot immediately undo the popup that just opened.
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

console.log('\n1. the fall-through is in the page');
{
  ok('the canvas renderer is patched before any renderer exists',
     /function _canvasClickFallthrough\(\)/.test(PAGE)
     && /L\.Canvas\.prototype\._onClick = function \(e\)/.test(PAGE));
  ok('a stopped forwarded click stops the original, so popups survive',
     /if \(clone\.defaultPrevented\) L\.DomEvent\.stop\(e\);/.test(PAGE));
  ok('it only forwards to real map layers beneath',
     /under\.closest\('\.leaflet-pane'\)/.test(PAGE)
     && /under\.tagName === 'CANVAS' \|\| under instanceof SVGElement/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-alert-click.mjs'), 'utf8').includes(EM));
}

console.log('\n1b. the polygons wear the NWS\'s own colours');
{
  // Hex for hex from the WWA colour table behind the weather.gov map, so
  // this map and the NWS's agree at a glance. The five most-looked-at:
  const want = {
    "'Tornado Warning':": '#ff0000',
    "'Tornado Watch':": '#ffff00',
    "'Severe Thunderstorm Warning':": '#ffa500',
    "'Flash Flood Warning':": '#8b0000',
    "'Winter Storm Warning':": '#ff69b4',
  };
  const bad = Object.entries(want).filter(([k, hex]) =>
    !new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + "\\s*\\{ color: '" + hex + "'").test(PAGE)).map(([k]) => k);
  ok('tornado red, tornado watch yellow, SVR orange, flash flood dark red, winter storm pink',
     bad.length === 0, bad.join(' '));
  ok('the specific name always outranks the one it contains',
     PAGE.indexOf("'Hard Freeze Warning':") < PAGE.indexOf("'Freeze Warning':")
     && PAGE.indexOf("'Tropical Storm Warning':") < PAGE.indexOf("'Storm Warning':"));
  ok('the renamed products of 2025 are in the table beside the old names',
     /'Extreme Heat Warning':/.test(PAGE) && /'Cold Weather Advisory':/.test(PAGE)
     && /'Extreme Cold Warning':/.test(PAGE));
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
await p.waitForTimeout(4500);
// The What Changed card greets a first visit and sits over the map, and this
// suite clicks with a real mouse, so it is dismissed the way a person would.
await p.evaluate(() => {
  const m = document.getElementById('changelog-modal');
  if (m && m.classList.contains('open')) {
    const btn = m.querySelector('button');
    if (btn) btn.click(); else m.classList.remove('open');
  }
});
await p.waitForTimeout(300);

// One synthetic tornado warning through the real render path, plus a city
// dot canvas covering the same spot, which is the exact live arrangement
// that used to swallow the click.
const setup = await p.evaluate(() => {
  map.setView([35, -97], 7, { animate: false });
  const c = map.getCenter();
  const d = 1.2;
  activeLayers.tornado = true;
  renderAlerts([{
    type: 'Feature', id: 'test-alert-1',
    properties: {
      id: 'test-alert-1', event: 'Tornado Warning',
      headline: 'Tornado Warning until 5:00 PM',
      severity: 'Extreme', urgency: 'Immediate', areaDesc: 'Test County',
      senderName: 'NWS Test', description: 'A TEST WARNING.',
      effective: new Date().toISOString(),
      expires: new Date(Date.now() + 3600000).toISOString(),
    },
    geometry: { type: 'Polygon', coordinates: [[
      [c.lng - d, c.lat - d], [c.lng + d, c.lat - d],
      [c.lng + d, c.lat + d], [c.lng - d, c.lat + d],
      [c.lng - d, c.lat - d]]] },
  }]);
  // The city-dot canvas, with one dot away from where the click lands.
  window.__cityClicked = 0;
  const dot = makeCityMarker({ name: 'Testville', lat: c.lat + 0.9, lng: c.lng + 0.9,
                               lon: c.lng + 0.9 }, 72);
  dot.off('click');
  dot.on('click', () => { window.__cityClicked++; });
  dot.addTo(map);
  const dotPane = map.getPane('ovp-forecasts-m');
  const alertsPane = map.getPane('alertsPane');
  const pt = map.latLngToContainerPoint(c);
  const dpt = map.latLngToContainerPoint([c.lat + 0.9, c.lng + 0.9]);
  const rect = map.getContainer().getBoundingClientRect();
  return {
    covered: !!dotPane && !!alertsPane
      && (+dotPane.style.zIndex) > (+alertsPane.style.zIndex),
    x: rect.left + pt.x, y: rect.top + pt.y,
    dx: rect.left + dpt.x, dy: rect.top + dpt.y,
  };
});

console.log('\n2. the click reaches the alert under the city-dot canvas');
ok('the city-dot canvas really sits above the alerts pane', setup.covered);
{
  await p.mouse.click(setup.x, setup.y);
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => ({
    open: !!map._popup && map._popup.isOpen(),
    text: map._popup ? String(map._popup.getContent()).replace(/<[^>]+>/g, ' ') : '',
  }));
  ok('the alert popup opens on a real mouse click', r.open, JSON.stringify(r).slice(0, 120));
  ok('and it is the tapped warning', /TORNADO WARNING/i.test(r.text), r.text.slice(0, 80));
}

console.log('\n3. the dots keep their own clicks, and the map keeps its');
{
  // The popup from the click above sits over the dot's spot; a person
  // would close it before tapping the dot, so the test does too.
  await p.evaluate(() => { map.closePopup(); });
  await p.waitForTimeout(200);
  await p.mouse.click(setup.dx, setup.dy);
  await p.waitForTimeout(300);
  const cityClicked = await p.evaluate(() => window.__cityClicked);
  ok('a click on a city dot still goes to the dot, not through it',
     cityClicked === 1, String(cityClicked));
  // Re-open the alert popup, then click plain map: it must still close.
  await p.mouse.click(setup.x, setup.y);
  await p.waitForTimeout(400);
  const open = await p.evaluate(() => !!map._popup && map._popup.isOpen());
  await p.evaluate(() => { map.setView([15, -140], 7, { animate: false }); });
  await p.waitForTimeout(300);
  await p.mouse.click(setup.x, setup.y);   // open ocean now: nothing to hit
  await p.waitForTimeout(300);
  const closed = await p.evaluate(() => !map._popup || !map._popup.isOpen());
  ok('a popup opened, and a plain map click still closes it', open && closed,
     JSON.stringify({ open, closed }));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
