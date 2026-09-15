#!/usr/bin/env node
/*
 * Radar Compass replaced the old click-to-measure Bearing tool: a
 * full-screen dial that turns with the phone's own compass and paints a
 * wedge of real radar data toward wherever it is pointed, tilting through
 * preset range rings.
 *
 *     node tools/test-radar-compass.mjs
 *
 * Checked here:
 *   1. The old Bearing tool left nothing behind.
 *   2. The toolbar button, labels and full-screen overlay are wired up.
 *   3. In a real browser: heading math (both the iOS webkitCompassHeading
 *      path and the computed-from-alpha path), the dial's rotation
 *      direction, tilt-to-range-ring mapping, the wedge draw and its
 *      "turn on Radar" hint, and closing (button and Escape).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the old Bearing tool left nothing behind');
{
  ok('no _brg functions or state remain',
     !/_brg[A-Za-z]/.test(PAGE));
  ok('no BRG_CARDINALS constant remains', !PAGE.includes('BRG_CARDINALS'));
  ok('no #brg-toolbar or its children remain',
     !PAGE.includes('brg-toolbar') && !PAGE.includes('brg-list') && !PAGE.includes('brg-drag'));
  ok('no tool-bearing button or labels remain', !PAGE.includes('tool-bearing'));
  ok('tools/test-bearing-tool.mjs was removed',
     !existsSync(join(ROOT, 'tools/test-bearing-tool.mjs')));
}

console.log('\n2. the toolbar button and labels are wired up');
{
  ok('the button calls startRadarCompassTool()',
     /id="tool-radar-compass" onclick="startRadarCompassTool\(\)"/.test(PAGE));
  ok('TOOL_LABELS has an entry', /'tool-radar-compass': 'Radar Compass'/.test(PAGE));
  ok('TOOL_DESCRIPTIONS has an entry',
     /'tool-radar-compass': 'Turns with your phone/.test(PAGE));
}

console.log('\n3. the full-screen overlay and its pieces exist');
{
  const ids = ['radc-overlay', 'radc-close', 'radc-status', 'radc-permission',
    'radc-dial-wrap', 'radc-wedge-canvas', 'radc-dial-svg', 'radc-rotating',
    'radc-range-labels', 'radc-pointer', 'radc-heading-readout',
    'radc-range-readout', 'radc-tilt-debug'];
  for (const id of ids) {
    ok(`#${id} is in the page`, new RegExp('id="' + id + '"').test(PAGE));
  }
  ok('the overlay is a full-screen modal at the app\'s standard z-index',
     /#radc-overlay \{[\s\S]{0,200}position: fixed;[\s\S]{0,60}inset: 0;[\s\S]{0,60}z-index: 4000;/.test(PAGE));
  ok('the close button calls _radcClose()', /id="radc-close" onclick="_radcClose\(\)"/.test(PAGE));
  ok('Escape closes it too, same as every other tool',
     /if \(e\.key === 'Escape' && typeof _radcOn !== 'undefined' && _radcOn\) _radcClose\(\);/.test(PAGE));
}

console.log('\n4. the heading, tilt and wedge math read correctly');
{
  ok('iOS heading uses webkitCompassHeading directly, never computed alpha',
     /function _radcComputeHeading\(e\) \{\s*if \(typeof e\.webkitCompassHeading === 'number'/.test(PAGE));
  ok('Android/Chrome heading is 360 minus alpha minus screen angle',
     /const h = 360 - e\.alpha - screenAngle;/.test(PAGE));
  ok('the dial rotates opposite the heading so the faced direction lands on top',
     /rotate\(\$\{-heading\} 110 110\)/.test(PAGE));
  ok('tilt has four bands from the same three thresholds the debug readout uses',
     /const RADC_TILT_THRESHOLDS = \[60, 80, 100\];/.test(PAGE));
  ok('four preset ranges, nearest to farthest',
     /const RADC_RANGES_KM = \[10, 25, 50, 100\];/.test(PAGE));
  ok('the overlay is see-through over the map near the dial, not an opaque backdrop',
     /#radc-overlay \{[\s\S]{0,700}transparent 0%, transparent 38%/.test(PAGE));
  ok('opening the tool locks the real map so it cannot be dragged out from under the dial',
     /function _radcLockMapView\(\)[\s\S]{0,400}map\.dragging\.disable\(\)/.test(PAGE));
  ok('closing restores whatever view the map was on before',
     /function _radcUnlockMapView\(\)[\s\S]{0,600}map\.setView\(_radcPrevMapView\.center, _radcPrevMapView\.zoom/.test(PAGE));
  ok('the map is re-zoomed so the outer ring matches its real-world distance',
     /function _radcSyncMapView\(\)[\s\S]{0,700}Math\.log2\(metersPerPixelAtZ0 \/ metersPerPixel\)/.test(PAGE));
  ok('tilting to a new range ring re-zooms the map too, not just the ring labels',
     /_radcRenderRangeLabels\(\);\s*_radcSyncMapView\(\);\s*_radcScheduleWedge\(true\);/.test(PAGE));
  ok('no em dashes anywhere in the new code or this test',
     !PAGE.slice(PAGE.indexOf('const RADC_RANGES_KM'), PAGE.indexOf('_radcClose()') + 400)
       .includes(String.fromCharCode(0x2014))
     && !readFileSync(join(ROOT, 'tools/test-radar-compass.mjs'), 'utf8').includes(String.fromCharCode(0x2014)));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LEAFLET_STUB = `(() => {
  const chain = () => new Proxy(function(){}, {
    get: (t, k) => { if (k === 'then') return undefined; return chain(); },
    apply: () => chain(), construct: () => chain(),
  });
  Object.defineProperty(window, 'L', { value: chain(), writable: true, configurable: true });
})();`;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      if (!d.startsWith('chromium-')) continue;
      const p = join('/opt/pw-browsers', d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  } catch {}
  return undefined;
}

const b = await chromium.launch({ executablePath: chromePath() });
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(LEAFLET_STUB);
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
await p.route('**://**', r =>
  r.request().url().startsWith('file://') ? r.continue() : r.abort());
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);

console.log('\n5. opening it starts sensors and does not block on geolocation');
{
  const r = await p.evaluate(async () => {
    // Reuse GPS Nav's last fix rather than asking the real geolocation API,
    // exactly the shortcut _radcGetLocation() takes when one is already on
    // hand - this is what keeps the tool from stalling in a browser that
    // never resolves a permission prompt.
    _lastGpsPos = { coords: { latitude: 27.9, longitude: -82.3 } };
    await startRadarCompassTool();
    return {
      overlayOpen: document.getElementById('radc-overlay').classList.contains('open'),
      dialShown: document.getElementById('radc-dial-wrap').classList.contains('show'),
      on: _radcOn,
      loc: _radcLoc,
      orientEvent: _radcOrientEvent,
    };
  });
  ok('the overlay opened', r.overlayOpen, JSON.stringify(r));
  ok('the dial is showing (did not get stuck on the permission screen)', r.dialShown, JSON.stringify(r));
  ok('_radcOn is true', r.on === true);
  ok('location came from the reused GPS fix, no waiting on a fresh request',
     r.loc && Math.abs(r.loc.lat - 27.9) < 0.001 && Math.abs(r.loc.lon - (-82.3)) < 0.001,
     JSON.stringify(r.loc));
  ok('sensors are listening for whichever event this browser actually fires',
     r.orientEvent === 'deviceorientationabsolute' || r.orientEvent === 'deviceorientation',
     r.orientEvent);
}

console.log('\n5b. the underlying map gets locked and its prior view remembered');
{
  const r = await p.evaluate(() => ({
    prevSaved: !!_radcPrevMapView,
  }));
  ok('opening the tool captured the map\'s view before taking it over',
     r.prevSaved, JSON.stringify(r));
}

console.log('\n6. a computed Android-style heading rotates the dial the right way');
{
  const r = await p.evaluate(() => new Promise(resolve => {
    const ev = new Event(_radcOrientEvent);
    Object.defineProperty(ev, 'alpha', { value: 270, configurable: true }); // heading = 360-270-0 = 90 = East
    Object.defineProperty(ev, 'beta', { value: 90, configurable: true });
    window.dispatchEvent(ev);
    setTimeout(() => resolve({
      heading: _radcHeading,
      transform: document.getElementById('radc-rotating').getAttribute('transform'),
      readout: document.getElementById('radc-heading-readout').textContent,
    }), 50);
  }));
  ok('alpha=270 with no screen rotation computes heading 90 (East)',
     Math.abs(r.heading - 90) < 0.01, JSON.stringify(r));
  ok('the dial group rotates by minus the heading, bringing East to the top',
     r.transform === 'rotate(-90 110 110)', r.transform);
  ok('the readout shows the rounded heading and its cardinal letter',
     r.readout === '90° E', r.readout);
}

console.log('\n7. an iOS-style webkitCompassHeading is used as-is, never recomputed');
{
  const r = await p.evaluate(() => new Promise(resolve => {
    const ev = new Event(_radcOrientEvent);
    Object.defineProperty(ev, 'alpha', { value: 123, configurable: true }); // must be ignored
    Object.defineProperty(ev, 'webkitCompassHeading', { value: 213, configurable: true });
    Object.defineProperty(ev, 'beta', { value: 90, configurable: true });
    window.dispatchEvent(ev);
    setTimeout(() => resolve({ heading: _radcHeading }), 50);
  }));
  ok('webkitCompassHeading wins over alpha', r.heading === 213, JSON.stringify(r));
}

console.log('\n8. tilting the phone steps through the four preset range rings');
{
  const cases = [
    { beta: 40, want: 3, label: '100 km (farthest, phone tipped up)' },
    { beta: 70, want: 2, label: '50 km' },
    { beta: 90, want: 1, label: '25 km' },
    { beta: 150, want: 0, label: '10 km (nearest, phone tipped down)' },
  ];
  for (const c of cases) {
    const r = await p.evaluate(beta => new Promise(resolve => {
      const ev = new Event(_radcOrientEvent);
      Object.defineProperty(ev, 'webkitCompassHeading', { value: 213, configurable: true });
      Object.defineProperty(ev, 'beta', { value: beta, configurable: true });
      window.dispatchEvent(ev);
      setTimeout(() => resolve({ idx: _radcRangeIdx, dbg: document.getElementById('radc-tilt-debug').textContent }), 50);
    }), c.beta);
    ok(`beta ${c.beta} selects ${c.label}`, r.idx === c.want, JSON.stringify(r));
  }
}

console.log('\n9. the wedge draws and hints to turn Radar on when there is nothing to sample');
{
  const r = await p.evaluate(() => new Promise(resolve => {
    _radcSetStatus('');
    _radcScheduleWedge(true);
    setTimeout(() => {
      const canvas = document.getElementById('radc-wedge-canvas');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) painted++;
      resolve({
        painted,
        status: document.getElementById('radc-status').textContent,
        nexrad: (typeof activeLayers !== 'undefined') ? activeLayers.nexrad : 'undefined',
      });
    }, 700);
  }));
  ok('Radar is off by default so nothing gets painted', r.painted === 0, JSON.stringify(r));
  ok('activeLayers.nexrad is off, which is the condition the hint checks', r.nexrad === false, JSON.stringify(r));
  ok('the hint to turn Radar on appears', r.status === 'Turn on Radar to see it painted here.', JSON.stringify(r));
}

console.log('\n10. closing resets everything, by button and by Escape');
{
  const closedByButton = await p.evaluate(() => {
    _radcClose();
    return {
      overlayOpen: document.getElementById('radc-overlay').classList.contains('open'),
      on: _radcOn,
      orientEvent: _radcOrientEvent,
      status: document.getElementById('radc-status').textContent,
      prevViewCleared: _radcPrevMapView === null,
    };
  });
  ok('the overlay closed', !closedByButton.overlayOpen, JSON.stringify(closedByButton));
  ok('_radcOn is false', closedByButton.on === false);
  ok('sensors were unhooked', closedByButton.orientEvent === null, JSON.stringify(closedByButton));
  ok('the status line cleared', closedByButton.status === '', JSON.stringify(closedByButton));
  ok('the map\'s saved prior view was consumed (restored and cleared)',
     closedByButton.prevViewCleared, JSON.stringify(closedByButton));

  const closedByEscape = await p.evaluate(() => new Promise(resolve => {
    _lastGpsPos = { coords: { latitude: 27.9, longitude: -82.3 } };
    startRadarCompassTool().then(() => {
      const openedFirst = document.getElementById('radc-overlay').classList.contains('open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      resolve({
        openedFirst,
        closedAfter: !document.getElementById('radc-overlay').classList.contains('open'),
      });
    });
  }));
  ok('it reopened for this check', closedByEscape.openedFirst, JSON.stringify(closedByEscape));
  ok('Escape closed it', closedByEscape.closedAfter, JSON.stringify(closedByEscape));
}

ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
