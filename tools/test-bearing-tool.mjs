#!/usr/bin/env node
/*
 * The Bearing tool: click a start point, click where it is headed, and it
 * draws the line with an arrowhead and reads off the true compass direction
 * between them.
 *
 *     node tools/test-bearing-tool.mjs
 *
 * Modeled on the existing Measure Distance tool (same toolbar shell, same
 * per-measurement list, same colour cycling), but a bearing is only a
 * meaningful thing to ask about two points - so unlike Distance's open-ended
 * multi-point path, this one finishes itself after the second click rather
 * than waiting on a double-click or a "new measurement" button.
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

console.log('\n1. the button, the toolbar and the wiring are all in the page');
{
  ok('the toolbar button exists and opens the tool',
     /id="tool-bearing" onclick="startBearingTool\(\)"/.test(PAGE));
  ok('the toolbar panel exists',
     /<div id="brg-toolbar">/.test(PAGE));
  ok('it has a drag handle, wired up like every other toolbar',
     /_makeDraggable\(document\.getElementById\('brg-toolbar'\),\s*document\.getElementById\('brg-drag-handle'\)\)/.test(PAGE));
  ok('the hover flyout knows its name and what it does',
     /'tool-bearing':\s*'Bearing'/.test(PAGE)
     && /'tool-bearing':\s*'Click a starting point/.test(PAGE));
  ok('switching tools cleans up its map listeners like every other tool',
     /map\.off\('click',\s*_onBrgClick\);/.test(PAGE)
     && /map\.off\('mousemove',\s*_onBrgMove\);/.test(PAGE));
  ok('"Clear all drawings" empties it too, not just its own Clear button',
     /function clearAllDrawings\(\)[\s\S]{0,700}_brgClearAll\(\);/.test(PAGE));
  ok('shot-mode already hides it for free (direct child of #map-wrap, not #map)',
     /<div id="brg-toolbar">/.test(PAGE) && !/#map-wrap[\s\S]{0,50}#brg-toolbar/.test(PAGE));
  ok('clean-mode hides it explicitly, the same list every other toolbar is in',
     /body\.clean-mode #dist-toolbar,\s*\n\s*body\.clean-mode #brg-toolbar/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-bearing-tool.mjs'), 'utf8').includes(EM));
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

const p = await b.newPage({ viewport: { width: 900, height: 700 } });
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
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

console.log('\n2. clicking two points reads the real compass bearing');
{
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(() => {
    startBearingTool();
    const out = { toolActive: document.getElementById('tool-bearing').classList.contains('active'),
                  toolbarVisible: document.getElementById('brg-toolbar').classList.contains('visible') };
    // Due east of the start point: true bearing 90 degrees.
    map.fire('click', { latlng: L.latLng(35.0, -97.0) });
    out.midDraw = document.getElementById('brg-list').textContent;
    map.fire('click', { latlng: L.latLng(35.0, -96.0) });
    out.deg = Math.round(_brgMeasurements[0].deg);
    out.cardinal = _brgCardinal(_brgMeasurements[0].deg);
    out.listText = document.getElementById('brg-list').textContent;
    out.hasArrow = !!_brgMeasurements[0].layers.arrow;
    out.hasLine = !!_brgMeasurements[0].layers.line;
    // Due north: true bearing 0/360, which should read as 000, not 360.
    map.fire('click', { latlng: L.latLng(35.0, -95.0) });
    map.fire('click', { latlng: L.latLng(36.0, -95.0) });
    out.northDeg = Math.round(_brgMeasurements[1].deg);
    out.northText = _brgFmt(_brgMeasurements[1].deg);
    return out;
  });
  ok('the tool button lights up and the toolbar opens', r.toolActive && r.toolbarVisible, JSON.stringify(r));
  ok('the list shows a placeholder row while waiting on the second click',
     /Click where it is headed/.test(r.midDraw), r.midDraw);
  ok('due east reads as 90 degrees', r.deg === 90, JSON.stringify(r));
  ok('and the cardinal direction is E', r.cardinal === 'E', r.cardinal);
  ok('the finished measurement drew both a line and a direction arrow',
     r.hasLine && r.hasArrow, JSON.stringify(r));
  ok('the reading actually reached the list panel', /090.*E/.test(r.listText), r.listText);
  ok('due north reads as 0, not 360', r.northDeg === 0, JSON.stringify(r));
  ok('formatted with the leading zeros the other headings get', r.northText === '000° N', r.northText);
}

console.log('\n3. delete, clear, and switching tools all behave');
{
  const r = await p.evaluate(() => {
    const out = { before: _brgMeasurements.length };
    const firstId = _brgMeasurements[0].id;
    _brgDelete(firstId);
    out.afterDelete = _brgMeasurements.length;
    out.deletedIdGone = !_brgMeasurements.some(m => m.id === firstId);

    // Start a third measurement and abandon it by switching to Distance -
    // the same thing every other tool here already tolerates mid-draw.
    // deactivateTool() first: the tool is still active from part 2, and
    // startBearingTool() is a toggle - calling it again while already on
    // would close it instead of starting a fresh measurement.
    deactivateTool();
    startBearingTool();
    map.fire('click', { latlng: L.latLng(34.0, -97.0) });
    const hadPartial = !!_brgActive;
    startDistanceTool();
    out.hadPartial = hadPartial;
    out.toolSwitched = activeTool === 'distance';
    out.bearingBtnDeactivated = !document.getElementById('tool-bearing').classList.contains('active');

    clearAllDrawings();
    out.afterClearAll = _brgMeasurements.length;
    out.activePartialGoneToo = !_brgActive;
    return out;
  });
  ok('there were two measurements to begin with', r.before === 2, JSON.stringify(r));
  ok('deleting one leaves the other', r.afterDelete === 1 && r.deletedIdGone, JSON.stringify(r));
  ok('a half-drawn measurement existed right before the tool switch', r.hadPartial);
  ok('switching to Distance mid-draw actually switches', r.toolSwitched, JSON.stringify(r));
  ok('and turns the Bearing button off', r.bearingBtnDeactivated);
  ok('Clear All Drawings empties every finished measurement', r.afterClearAll === 0, JSON.stringify(r));
  ok('and the abandoned half-drawn one too', r.activePartialGoneToo);
  ok('nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await p.close();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
