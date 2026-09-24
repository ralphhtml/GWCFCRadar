#!/usr/bin/env node
/*
 * Radar 3D (volumetric): a zone on the map, ray-marched as a real volume.
 *
 *     node tools/test-radar-3d.mjs
 *
 * Inspired by OpenStorm (JordanSchlick/OpenStorm), a desktop GPU volumetric
 * ray marcher, rebuilt here without a GPU: tapping the map places a zone
 * (a rectangle drawn on the map), the nearest radar's tilts are resampled
 * into a voxel grid over just that zone, and a plain-JS ray marcher with a
 * transfer function LUT renders it as one continuous cloud with a solid
 * core - no WebGL, no dots. Checked the same way Cross Section's own test
 * is: the maths is right independent of this code, fake decoders prove a
 * real grid gets built and marched, and the tool cannot take the map down
 * whether it succeeds or fails.
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

console.log('\n1. the panel: a zone picker and volumetric controls, no toolbar button');
{
  ok('there is no toolbar button for it',
     !/id="tool-r3d"/.test(PAGE));
  ok('the panel exists and is titled Volumetric 3D',
     PAGE.includes('id="r3d-panel"') && /<span class="xs-title">Volumetric 3D<\/span>/.test(PAGE));
  ok('it has a product picker and no box-size picker: the zone is whatever you draw',
     PAGE.includes('id="r3d-product"') && !PAGE.includes('id="r3d-zone"'));
  ok('the Radius maker and the Polygon maker each have a 3D button',
     /id="rtb-3d-btn" onclick="_r3dFromRadius\(event\)"/.test(PAGE) && /id="ptb-3d" onclick="_r3dFromPolygon\(event\)"/.test(PAGE));
  ok('it has a station picker too, for choosing a different radar than the nearest',
     PAGE.includes('id="r3d-site"'));
  ok('it keeps the two sliders: Show above and Up to',
     PAGE.includes('id="r3d-filter"') && PAGE.includes('id="r3d-height"'));
  ok('the panel plays on its own playbar; the map\'s animation bar no longer drives 3D',
     /function _p3dPlaybar\(api\)/.test(PAGE) && /_r3dPlaybar = _p3dPlaybar\(/.test(PAGE)
     && !/return mk\('r3d'/.test(PAGE) && !/return mk\('s3d'/.test(PAGE));
  ok('the double-click/long-press map menu has a row that starts drawing a zone',
     /_cmRadar3DDraw\(\)/.test(PAGE) && /Draw a 3D radar zone/.test(PAGE));
  ok('the renderer marches the radar\'s own polar volume, in workers',
     /_r3dMarchBand/.test(PAGE) && /_r3dPolarFrame/.test(PAGE) && /_r3dMarchAsync/.test(PAGE));
  ok('a box has no upper size limit any more',
     !/R3D_ZONE_MAX_KM/.test(PAGE) && /const R3D_ZONE_MIN_KM = 3;/.test(PAGE));
  // Satellite 3D wears the same pair, so the page holds two of each: the
  // Radar 3D panel's own markup is what is counted here.
  const r3dHtml = PAGE.slice(PAGE.indexOf('<div id="r3d-panel">'), PAGE.indexOf('<div id="s3d-panel">'));
  ok('exactly two camera bars exist: one vertical, one horizontal',
     PAGE.includes('id="r3d-zoom"') && PAGE.includes('id="r3d-yaw"')
     && (r3dHtml.match(/class="r3d-cam-zoom"/g) || []).length === 1
     && (r3dHtml.match(/class="r3d-cam-move"/g) || []).length === 1);
  ok('the zoom bar is styled vertical, the move bar horizontal',
     /\.r3d-cam-zoom input\[type=range\] \{\s*\n\s*writing-mode: vertical-lr; direction: rtl;/.test(PAGE)
     && /\.r3d-cam-move input\[type=range\] \{ width: 100%; height: 6px; \}/.test(PAGE));
  ok('a Smoothing slider sits with the rest of the sliders',
     PAGE.includes('id="r3d-smooth"') && /<span>Smoothing<\/span>/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the feature or in this test file',
     !PAGE.slice(PAGE.indexOf('RADAR 3D (VOLUMETRIC)'), PAGE.indexOf('TOOLBAR (#right-menu) HOVER FLYOUT')).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-radar-3d.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
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
ok('the page boots clean', errs.length === 0, errs[0]);

console.log('\n2. the map menu starts a drag, and the drag becomes the zone');
{
  const r = await p.evaluate(async () => {
    map.setView([36.1, -95.9], 7);
    await new Promise(res => setTimeout(res, 200));
    _cmOpen({ latlng: L.latLng(36.1, -95.9) });
    const row = Array.from(document.querySelectorAll('#map-ctx-menu .cm-item'))
      .find(el => /Draw a 3D radar zone/i.test(el.textContent));
    if (row) row.click();
    const drawing = { on: _r3dDrawOn, dragOff: !map.dragging.enabled(),
                      cursor: map.getContainer().style.cursor,
                      menuClosed: !document.getElementById('map-ctx-menu').classList.contains('open') };
    // Drag a box out on the map, screenshot-style: 120 by 90 pixels.
    const c = map.getContainer(), rc = c.getBoundingClientRect();
    const a = [rc.left + 500, rc.top + 300], b = [rc.left + 620, rc.top + 390];
    const ev = (type, xy, extra) => c.dispatchEvent(new PointerEvent(type, Object.assign({
      pointerId: 7, clientX: xy[0], clientY: xy[1], button: 0, bubbles: true, cancelable: true }, extra || {})));
    ev('pointerdown', a);
    ev('pointermove', [rc.left + 560, rc.top + 350]);
    const previewShown = !!(_r3dDrawPreview && map.hasLayer(_r3dDrawPreview));
    ev('pointermove', b);
    ev('pointerup', b);
    // What that drag measures on the map, in km.
    const la = map.containerPointToLatLng([500, 300]), lb = map.containerPointToLatLng([620, 390]);
    const midLat = (la.lat + lb.lat) / 2;
    const expectW = Math.abs(lb.lng - la.lng) * 111.32 * Math.cos(midLat * Math.PI / 180);
    const expectH = Math.abs(la.lat - lb.lat) * 111.32;
    const rectOnMap = !!(_r3dZoneRect && map.hasLayer(_r3dZoneRect));
    let rectKm = null;
    if (rectOnMap) {
      const rb = _r3dZoneRect.getBounds();
      rectKm = { w: (rb.getEast() - rb.getWest()) * 111.32 * Math.cos(midLat * Math.PI / 180), h: (rb.getNorth() - rb.getSouth()) * 111.32 };
    }
    const out = {
      rowExists: !!row, drawing, previewShown,
      on: _r3dOn, zone: _r3dZone ? Object.assign({}, _r3dZone) : null,
      expectW, expectH, midLat, midLng: (la.lng + lb.lng) / 2,
      station: _r3dStation, km: _r3dStationKm,
      rectOnMap, rectKm,
      drawOffAfter: !_r3dDrawOn, dragBackOn: map.dragging.enabled(), previewGone: !_r3dDrawPreview,
      panelOpen: document.getElementById('r3d-panel').classList.contains('open'),
    };
    _r3dClose();
    out.rectGoneAfterClose = !_r3dZoneRect;
    out.zoneClearedAfterClose = !_r3dZone;
    return out;
  });
  ok('the row is really in the menu, and picking it closes the menu', r.rowExists && r.drawing.menuClosed);
  ok('it enters drawing mode: crosshair, map panning paused',
     r.drawing.on && r.drawing.dragOff && r.drawing.cursor === 'crosshair', JSON.stringify(r.drawing));
  ok('a dashed preview rubber-bands while dragging', r.previewShown);
  ok('letting go opens the panel', r.on && r.panelOpen);
  ok('the zone is exactly the box that was dragged out',
     r.zone && Math.abs(r.zone.wKm - r.expectW) < 0.3 && Math.abs(r.zone.hKm - r.expectH) < 0.3
     && Math.abs(r.zone.lat - r.midLat) < 1e-4 && Math.abs(r.zone.lng - r.midLng) < 1e-4,
     JSON.stringify({ zone: r.zone, expectW: r.expectW, expectH: r.expectH }));
  ok('it is not a square: width and height follow the drag',
     r.zone && Math.abs(r.zone.wKm - r.zone.hKm) > 5, JSON.stringify(r.zone));
  ok('the nearest radar to that box was chosen, with a real distance',
     !!r.station && r.km > 0 && r.km < 420, r.station + ' ' + r.km);
  ok('the rectangle on the map is that same box',
     r.rectOnMap && r.rectKm && Math.abs(r.rectKm.w - r.zone.wKm) < 0.5 && Math.abs(r.rectKm.h - r.zone.hKm) < 0.5,
     JSON.stringify(r.rectKm));
  ok('drawing mode ends, panning comes back, the preview is gone',
     r.drawOffAfter && r.dragBackOn && r.previewGone);
  ok('closing takes the rectangle and the zone away with it',
     r.rectGoneAfterClose && r.zoneClearedAfterClose);
}

console.log('\n2c. the Radius maker and the Polygon maker can send their shape to 3D');
{
  const r = await p.evaluate(() => {
    _radii.push({ id: 9990, lat: 36.0, lng: -96.0, miles: 30, color: '#fff', marker: null, circle: null });
    // The button asks which 3D view; Radar 3D is picked here.
    const pickR = _r3dFromRadius();
    const okRadius = !!pickR;
    pickR.querySelector('[data-t="r3d"]').click();
    const fromRadius = _r3dZone ? Object.assign({}, _r3dZone) : null;
    _radii.pop();
    _r3dClose();
    const savedPts = _polyPts;
    _polyPts = [L.latLng(36.0, -96.0), L.latLng(36.5, -96.0), L.latLng(36.5, -95.4)];
    const pickP = _r3dFromPolygon();
    const okPoly = !!pickP;
    pickP.querySelector('[data-t="r3d"]').click();
    const fromPoly = _r3dZone ? Object.assign({}, _r3dZone) : null;
    _polyPts = [];
    const refusedEmpty = _r3dFromPolygon();
    _polyPts = savedPts;
    _r3dClose();
    return { okRadius, fromRadius, okPoly, fromPoly, refusedEmpty };
  });
  // A 30 mile radius is a 96.6 km square; the polygon spans 0.5 degrees of
  // latitude (55.7 km) and 0.6 of longitude (53.9 km at 36.25 north).
  ok('a radius becomes its bounding square, centred on the radius, cut to the circle',
     r.okRadius && r.fromRadius && Math.abs(r.fromRadius.wKm - 96.6) < 0.5 && Math.abs(r.fromRadius.hKm - 96.6) < 0.5
     && r.fromRadius.shape && r.fromRadius.shape.type === 'circle'
     && Math.abs(r.fromRadius.lat - 36) < 1e-6 && Math.abs(r.fromRadius.lng - -96) < 1e-6,
     JSON.stringify(r.fromRadius));
  ok('a polygon becomes its extent, cut to the polygon',
     r.okPoly && r.fromPoly && r.fromPoly.shape && r.fromPoly.shape.type === 'poly' && r.fromPoly.shape.xy.length === 3 && Math.abs(r.fromPoly.hKm - 55.7) < 0.5 && Math.abs(r.fromPoly.wKm - 53.9) < 0.6
     && Math.abs(r.fromPoly.lat - 36.25) < 1e-6 && Math.abs(r.fromPoly.lng - -95.7) < 1e-6,
     JSON.stringify(r.fromPoly));
  ok('with no polygon drawn the button politely refuses', r.refusedEmpty === false);
}

console.log('\n2b. the station picker: nearest first, nearest chosen, another one reloads');
{
  const r = await p.evaluate(async () => {
    _r3dOpenBounds(36.0, -96.05, 36.2, -95.75);       // a box centred on 36.1, -95.9
    const ss = document.getElementById('r3d-site');
    const opts = Array.from(ss.options).map(o => ({ id: o.value, km: parseFloat(o.textContent.split('·')[1]) }));
    const before = { station: _r3dStation, km: _r3dStationKm, selected: ss.value };
    const loads = [];
    const realLoad = window._r3dLoad;
    window._r3dLoad = async () => { loads.push(_r3dStation); };
    ss.value = opts[1].id;
    ss.dispatchEvent(new Event('change', { bubbles: true }));
    const after = { station: _r3dStation, km: _r3dStationKm, zone: { ..._r3dZone } };
    window._r3dLoad = realLoad;
    _r3dToken++;
    _r3dClose();
    return { opts, before, after, loads };
  });
  ok('it lists a short handful of radars, nearest first',
     r.opts.length === 8 && r.opts.every((o, i) => i === 0 || o.km >= r.opts[i - 1].km),
     JSON.stringify(r.opts.slice(0, 3)));
  ok('the nearest one is what the tap chose, and it is the one selected',
     r.before.selected === r.before.station && r.opts[0].id === r.before.station,
     JSON.stringify(r.before));
  ok('picking the second radar switches to it and reloads from it, same zone',
     r.after.station === r.opts[1].id && r.loads.join(',') === r.opts[1].id
     && Math.abs(r.after.zone.lat - 36.1) < 1e-6,
     JSON.stringify({ after: r.after, loads: r.loads }));
  ok('with its own distance from the zone, not the old one',
     Math.abs(r.after.km - r.opts[1].km) < 1 && r.after.km !== r.before.km,
     JSON.stringify({ before: r.before.km, after: r.after.km, listed: r.opts[1].km }));
}

console.log('\n3. the colours are the app\'s own radar palette, custom colours included');
{
  const r = await p.evaluate(() => {
    const ref = _r3dColorFn('ref'), vel = _r3dColorFn('vel');
    const builtIn = {
      belowScale: ref(2),                 // under the 5 dBZ band: the picture draws nothing
      yellow35: ref(35), red55: ref(55), white78: ref(78),
      deadZone: vel(0.5), inbound: vel(-90), outbound: vel(90),
      sameAsPicture: JSON.stringify(_meshRGBA(_meshColorFn('ref')(55))) ===
        JSON.stringify(_meshRGBA('rgb(' + ref(55).join(',') + ')')),
    };
    // Now with a custom palette switched on for reflectivity, exactly the
    // way the Radar Colors panel stores one: blue at the bottom of the
    // scale running to red at the top.
    const savedRef = _fxColors.ref;
    _fxColors.ref = { on: true, stops: ['#0000ff', '#ff0000'] };
    _r3dOnPaletteChange();
    const custom = _r3dColorFn('ref');
    const out = { builtIn, custom: { low: custom(-20), high: custom(70) },
                  genBumped: _r3dPaletteGen > 0 };
    _fxColors.ref = savedRef;
    _r3dOnPaletteChange();
    return out;
  });
  ok('below the lowest band the volume is transparent, like the picture',
     r.builtIn.belowScale === null);
  ok('35 dBZ is the NWS yellow', r.builtIn.yellow35 && r.builtIn.yellow35[0] > 200
     && r.builtIn.yellow35[1] > 200 && r.builtIn.yellow35[2] < 60, JSON.stringify(r.builtIn.yellow35));
  ok('55 dBZ is the NWS red', r.builtIn.red55 && r.builtIn.red55[0] > 180
     && r.builtIn.red55[1] < 40, JSON.stringify(r.builtIn.red55));
  ok('78 dBZ is white', r.builtIn.white78 && r.builtIn.white78.every(c => c > 240),
     JSON.stringify(r.builtIn.white78));
  ok('the velocity dead zone around zero stays open', r.builtIn.deadZone === null);
  ok('inbound is green, outbound is red', r.builtIn.inbound[1] > r.builtIn.inbound[0]
     && r.builtIn.outbound[0] > r.builtIn.outbound[1], JSON.stringify([r.builtIn.inbound, r.builtIn.outbound]));
  ok('and it is byte-for-byte what the flat picture paints', r.builtIn.sameAsPicture);
  ok('a custom palette takes over: blue at the bottom, red at the top',
     r.custom.low && r.custom.low[2] > r.custom.low[0]
     && r.custom.high && r.custom.high[0] > r.custom.high[2], JSON.stringify(r.custom));
  ok('a palette change bumps the generation so the LUT rebuilds', r.genBumped);
}

console.log('\n4. the transfer function: haze for weak, solid for strong, filter honoured');
{
  const r = await p.evaluate(() => {
    const saved = _r3dFilterPct;
    _r3dFilterPct = 0; _r3dLutCache = null;
    const open = _r3dLutFor('ref', 0.5);
    const bWeak = _r3dNormByte(5, false), bStrong = _r3dNormByte(55, false);
    const openWeakA = open.lut[bWeak * 4 + 3], openStrongA = open.lut[bStrong * 4 + 3];
    const emptyA = open.lut[3];
    const floorRed = [open.floorRgb[bStrong * 3], open.floorRgb[bStrong * 3 + 1], open.floorRgb[bStrong * 3 + 2]];
    _r3dFilterPct = 80; _r3dLutCache = null;               // cutoff 60 dBZ
    const filtered = _r3dLutFor('ref', 0.5);
    const filteredStrongA = filtered.lut[bStrong * 4 + 3]; // 55 dBZ is now below the bar
    const bExtreme = _r3dNormByte(75, false);
    const filteredExtremeA = filtered.lut[bExtreme * 4 + 3];
    _r3dFilterPct = saved; _r3dLutCache = null;
    return { emptyA, openWeakA, openStrongA, filteredStrongA, filteredExtremeA, floorRed };
  });
  ok('empty air is perfectly transparent', r.emptyA === 0);
  ok('weak returns are a thin haze, strong a near-solid wall',
     r.openWeakA > 0 && r.openWeakA < 0.1 && r.openStrongA > r.openWeakA * 4,
     JSON.stringify(r));
  ok('raising Show above zeroes everything below the bar, keeps what is over it',
     r.filteredStrongA === 0 && r.filteredExtremeA > 0, JSON.stringify(r));
  ok('the floor palette carries the real ramp colours (55 dBZ is red)',
     r.floorRed[0] > 200 && r.floorRed[1] < 60, JSON.stringify(r.floorRed));
}

console.log('\n5. gates become a polar volume: native bins, tilt interpolation, honest edges');
{
  const r = await p.evaluate(() => {
    // A radar 60 km south of the zone, two tilts, one column of echo at the
    // zone centre: exactly what a cone stack really hands us.
    const zone = { lat: 36, lng: -96, wKm: 40, hKm: 40 };
    const site = { x: 0, y: -60 };
    const z1 = _xsBeamHeightKm(60, 0.5, 0), z2 = _xsBeamHeightKm(60, 3.0, 0);
    const gates = new Float32Array([0, 0, z1, 55, 0, 0, z2, 55]);
    const frame = { gates, radii: new Float32Array([0.6, 0.3, 0.6, 0.5]), count: 2, segs: [
      { start: 0, end: 1, angle: 0.5 }, { start: 1, end: 2, angle: 3.0 },
    ], time: null, cuts: 2, site, _grids: {} };
    const P = _r3dPolarFrame(frame, zone, _r3dSpec('ref'));
    return {
      nS: P.nS, angles: [...P.angles], rStep: P.rStep, azStep: P.azStep, full: P.full,
      atLow: _r3dPolarSample(P, 0, 0, z1),
      between: _r3dPolarSample(P, 0, 0, (z1 + z2) / 2),
      aboveTop: _r3dPolarSample(P, 0, 0, z2 + 3),
      belowSkirt: _r3dPolarSample(P, 0, 0, Math.max(0.05, z1 - 0.5)),
      farCorner: _r3dPolarSample(P, 18, 18, z1),
      colHit: P.colMaxZ[(P.colN >> 1) * P.colN + (P.colN >> 1)],
      colFar: P.colMaxZ[0],
    };
  });
  ok('one plane per tilt, lowest first', r.nS === 2 && r.angles[0] === 0.5 && r.angles[1] === 3, JSON.stringify(r.angles));
  ok('bins stay at the radar\'s own quarter km by half degree', r.rStep === 0.25 && r.azStep === 0.5 && !r.full,
     JSON.stringify([r.rStep, r.azStep, r.full]));
  ok('the sample on the low tilt is strong', r.atLow > 100, String(r.atLow));
  ok('the air between the two tilts is the blend of both, not a stripe of nothing',
     r.between > 60, String(r.between));
  ok('above the top tilt plus its beam stays honestly empty', r.aboveTop === 0, String(r.aboveTop));
  ok('below the lowest tilt the echo fades toward the ground instead of a hard cone cut',
     r.belowSkirt > 0 && r.belowSkirt < r.atLow, JSON.stringify([r.belowSkirt, r.atLow]));
  ok('a far empty corner is empty', r.farCorner === 0, String(r.farCorner));
  ok('the column map knows where the storm tops are, and where there is nothing',
     r.colHit > 0 && r.colFar === 0, JSON.stringify([r.colHit, r.colFar]));
}

console.log('\n5b. a gate paints its whole footprint, not just the bin under its centre');
{
  const r = await p.evaluate(() => {
    const zone = { lat: 36, lng: -96, wKm: 40, hKm: 40 };
    const site = { x: 0, y: -60 };
    const z1 = _xsBeamHeightKm(60, 0.5, 0);
    const gates = new Float32Array([0, 0, z1, 55]);
    const mk = (radii) => ({ gates, radii, count: 1, segs: [{ start: 0, end: 1, angle: 0.5 }],
                             time: null, cuts: 1, site, _grids: {} });
    const fill = (P) => { let n = 0; const pl = P.sweeps[0]; for (let i = 0; i < pl.length; i++) if (pl[i]) n++; return n; };
    const Pp = _r3dPolarFrame(mk(null), zone, _r3dSpec('ref'));
    const Pf = _r3dPolarFrame(mk(new Float32Array([1.2, 0.5])), zone, _r3dSpec('ref'));
    return { point: fill(Pp), foot: fill(Pf),
             beside: _r3dPolarSample(Pf, 0.9, 0, z1), off: _r3dPolarSample(Pp, 3, 0, z1) };
  });
  ok('a bare point fills a bin or two', r.point >= 1 && r.point <= 8, String(r.point));
  ok('a 1.2 km footprint fills a patch of bins', r.foot > r.point * 3, JSON.stringify([r.foot, r.point]));
  ok('so a sample beside the gate centre still reads it', r.beside > 0 && r.off === 0,
     JSON.stringify([r.beside, r.off]));
}

console.log('\n6. building a frame from a volume that is stood in for, zone filtered');
{
  const r = await p.evaluate(async () => {
    const ANGLES = { 1: 0.5, 2: 1.5 };
    const makeMesh = (elev) => {
      const N = 20, step = 0.03, lon0 = -97.3, lat0 = 35.2;
      const mesh = new Float32Array(N * N * 9);
      let k = 0;
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const x = lon0 + gx * step, y = lat0 + gy * step;
          mesh[k++] = x;        mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y + step;
          mesh[k++] = x;        mesh[k++] = y + step;
          const d = Math.hypot(gx - N / 2, gy - N / 2);
          mesh[k++] = Math.max(-30, 55 - d * 4 - (elev - 1) * 10);
        }
      }
      return { mesh, bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step] };
    };
    let calls = 0;
    const realWorker = window._workerProcess, realPool = window._pbDecode;
    const fake = async (buf, layer, opts) => {
      calls++;
      const el = (opts && opts.elevation) || 1;
      const m = makeMesh(el);
      return {
        meshData: m.mesh, bounds: m.bounds,
        metadata: { availableElevations: [1, 2], elevationNumber: el,
                    elevationAngle: ANGLES[el], timeIso: new Date().toISOString() },
      };
    };
    window._workerProcess = fake; window._pbDecode = fake;
    const sitePos = { lat: 35.0, lng: -97.3 };
    const zone = { lat: 35.5, lng: -97.0, wKm: 90, hKm: 90 };   // the fake mesh sits around here
    const farZone = { lat: 44.0, lng: -80.0, wKm: 90, hKm: 90 }; // nowhere near it
    const token = ++_r3dToken;
    const frame = await _r3dBuildFrame(new ArrayBuffer(8), 'REF', sitePos, zone, token);
    const token2 = ++_r3dToken;
    const farFrame = await _r3dBuildFrame(new ArrayBuffer(8), 'REF', sitePos, farZone, token2);
    window._workerProcess = realWorker; window._pbDecode = realPool;
    return {
      calls, count: frame ? frame.count : 0,
      cuts: frame ? frame.cuts : 0,
      segs: frame ? frame.segs.map(s => s.angle) : [],
      allFinite: frame ? Array.from(frame.gates).every(Number.isFinite) : false,
      farIsNull: farFrame === null,
    };
  });
  ok('it decoded both elevations', r.calls >= 2, String(r.calls));
  ok('and built real gates from them', r.count > 20, String(r.count));
  ok('each tilt kept its own angle for the floor to find later',
     r.segs.length === 2 && r.segs[0] === 0.5 && r.segs[1] === 1.5, r.segs.join(','));
  ok('every stored gate is a finite number', r.allFinite);
  ok('a zone far from the storm honestly builds nothing', r.farIsNull);
}

console.log('\n6b. the whole stack: every tilt decoded, shown as it lands, stopped above the top');
{
  const r = await p.evaluate(async () => {
    const N = 10, step = 0.03, lon0 = -97.15, lat0 = 35.35;
    const makeMesh = (val) => {
      const mesh = new Float32Array(N * N * 9);
      let k = 0;
      for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const x = lon0 + gx * step, y = lat0 + gy * step;
        mesh[k++] = x; mesh[k++] = y; mesh[k++] = x + step; mesh[k++] = y;
        mesh[k++] = x + step; mesh[k++] = y + step; mesh[k++] = x; mesh[k++] = y + step;
        mesh[k++] = val;
      }
      return mesh;
    };
    // Twelve elevations like a real VCP, the last few far steeper than any
    // storm is tall. Decoded one lane at a time here so the order, and so
    // the stop, is deterministic.
    const ANGLES = { 1: 0.5, 2: 0.9, 3: 1.3, 4: 1.8, 5: 2.4, 6: 3.1, 7: 4.0, 8: 5.1,
                     9: 6.4, 10: 8.0, 11: 10, 12: 25 };
    const decoded = [];
    const realWorker = window._workerProcess, realPool = window._pbDecode, realSize = window._pbPoolSize;
    const fake = async (buf, layer, opts) => {
      const el = (opts && opts.elevation) || 1;
      decoded.push(el);
      await new Promise(res => setTimeout(res, 2));
      return { meshData: makeMesh(45), bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step],
        metadata: { availableElevations: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], elevationNumber: el,
                    elevationAngle: ANGLES[el] || 30, timeIso: '2026-09-17T12:00:00Z' } };
    };
    window._workerProcess = fake; window._pbDecode = fake; window._pbPoolSize = () => 1;
    const progress = [];
    const token = ++_r3dToken;
    const frame = await _r3dBuildFrame(new ArrayBuffer(8), 'REF', { lat: 35.0, lng: -97.3 },
      { lat: 35.5, lng: -97.0, wKm: 90, hKm: 90 }, token, (snap, done, total) => progress.push([done, total, snap ? snap.cuts : 0]));
    window._workerProcess = realWorker; window._pbDecode = realPool; window._pbPoolSize = realSize;
    return { decoded, progress, cuts: frame ? frame.cuts : 0,
             topAngle: frame ? Math.max(...frame.segs.map(s => s.angle)) : 0 };
  });
  ok('it decoded up through the first tilt steeper than 20 degrees and stopped',
     r.decoded.includes(12) && !r.decoded.includes(13), r.decoded.join(','));
  ok('twelve cuts made it into the frame', r.cuts === 12, String(r.cuts));
  ok('the storm was reported growing after every single tilt',
     r.progress.length === 12 && r.progress.every((pr, i) => pr[0] === i + 1 && pr[2] === i + 1),
     JSON.stringify(r.progress.slice(0, 4)));
}

console.log('\n6c. a decoder that reports angles: one decode per distinct tilt, shared across lanes, zone only');
{
  const r = await p.evaluate(async () => {
    const N = 10, step = 0.03, lon0 = -97.15, lat0 = 35.35;
    const makeMesh = (val) => {
      const mesh = new Float32Array(N * N * 9);
      let k = 0;
      for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const x = lon0 + gx * step, y = lat0 + gy * step;
        mesh[k++] = x; mesh[k++] = y; mesh[k++] = x + step; mesh[k++] = y;
        mesh[k++] = x + step; mesh[k++] = y + step; mesh[k++] = x; mesh[k++] = y + step;
        mesh[k++] = val;
      }
      return mesh;
    };
    // A real VCP 212 SAILS stack, as KIWX reported it: 21 records, the low
    // tilts repeated mid-volume, split cuts sharing an angle, and the last
    // few steeper than any storm top.
    const ANGLES = [0.63, 0.44, 0.71, 0.80, 1.05, 1.23, 0.70, 0.44, 1.66, 2.22, 2.90, 3.83,
                    4.90, 6.22, 0.57, 0.44, 7.84, 9.85, 12.29, 15.45, 19.35];
    const elevs = ANGLES.map((_, i) => i + 1);
    const calls = [];
    const realWorker = window._workerProcess, realPool = window._pbDecode, realSize = window._pbPoolSize;
    // The worker's own planning, mirrored: cluster by angle at a quarter
    // degree, keep each cluster's lowest record, share them out by lane.
    const plan = (topAngle) => {
      const items = elevs.map((el, i) => ({ el, a: ANGLES[i] })).filter(x => x.a <= topAngle)
        .sort((p, q) => p.a - q.a || p.el - q.el);
      const clusters = [];
      for (const it of items) {
        const c = clusters[clusters.length - 1];
        if (c && it.a - c.a0 < 0.25) { if (it.el < c.el) c.el = it.el; } else clusters.push({ a0: it.a, el: it.el });
      }
      return clusters.map(c => c.el);
    };
    const fake = async (buf, layer, opts) => {
      calls.push(opts || {});
      await new Promise(res => setTimeout(res, 2));
      if (opts && opts.elevations === 'distinct') {
        const reps = plan(opts.top_angle);
        const mine = reps.filter((_, i) => i % opts.lanes === opts.lane);
        return { sweeps: mine.map(el => ({ elevationNumber: el, elevationAngle: ANGLES[el - 1],
                   meshData: makeMesh(40 + el), bounds: null })),
                 metadata: { availableElevations: elevs, elevationAngles: ANGLES, distinctCount: reps.length,
                             timeIso: '2026-09-17T12:00:00Z' } };
      }
      return { meshData: makeMesh(45), bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step],
        metadata: { availableElevations: elevs, elevationAngles: ANGLES, elevationNumber: 1,
                    elevationAngle: ANGLES[0], timeIso: '2026-09-17T12:00:00Z' } };
    };
    window._workerProcess = fake; window._pbDecode = fake; window._pbPoolSize = () => 3;
    const progress = [];
    const token = ++_r3dToken;
    const frame = await _r3dBuildFrame(new ArrayBuffer(8), 'REF', { lat: 35.0, lng: -97.3 },
      { lat: 35.5, lng: -97.0, wKm: 90, hKm: 90 }, token, (snap, done, total) => progress.push([done, total]));
    window._workerProcess = realWorker; window._pbDecode = realPool; window._pbPoolSize = realSize;
    const laneCalls = calls.filter(c => c.elevations === 'distinct');
    const got = frame ? frame.segs.map(s => elevs[ANGLES.indexOf(s.angle)]).sort((a, b) => a - b) : [];
    return { everyCallHasBbox: calls.every(c => Array.isArray(c.bbox) && c.bbox.length === 4),
             calls: calls.length, laneCalls: laneCalls.length,
             lanesSeen: laneCalls.map(c => c.lane).sort().join(','),
             got, cuts: frame ? frame.cuts : 0, time: frame ? frame.time : null,
             topAngle: frame ? Math.max(...frame.segs.map(s => s.angle)) : 0,
             total: progress.length ? progress[0][1] : 0, lastDone: progress.length ? progress[progress.length - 1][0] : 0 };
  });
  ok('every decode asks for just the zone', r.everyCallHasBbox);
  ok('exactly one parse per worker lane, no separate decode to learn the angles first',
     r.calls === 3 && r.laneCalls === 3 && r.lanesSeen === '0,1,2', JSON.stringify({ calls: r.calls, lanes: r.lanesSeen }));
  // Clusters of the angles above at a quarter-degree: 0.44-0.63 keeps record
  // 1, 0.70-0.80 keeps record 3, 1.05-1.23 keeps record 5, then one record
  // per real tilt up through 19.35: fourteen distinct tilts from 21 records.
  ok('every DISTINCT tilt is decoded exactly once - repeats and split cuts are not',
     r.got.join(',') === '1,3,5,9,10,11,12,13,14,17,18,19,20,21', r.got.join(','));
  ok('so the stack reaches the 19 degree tilt, not the 6 degree one',
     r.topAngle > 19 && r.cuts === 14, JSON.stringify({ top: r.topAngle, cuts: r.cuts }));
  ok('progress knew the full count from the first lane and reached it',
     r.total === 14 && r.lastDone === 14 && r.time === '2026-09-17T12:00:00Z',
     JSON.stringify({ total: r.total, lastDone: r.lastDone, time: r.time }));
}

console.log('\n7. the ray march draws a solid volume, and the two sliders really cut it');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');                                    // panel visible, zone at the site
    _r3dToken++;
    const savedCam = { ..._r3dCam };
    const savedH = _r3dHeightMaxKft, savedF = _r3dFilterPct;
    // A real cone stack: nine tilts of 62 dBZ over a 6 km core, so the
    // column reads solid from the ground to the top of the stack.
    const site = { x: 0, y: -60 };
    const xs = [], ys = [], zs = [], vs = [], rs = [], segs = [];
    [0.5, 1.5, 2.4, 3.4, 4.5, 6, 8, 10, 12.5].forEach(a2 => {
      const start = xs.length;
      for (let x = -3; x <= 3; x += 0.4) for (let y = -3; y <= 3; y += 0.4) {
        const s2 = Math.hypot(x - site.x, y - site.y);
        xs.push(x); ys.push(y); zs.push(_xsBeamHeightKm(s2, a2, 0)); vs.push(62); rs.push(0.4, s2 * 0.00873);
      }
      segs.push({ start, end: xs.length, angle: a2 });
    });
    const frame = _r3dFinishFrame({ xs, ys, zs, vs, rs, site }, segs, null, segs.length);
    _r3dFrames = [frame];
    _r3dFrameIdx = 0;
    _r3dQuality = 'fine';
    _r3dCam.yaw = 0.6; _r3dCam.pitch = 0.35; _r3dCam.dist = 60;
    const cv = document.getElementById('r3d-canvas');
    const ctx = cv.getContext('2d');
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(15000); };
    // Lit red comes out in many shades, so the net is wide: reddish and
    // clearly not grey. topRow is the highest scanline any red reaches.
    const reds = () => {
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, topRow = cv.height;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 90 && data[i] > data[i + 1] * 2 && data[i] > data[i + 2] * 2) {
          n++;
          const row = (i >> 2) / cv.width | 0;
          if (row < topRow) topRow = row;
        }
      }
      return { n, topRow };
    };
    _r3dHeightMaxKft = 60; _r3dFilterPct = 0; _r3dLutCache = null;
    await R(); const full = reds();
    _r3dHeightMaxKft = 10;                               // 10 kft is about 3 km
    await R(); const capped = reds();
    _r3dHeightMaxKft = 60; _r3dFilterPct = 90; _r3dLutCache = null;  // cutoff 70 dBZ
    await R(); const filtered = reds();
    _r3dHeightMaxKft = savedH; _r3dFilterPct = savedF; _r3dLutCache = null;
    Object.assign(_r3dCam, savedCam);
    _r3dClose();
    return { full, capped, filtered };
  });
  ok('the storm paints a real area of solid red, not scattered dots',
     r.full.n > 400, String(r.full.n));
  ok('capping the height brings the storm top visibly down the screen',
     r.capped.n > 0 && r.capped.topRow > r.full.topRow + 20,
     JSON.stringify(r));
  ok('filtering above its strength removes it, floor included',
     r.filtered.n < 30, String(r.filtered.n));
}

console.log('\n7b. lit, solid, thinner, and cut open: the controls gauged from GR2Analyst, OpenStorm and RadarOmega');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    const site = { x: 0, y: -60 };
    const xs = [], ys = [], zs = [], vs = [], rs = [], segs = [];
    [0.5, 1.5, 2.4, 3.4, 4.5, 6, 8].forEach(a2 => {
      const start = xs.length;
      for (let x = -3; x <= 3; x += 0.4) for (let y = -3; y <= 3; y += 0.4) {
        const s2 = Math.hypot(x - site.x, y - site.y);
        xs.push(x); ys.push(y); zs.push(_xsBeamHeightKm(s2, a2, 0)); vs.push(62); rs.push(0.4, s2 * 0.00873);
      }
      segs.push({ start, end: xs.length, angle: a2 });
    });
    const frame = _r3dFinishFrame({ xs, ys, zs, vs, rs, site }, segs, null, segs.length);
    _r3dFrames = [frame]; _r3dFrameIdx = 0; _r3dQuality = 'fine';
    _r3dCam.yaw = 0.6; _r3dCam.pitch = 0.35; _r3dCam.dist = 50;
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(15000); };
    const saved = { h: _r3dHeightMaxKft, f: _r3dFilterPct, o: _r3dOpacity, m: _r3dMode, c: _r3dCutSide, p: _r3dCutPct };
    _r3dHeightMaxKft = 80; _r3dFilterPct = 0; _r3dOpacity = 1; _r3dMode = 'cloud'; _r3dCutSide = 'off'; _r3dLutCache = null;
    const cv = document.getElementById('r3d-canvas'), ctx = cv.getContext('2d');
    const reds = () => {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const vals = [];
      for (let i = 0; i < d.length; i += 4) if (d[i] > 60 && d[i + 1] < 45 && d[i + 2] < 45) vals.push(d[i]);
      vals.sort((a, b) => a - b);
      return { n: vals.length, lo: vals[Math.floor(vals.length * 0.1)] || 0, hi: vals[Math.floor(vals.length * 0.9)] || 0 };
    };
    await R(); const lit = reds();
    _r3dMode = 'solid'; _r3dLutCache = null; await R(); const solid = reds();
    _r3dMode = 'cloud'; _r3dOpacity = 0.25; _r3dLutCache = null; await R(); const thin = reds();
    _r3dOpacity = 1; _r3dLutCache = null;
    _r3dCutSide = 'e'; _r3dCutPct = 70; await R(); const cutAway = reds();   // the east 70% is gone: the block sat at x = 0
    _r3dCutSide = 'e'; _r3dCutPct = 20; await R(); const cutShallow = reds();
    // The controls themselves.
    const sel = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
    const inp = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    sel('r3d-mode', 'solid'); sel('r3d-cut', 'n'); inp('r3d-cutpct', '35'); inp('r3d-opacity', '250');
    const wired = { mode: _r3dMode, cut: _r3dCutSide, pct: _r3dCutPct, opacity: _r3dOpacity,
                    label: document.getElementById('r3d-opacity-label').textContent };
    sel('r3d-mode', 'cloud'); sel('r3d-cut', 'off'); inp('r3d-cutpct', '50'); inp('r3d-opacity', '100');
    Object.assign({}, saved); _r3dHeightMaxKft = saved.h; _r3dFilterPct = saved.f; _r3dOpacity = saved.o; _r3dMode = saved.m; _r3dCutSide = saved.c; _r3dCutPct = saved.p; _r3dLutCache = null;
    _r3dClose();
    return { lit, solid, thin, cutAway, cutShallow, wired };
  });
  ok('the block is lit: its faces come out in clearly different shades of the same red',
     r.lit.n > 400 && (r.lit.hi - r.lit.lo) >= 18, JSON.stringify(r.lit));
  ok('Solid surface draws an opaque shell, at least as much red as the cloud',
     r.solid.n >= r.lit.n * 0.9, JSON.stringify({ solid: r.solid.n, lit: r.lit.n }));
  ok('a quarter opacity draws a visibly thinner cloud', r.thin.n < r.lit.n, JSON.stringify({ thin: r.thin.n, lit: r.lit.n }));
  ok('cutting 70% in from the east removes the block entirely', r.cutAway.n < 20, String(r.cutAway.n));
  ok('a shallow 20% cut leaves it standing', r.cutShallow.n > 400, String(r.cutShallow.n));
  ok('the Look, Cutaway and Opacity controls drive the state',
     r.wired.mode === 'solid' && r.wired.cut === 'n' && r.wired.pct === 35 && r.wired.opacity === 2.5 && /2\.5/.test(r.wired.label),
     JSON.stringify(r.wired));
}

console.log('\n7c. Raw pixels: the exact gates, unshaded and crisp, plus the glowing core and fullscreen');
{
  ok('the marcher takes a crisp flag that turns off blending and the light',
     /const crisp = !!prm\.crisp, lerp = fine && !crisp;/.test(PAGE)
     && /crisp: _r3dMode === 'pixels' \? 1 : 0/.test(PAGE)
     && PAGE.includes('<option value="pixels">Raw pixels</option>'));
  ok('the panel has a fullscreen button and a viewport-pinned fullscreen state',
     PAGE.includes('id="r3d-full"') && /#r3d-panel\.fullscreen \{/.test(PAGE));
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    const site = { x: 0, y: -60 };
    const xs = [], ys = [], zs = [], vs = [], rs = [], segs = [];
    [0.5, 1.5, 2.4, 3.4, 4.5, 6, 8].forEach(a2 => {
      const start = xs.length;
      for (let x = -3; x <= 3; x += 0.4) for (let y = -3; y <= 3; y += 0.4) {
        const s2 = Math.hypot(x - site.x, y - site.y);
        xs.push(x); ys.push(y); zs.push(_xsBeamHeightKm(s2, a2, 0)); vs.push(62); rs.push(0.4, s2 * 0.00873);
      }
      segs.push({ start, end: xs.length, angle: a2 });
    });
    const frame = _r3dFinishFrame({ xs, ys, zs, vs, rs, site }, segs, null, segs.length);
    _r3dFrames = [frame]; _r3dFrameIdx = 0; _r3dQuality = 'fine';
    _r3dCam.yaw = 0.6; _r3dCam.pitch = 0.35; _r3dCam.dist = 50;
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(15000); };
    const saved = { f: _r3dFilterPct, o: _r3dOpacity, m: _r3dMode };
    _r3dFilterPct = 0; _r3dOpacity = 1; _r3dCutSide = 'off';
    const cv = document.getElementById('r3d-canvas'), ctx = cv.getContext('2d');
    const reds = () => {
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const vals = [];
      for (let i = 0; i < d.length; i += 4) if (d[i] > 60 && d[i + 1] < 45 && d[i + 2] < 45) vals.push(d[i]);
      vals.sort((a, b) => a - b);
      return { n: vals.length, lo: vals[Math.floor(vals.length * 0.1)] || 0, hi: vals[Math.floor(vals.length * 0.9)] || 0 };
    };
    _r3dMode = 'cloud'; _r3dLutCache = null; await R(); const lit = reds();
    _r3dMode = 'pixels'; _r3dLutCache = null; await R(); const pix = reds();
    // The transfer function itself: pixels is flat, cloud curves and glows.
    const spec = _r3dSpec('ref');
    const b30 = _r3dNormByte(30, spec), b65 = _r3dNormByte(65, spec);
    _r3dMode = 'pixels'; _r3dLutCache = null;
    const pl = _r3dLutFor('ref', 0.5).lut;
    const flat = pl[b30 * 4 + 3] > 0 && Math.abs(pl[b30 * 4 + 3] - pl[b65 * 4 + 3]) < 1e-6;
    _r3dMode = 'cloud'; _r3dLutCache = null;
    const cl = _r3dLutFor('ref', 0.5);
    const curved = Math.abs(cl.lut[b30 * 4 + 3] - cl.lut[b65 * 4 + 3]) > 1e-4;
    const glowRatio = (cl.lut[b65 * 4] / Math.max(1e-6, cl.lut[b65 * 4 + 3]))
                    / Math.max(1, cl.floorRgb[b65 * 3]);
    // Fullscreen: the button, Esc, and closing the panel all leave it clean.
    const panel = document.getElementById('r3d-panel');
    document.getElementById('r3d-full').click();
    const fsOn = panel.classList.contains('fullscreen');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const fsEsc = panel.classList.contains('fullscreen');
    document.getElementById('r3d-full').click();
    panel.querySelector('.xs-x').click();
    const fsClosed = panel.classList.contains('fullscreen');
    _r3dFilterPct = saved.f; _r3dOpacity = saved.o; _r3dMode = saved.m; _r3dLutCache = null;
    return { lit, pix, flat, curved, glowRatio, fsOn, fsEsc, fsClosed };
  });
  ok('Raw pixels still draws the whole block', r.pix.n > 400, JSON.stringify(r.pix));
  // Brightness still varies in pixels mode - the raw cones and the fade at
  // the stack's edges are the point of it - but the LIGHT is off, so no
  // face is dimmed below its palette colour the way the lit cloud's are.
  ok('and unshaded: its brightest red is at least the lit cloud\'s, nothing darkened by the light',
     r.pix.hi >= r.lit.hi, JSON.stringify({ pix: r.pix, lit: r.lit }));
  ok('the pixels transfer function is flat while the cloud one still curves',
     r.flat && r.curved, JSON.stringify({ flat: r.flat, curved: r.curved }));
  ok('the strongest returns glow brighter than their own palette colour in cloud mode',
     r.glowRatio > 1.15, String(r.glowRatio));
  ok('fullscreen toggles on, Esc leaves it, and closing the panel always leaves it',
     r.fsOn === true && r.fsEsc === false && r.fsClosed === false,
     JSON.stringify({ on: r.fsOn, esc: r.fsEsc, closed: r.fsClosed }));
}

console.log('\n7d. walking inside the box, and the honest (WebGL-free) VR');
{
  ok('walk state, the shared camera basis, and stereo eyes are in the page',
     /let _r3dWalk = null;/.test(PAGE)
     && /function _r3dCamBasis\(eye\) \{/.test(PAGE)
     && /const eyes = _r3dVr \? \[-1, 1\] : \[0\];/.test(PAGE));
  ok('the panel has Walk and VR buttons and a held-button movement pad',
     PAGE.includes('id="r3d-walk-btn"') && PAGE.includes('id="r3d-vr-btn"')
     && PAGE.includes('id="r3d-walk-pad"'));
  ok('WASD, arrows and E/Q are mapped, captured only while walking',
     /const R3D_KEYMAP = \{ w: 'fwd', s: 'back', a: 'left', d: 'right', e: 'up', q: 'down',/.test(PAGE)
     && /if \(!_r3dOn \|\| !_r3dWalk\) return;/.test(PAGE));
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    const site = { x: 0, y: -60 };
    const xs = [], ys = [], zs = [], vs = [], rs = [], segs = [];
    [0.5, 1.5, 2.4, 3.4, 4.5, 6, 8].forEach(a2 => {
      const start = xs.length;
      for (let x = -3; x <= 3; x += 0.4) for (let y = -3; y <= 3; y += 0.4) {
        const s2 = Math.hypot(x - site.x, y - site.y);
        xs.push(x); ys.push(y); zs.push(_xsBeamHeightKm(s2, a2, 0)); vs.push(62); rs.push(0.4, s2 * 0.00873);
      }
      segs.push({ start, end: xs.length, angle: a2 });
    });
    const frame = _r3dFinishFrame({ xs, ys, zs, vs, rs, site }, segs, null, segs.length);
    _r3dFrames = [frame]; _r3dFrameIdx = 0; _r3dQuality = 'fine';
    _r3dMode = 'cloud'; _r3dFilterPct = 0; _r3dOpacity = 1; _r3dLutCache = null;
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(20000); };
    const cv = document.getElementById('r3d-canvas'), ctx = cv.getContext('2d');
    const reds = (x0, x1) => {
      const d = ctx.getImageData(x0, 0, x1 - x0, cv.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 60 && d[i + 1] < 45 && d[i + 2] < 45) n++;
      return n;
    };
    const out = {};
    // In: standing inside, facing the centre.
    _r3dWalkToggle(true);
    out.walkOn = !!_r3dWalk;
    out.padShown = document.getElementById('r3d-walk-pad').style.display !== 'none';
    out.btnLit = document.getElementById('r3d-walk-btn').classList.contains('on');
    out.facingCentre = Math.abs(_r3dWalk.yaw - Math.atan2(-_r3dWalk.x, -_r3dWalk.y)) < 1e-9;
    await R();
    out.seesBlock = reds(0, cv.width);
    // Moving: a held key walks the viewer forward on the display clock.
    const distBefore = Math.hypot(_r3dWalk.x, _r3dWalk.y);
    _r3dMoveKeys.add('fwd');
    _r3dWalkLastTs = 1000;
    _r3dWalkStep(1100);
    _r3dMoveKeys.delete('fwd');
    out.movedIn = Math.hypot(_r3dWalk.x, _r3dWalk.y) < distBefore - 1;
    // The keyboard maps onto the same held-keys set.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true, cancelable: true }));
    out.keyHeld = _r3dMoveKeys.has('fwd');
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true }));
    out.keyReleased = !_r3dMoveKeys.has('fwd');
    // VR: fullscreen, both eye halves genuinely drawn. The browser's own
    // full screen is recorded rather than entered (headless has no screen).
    const pnl = document.getElementById('r3d-panel');
    let fsAsked = 0;
    pnl.requestFullscreen = () => { fsAsked++; return Promise.resolve(); };
    _r3dVrToggle();
    out.vrOn = _r3dVr === true;
    out.vrFullscreen = pnl.classList.contains('fullscreen');
    out.fsAsked = fsAsked;
    out.immersive = pnl.classList.contains('vr-immersive')
      && getComputedStyle(pnl.querySelector('.p3d-top')).display === 'none'
      && getComputedStyle(pnl.querySelector('.p3d-vr-exit')).display !== 'none'
      && Math.abs(cv.getBoundingClientRect().height - innerHeight) < 2;
    await R();
    const half = Math.floor(cv.width / 2);
    out.leftEye = reds(0, half);
    out.rightEye = reds(half, cv.width);
    // Leaving full screen the system's way (Esc, back swipe) leaves VR too.
    document.dispatchEvent(new Event('fullscreenchange'));
    out.sysExit = _r3dVr === false && !pnl.classList.contains('vr-immersive') && !pnl.classList.contains('fullscreen');
    _r3dVrToggle();
    pnl.querySelector('.p3d-vr-exit').click();
    out.btnExit = _r3dVr === false && !pnl.classList.contains('vr-immersive');
    // Out: everything hands back cleanly.
    _r3dVrOff();
    _r3dWalkToggle(false);
    out.walkOff = _r3dWalk === null && _r3dVr === false;
    out.padHidden = document.getElementById('r3d-walk-pad').style.display === 'none';
    document.getElementById('r3d-panel').classList.remove('fullscreen');
    _r3dClose();
    return out;
  });
  ok('Walk puts the viewer inside, facing the centre, pad up and button lit',
     r.walkOn && r.padShown && r.btnLit && r.facingCentre, JSON.stringify(r));
  ok('the block is visible from inside the box', r.seesBlock > 50, String(r.seesBlock));
  ok('a held forward key genuinely walks the viewer inward', r.movedIn === true);
  ok('the keyboard drives the held-keys set, and releases cleanly',
     r.keyHeld === true && r.keyReleased === true, JSON.stringify([r.keyHeld, r.keyReleased]));
  ok('VR goes fullscreen and draws the storm into BOTH eye halves',
     r.vrOn && r.vrFullscreen && r.leftEye > 25 && r.rightEye > 25,
     JSON.stringify({ left: r.leftEye, right: r.rightEye }));
  ok('VR asks the browser for true full screen and shows only the stereo picture',
     r.fsAsked === 1 && r.immersive, JSON.stringify({ fs: r.fsAsked, imm: r.immersive, now: r.fsNow }));
  ok('leaving full screen by the system gesture, or Exit VR, brings the panel back',
     r.sysExit && r.btnExit, JSON.stringify([r.sysExit, r.btnExit]));
  ok('walking and VR shut off cleanly, pad hidden again',
     r.walkOff && r.padHidden, JSON.stringify([r.walkOff, r.padHidden]));
}

console.log('\n7e. the You dot in the box, and walking spawns where you stand');
{
  ok('a user fix is kept, converted into the zone\'s own km frame, and asked for silently on open',
     /let _r3dUserFix = null;/.test(PAGE)
     && /function _r3dZoneKmOf\(lat, lng\) \{/.test(PAGE)
     && /function _r3dFetchUserFix\(\) \{/.test(PAGE)
     && PAGE.includes("navigator.permissions.query({ name: 'geolocation' })"));
  ok('the live map location marker is preferred over the one-shot fix',
     /if \(typeof _locMarker !== 'undefined' && _locMarker\) \{/.test(PAGE));
  const r = await p.evaluate(async () => {
    const out = {};
    _r3dOpen('kfws');
    _r3dToken++;
    _r3dFrames = []; _r3dFrameIdx = -1;
    _r3dQuality = 'fine';
    // Looking down from high up, so a spot on the floor a few km from the
    // centre is inside the little canvas.
    _r3dCam.yaw = 0.6; _r3dCam.pitch = 1.1; _r3dCam.dist = 110;
    // Standing 5-ish km northeast of the zone centre.
    _r3dUserFix = { lat: _r3dZone.lat + 0.05, lng: _r3dZone.lng + 0.05 };
    const me = _r3dZoneKmOf(_r3dUserFix.lat, _r3dUserFix.lng);
    out.meKm = [me.x, me.y];
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(15000); };
    await R();
    const cv = document.getElementById('r3d-canvas'), ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 55 && d[i] < 100 && d[i + 1] > 140 && d[i + 1] < 180
          && d[i + 2] > 195 && d[i + 2] < 240) blue++;
    }
    out.bluePx = blue;
    // Walking spawns at that exact spot, eye height, facing the centre.
    _r3dWalkToggle(true);
    out.spawnAtMe = Math.abs(_r3dWalk.x - me.x) < 1e-9 && Math.abs(_r3dWalk.y - me.y) < 1e-9;
    out.eyeLevel = _r3dWalk.z > 0 && _r3dWalk.z <= 1.5;
    out.facing = Math.abs(_r3dWalk.yaw - Math.atan2(-me.x, -me.y)) < 1e-9;
    _r3dWalkToggle(false);
    // A fix far outside the zone falls back to the old rim spawn.
    _r3dUserFix = { lat: _r3dZone.lat + 3.0, lng: _r3dZone.lng + 3.0 };
    _r3dWalkToggle(true);
    const far = _r3dZoneKmOf(_r3dUserFix.lat, _r3dUserFix.lng);
    out.outsideFallsBack = Math.abs(_r3dWalk.x - far.x) > 1;
    _r3dWalkToggle(false);
    _r3dUserFix = null;
    _r3dClose();
    return out;
  });
  ok('the fix lands a few km northeast in zone coordinates',
     r.meKm[0] > 3 && r.meKm[0] < 8 && r.meKm[1] > 3 && r.meKm[1] < 8,
     JSON.stringify(r.meKm));
  ok('the You dot is genuinely painted in the box, in the map\'s own location blue',
     r.bluePx >= 6, String(r.bluePx));
  ok('walking spawns exactly where you stand, at eye height, facing the storm',
     r.spawnAtMe && r.eyeLevel && r.facing, JSON.stringify(r));
  ok('standing far outside the zone falls back to the rim spawn instead',
     r.outsideFallsBack === true);
}

console.log('\n8. the volume follows the drawn box: only the window the zone occupies, re-binned in place');
{
  const r = await p.evaluate(() => {
    const savedZone = _r3dZone;
    const site = { x: 0, y: -60 };
    const z1 = _xsBeamHeightKm(60, 0.5, 0);
    const frame = { gates: new Float32Array([0, 0, z1, 55]), count: 1,
                    segs: [{ start: 0, end: 1, angle: 0.5 }], time: null, cuts: 1, site, _grids: {} };
    _r3dZone = { lat: 36, lng: -96, wKm: 90, hKm: 60 };
    const wide = _r3dPolarFor(frame, 'ref');
    _r3dZone = { lat: 36, lng: -96, wKm: 30, hKm: 30 };
    const small = _r3dPolarFor(frame, 'ref');
    const oneCached = Object.keys(frame._grids).length;
    // A radar inside its own box sees the whole circle.
    const inFrame = { gates: new Float32Array([5, 5, 0.4, 55]), count: 1,
                      segs: [{ start: 0, end: 1, angle: 0.5 }], time: null, cuts: 1, site: { x: 0, y: 0 }, _grids: {} };
    const round = _r3dPolarFor(inFrame, 'ref');
    _r3dZone = savedZone;
    return { wide: { span: wide.span, full: wide.full, nR: wide.nR, nA: wide.nA, rStep: wide.rStep },
             small: { span: small.span, nR: small.nR, nA: small.nA },
             oneCached, round: { full: round.full, r0: round.r0 } };
  });
  ok('a box seen from outside gets only its own wedge of azimuth, at native bins',
     !r.wide.full && r.wide.span < 120 && r.wide.rStep === 0.25, JSON.stringify(r.wide));
  ok('a smaller box means a smaller window, same fineness', r.small.nR < r.wide.nR && r.small.nA < r.wide.nA,
     JSON.stringify([r.small, { nR: r.wide.nR, nA: r.wide.nA }]));
  ok('only the current box stays cached per frame', r.oneCached === 1, String(r.oneCached));
  ok('a radar inside the box sees the whole circle from range zero',
     r.round.full && r.round.r0 === 0, JSON.stringify(r.round));
}

console.log('\n8b. a box can be drawn as big as the screen lets you, with no upper cap');
{
  const r = await p.evaluate(() => {
    const savedZone = _r3dZone, savedOn = _r3dOn, savedStation = _r3dStation;
    const pos = _xsSiteLatLon('kfws');
    // Five degrees on a side is roughly 550 km, comfortably past the old
    // 300 km trim, and this box is centred right on the radar so the
    // nearest-station distance check has nothing to do with its size.
    const ok1 = _r3dOpenBounds(pos.lat - 2.5, pos.lng - 2.5, pos.lat + 2.5, pos.lng + 2.5);
    const zone = ok1 ? { wKm: _r3dZone.wKm, hKm: _r3dZone.hKm } : null;
    _r3dZone = savedZone; _r3dOn = savedOn; _r3dStation = savedStation;
    const panel = document.getElementById('r3d-panel');
    if (panel) panel.classList.remove('open');
    // _r3dOpenBounds finishing means it also kicked off a real _r3dOpen
    // load in the background, aimed at a network this test file has no
    // route for. Bumping the token orphans that in-flight attempt (every
    // await inside it checks token against _r3dToken and bails), and
    // clearing the busy flag directly means later tests are not left
    // reading "already loading a volume" from a fetch nothing ever
    // answers - the same abandon-in-flight pattern the Time Machine jump
    // already relies on elsewhere in this file.
    ++_r3dToken; _r3dBuilding = false;
    return { ok1, zone };
  });
  ok('the box actually opened', r.ok1 === true, JSON.stringify(r));
  ok('and kept its real, huge size instead of being trimmed to 300 km',
     r.zone && r.zone.wKm > 400 && r.zone.hKm > 400, JSON.stringify(r.zone));
}

console.log('\n8c. the Smoothing slider blends measured values, but never invents new ones');
{
  const r = await p.evaluate(() => {
    const savedZone = _r3dZone, savedSmoothing = _r3dSmoothing;
    _r3dZone = { lat: 36, lng: -96, wKm: 30, hKm: 30 };
    const site = { x: 0, y: -20 };
    // Two adjacent gates at the same tilt, one strong and one weaker,
    // plus one isolated gate at a different tilt, with plenty of empty
    // air around all three.
    const z1 = _xsBeamHeightKm(20, 0.5, 0);
    const z2 = _xsBeamHeightKm(20, 1.5, 0);
    const frame = {
      gates: new Float32Array([0, 0, z1, 55, 0.3, 0, z1, 35, 6, 6, z2, 45]),
      count: 3,
      segs: [{ start: 0, end: 2, angle: 0.5 }, { start: 2, end: 3, angle: 1.5 }],
      time: null, cuts: 1, site, _grids: {},
    };
    _r3dSmoothing = 0;
    const off = _r3dPolarFor(frame, 'ref');
    const offSweeps = off.sweeps.map(pl => pl.slice());
    frame._grids = {};
    _r3dSmoothing = 1;
    const on = _r3dPolarFor(frame, 'ref');
    const onSweeps = on.sweeps.map(pl => pl.slice());
    // Count how many bins hold a nonzero byte, off vs. smoothed, and
    // whether any bin that was 0 with smoothing off is still 0 with it on.
    let offNonzero = 0, onNonzero = 0, grewIntoAir = false, changed = false;
    for (let s = 0; s < offSweeps.length; s++) {
      for (let i = 0; i < offSweeps[s].length; i++) {
        const o = offSweeps[s][i], n = onSweeps[s][i];
        if (o) offNonzero++;
        if (n) onNonzero++;
        if (!o && n) grewIntoAir = true;
        if (o && n && o !== n) changed = true;
      }
    }
    _r3dZone = savedZone; _r3dSmoothing = savedSmoothing;
    return { offNonzero, onNonzero, grewIntoAir, changed,
             diffCache: off !== on };
  });
  ok('the same number of bins hold a value whether smoothing is on or off',
     r.offNonzero === r.onNonzero && r.offNonzero > 0, JSON.stringify(r));
  ok('smoothing never turns previously-empty air into a painted bin',
     r.grewIntoAir === false, JSON.stringify(r));
  ok('but it does actually blend the values that are there',
     r.changed === true, JSON.stringify(r));
  ok('a different smoothing level is a different cached grid, not a stale reuse',
     r.diffCache === true, JSON.stringify(r));
}

console.log('\n9. Level 3 builds the same frame from separate tilt files');
{
  const r = await p.evaluate(async () => {
    const N = 12, step = 0.03, lon0 = -97.3, lat0 = 35.2;
    const makeMesh = (val) => {
      const mesh = new Float32Array(N * N * 9);
      let k = 0;
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const x = lon0 + gx * step, y = lat0 + gy * step;
          mesh[k++] = x;        mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y;
          mesh[k++] = x + step; mesh[k++] = y + step;
          mesh[k++] = x;        mesh[k++] = y + step;
          mesh[k++] = val;
        }
      }
      return mesh;
    };
    const ANGLES = { N0B: 0.5, N1B: 1.5, N2B: 2.4, N3B: 3.4 };
    const askedCodes = [];
    const realBucketNewest = window._l3BucketNewest;
    const realFetch = window.fetch;
    const realWorker = window._workerProcess, realPool = window._pbDecode;
    window._l3BucketNewest = async (site, code) => {
      askedCodes.push(code);
      return ANGLES[code] != null ? `fake://${site}/${code}` : null;
    };
    window.fetch = async (url, opts) => {
      if (String(url).startsWith('fake://')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      return realFetch(url, opts);
    };
    const fake = async (buf, code) => {
      const angle = ANGLES[code];
      if (angle == null) throw new Error('unknown Level 3 code ' + code);
      return {
        meshData: makeMesh(50), bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step],
        metadata: { elevationAngle: angle, timeIso: new Date().toISOString() },
      };
    };
    window._workerProcess = fake; window._pbDecode = fake;

    const sitePos = { lat: 35.0, lng: -97.3 };
    const zone = { lat: 35.4, lng: -97.1, wKm: 90, hKm: 90 };
    const token = ++_r3dToken;
    const frame = await _r3dBuildFrameL3('kfws', 'ref', sitePos, zone, token);

    window._l3BucketNewest = realBucketNewest;
    window.fetch = realFetch;
    window._workerProcess = realWorker; window._pbDecode = realPool;

    return {
      askedCodes,
      count: frame ? frame.count : 0,
      cuts: frame ? frame.cuts : 0,
      segAngles: frame ? frame.segs.map(s => s.angle) : [],
    };
  });
  ok('it asked for the four reflectivity tilt codes, in order',
     r.askedCodes.join(',') === 'N0B,N1B,N2B,N3B', r.askedCodes.join(','));
  ok('and built real gates from all four separate files', r.count > 0 && r.cuts === 4,
     JSON.stringify(r));
  ok('each tilt kept its own real elevation angle',
     r.segAngles.join(',') === '0.5,1.5,2.4,3.4', r.segAngles.join(','));
}

console.log('\n10. the load path reaches for Level 3 exactly when it should');
{
  const r = await p.evaluate(async () => {
    const realFetchDirect = window._fetchVolumeDirect;
    const realBuildL3 = window._r3dBuildFrameL3;
    const l3Calls = [];
    window._r3dBuildFrameL3 = async (site) => {
      l3Calls.push(site);
      return { gates: new Float32Array([0, 0, 1, 40]), count: 1,
               segs: [{ start: 0, end: 1, angle: 0.5 }], time: null, cuts: 1, _grids: {} };
    };

    // A TDWR terminal radar has no Level 2 archive at all - the load should
    // never even try _fetchVolumeDirect for one.
    let fetchDirectCalled = false;
    window._fetchVolumeDirect = async () => { fetchDirectCalled = true; throw new Error('should not be called'); };
    _r3dZone = { lat: 32.9, lng: -97.0, wKm: 90, hKm: 90 };
    _r3dStation = 'tdal'; _r3dStationKm = 15;
    await _r3dLoad();
    const tdwr = { status: document.getElementById('r3d-status').textContent,
                   fetchDirectCalled };

    // A NEXRAD site still tries Level 2 first, and only falls back to Level
    // 3 when that attempt genuinely fails. The flat picture's cached volume
    // (bottom sweeps only, no `full` mark) must NOT be taken as the whole
    // stack: the fetch has to happen, and for the whole volume.
    fetchDirectCalled = false;
    let capAsked = null;
    window._fetchVolumeDirect = async (site, cap) => { fetchDirectCalled = true; capAsked = cap; throw new Error('no volume'); };
    const keepCache = window._l2VolCache;
    _l2VolCache = { station: 'kfws', at: Date.now(), buf: new ArrayBuffer(4096) };   // capped, not full
    _r3dStation = 'kfws';
    await _r3dLoad();
    const nexrad = { status: document.getElementById('r3d-status').textContent,
                      fetchDirectCalled, capAsked };
    _l2VolCache = keepCache;

    window._fetchVolumeDirect = realFetchDirect;
    window._r3dBuildFrameL3 = realBuildL3;
    _r3dClose();
    return { l3Calls, tdwr, nexrad };
  });
  ok('a TDWR site skips the Level 2 attempt entirely', !r.tdwr.fetchDirectCalled, JSON.stringify(r.tdwr));
  ok('and goes straight to the Level 3 build', r.l3Calls.includes('tdal'), r.l3Calls.join(','));
  ok('its status names Level 3', /Level 3/.test(r.tdwr.status), r.tdwr.status);
  ok('a NEXRAD site still tries Level 2 first, ignoring the picture\'s bottom-sweeps cache',
     r.nexrad.fetchDirectCalled);
  ok('and asks for the WHOLE volume, not the picture\'s few-MB cap',
     r.nexrad.capAsked >= 40 * 1024 * 1024, String(r.nexrad.capAsked));
  ok('and falls back to Level 3 once that attempt fails',
     r.l3Calls.includes('kfws') && /Level 3/.test(r.nexrad.status), JSON.stringify(r.nexrad));
}

console.log('\n10b. a whole Level 2 volume: shown tilt by tilt, history pulled whole and skipping the live one');
{
  const r = await p.evaluate(async () => {
    const realFetchDirect = window._fetchVolumeDirect, realRecent = window._fetchRecentVolumes;
    const realWorker = window._workerProcess, realPool = window._pbDecode;
    const N = 8, step = 0.03, lon0 = -97.15, lat0 = 35.35;
    const mesh = new Float32Array(N * N * 9);
    { let k = 0; for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const x = lon0 + gx * step, y = lat0 + gy * step;
        mesh[k++] = x; mesh[k++] = y; mesh[k++] = x + step; mesh[k++] = y;
        mesh[k++] = x + step; mesh[k++] = y + step; mesh[k++] = x; mesh[k++] = y + step;
        mesh[k++] = 48; } }
    const ANGLES = { 1: 0.5, 2: 1.5, 3: 2.4 };
    const fake = async (buf, layer, opts) => {
      const el = (opts && opts.elevation) || 1;
      await new Promise(res => setTimeout(res, 2));
      return { meshData: mesh.slice(0), bounds: [lon0, lat0, lon0 + N * step, lat0 + N * step],
        metadata: { availableElevations: [1, 2, 3], elevationNumber: el,
                    elevationAngle: ANGLES[el], timeIso: '2026-09-17T12:00:00Z' } };
    };
    window._workerProcess = fake; window._pbDecode = fake;
    let capAsked = null, completeAsked = null, recentArgs = null;
    window._fetchVolumeDirect = async (site, cap, complete) => { capAsked = cap; completeAsked = complete; return new ArrayBuffer(16); };
    window._fetchRecentVolumes = async (site, n, cap, startBack, complete) => { recentArgs = [n, cap, startBack, complete]; return []; };
    const keepCache = window._l2VolCache;
    const statuses = [];
    const realSay = window._r3dSay;
    window._r3dSay = (m, k) => { statuses.push(m); realSay(m, k); };
    _r3dZone = { lat: 35.5, lng: -97.0, wKm: 90, hKm: 90 };
    _r3dStation = 'ktlx'; _r3dStationKm = 60;
    await _r3dLoad();
    await new Promise(res => setTimeout(res, 30));
    const out = {
      capAsked, completeAsked, recentArgs,
      cacheMarkedFull: !!(_l2VolCache && _l2VolCache.full && _l2VolCache.station === 'ktlx'),
      progressSeen: statuses.filter(s => /decoding tilt \d of \d/.test(s)).length,
      cuts: _r3dFrames[0] ? _r3dFrames[0].cuts : 0,
      final: document.getElementById('r3d-status').textContent,
    };
    window._r3dSay = realSay;
    _l2VolCache = keepCache;
    window._fetchVolumeDirect = realFetchDirect; window._fetchRecentVolumes = realRecent;
    window._workerProcess = realWorker; window._pbDecode = realPool;
    _r3dClose();
    return out;
  });
  ok('the live volume is fetched whole', r.capAsked >= 40 * 1024 * 1024, String(r.capAsked));
  ok('and only a FINISHED volume is accepted, never one still being written',
     r.completeAsked === true && r.recentArgs && r.recentArgs[3] === true, JSON.stringify(r.recentArgs));
  ok('and the cache is marked as the whole thing for next time', r.cacheMarkedFull);
  ok('every tilt was announced as it landed', r.progressSeen === 3, String(r.progressSeen));
  ok('all three cuts are in the frame', r.cuts === 3, String(r.cuts));
  ok('history is asked for whole volumes too, skipping the live one already on screen',
     r.recentArgs && r.recentArgs[0] === 3 && r.recentArgs[1] >= 40 * 1024 * 1024 && r.recentArgs[2] === 1,
     JSON.stringify(r.recentArgs));
  ok('the status ends on the gate count', /gates/.test(r.final), r.final);
}

console.log('\n10c. a half-written volume is refused, a finished one is taken');
{
  const r = await p.evaluate(async () => {
    const realXml = window._s3Xml, realFetch = window.fetch;
    const listing = (keys) => new DOMParser().parseFromString(
      '<ListBucketResult>' + keys.map(k =>
        `<Contents><Key>KTLX/9/${k}</Key><Size>30000</Size></Contents>`).join('') + '</ListBucketResult>',
      'text/xml');
    const inProgress = ['20260917-120000-001-S', ...Array.from({ length: 9 }, (_, i) =>
      `20260917-120000-${String(i + 2).padStart(3, '0')}-I`)];          // antenna still turning
    const finished = [...inProgress, '20260917-120000-011-E'];          // scan done
    let keys = inProgress;
    window._s3Xml = async () => listing(keys);
    window.fetch = async (url, opts) => {
      if (String(url).includes('KTLX/9/')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(30000) };
      return realFetch(url, opts);
    };
    const partialStrict = await _assembleVolume('KTLX', '9', 1e9, true);
    const partialLoose = await _assembleVolume('KTLX', '9', 1e9, false);
    keys = finished;
    const wholeStrict = await _assembleVolume('KTLX', '9', 1e9, true);
    window._s3Xml = realXml; window.fetch = realFetch;
    return { partialStrict: partialStrict === null, partialLoose: !!partialLoose,
             wholeStrict: wholeStrict ? wholeStrict.byteLength : 0 };
  });
  ok('a volume with no end chunk is refused when a whole one is required', r.partialStrict);
  ok('the flat picture still accepts it (its low tilts are all it needs)', r.partialLoose);
  ok('once the -E chunk exists the whole volume comes back', r.wholeStrict === 11 * 30000, String(r.wholeStrict));
}

console.log('\n11. the orbit camera, the quality switch, and the panel controls');
{
  const r = await p.evaluate(async () => {
    const sleep = ms => new Promise(res => setTimeout(res, ms));
    _r3dOpen('kfws');
    const openState = {
      panel: document.getElementById('r3d-panel').classList.contains('open'),
    };
    const cv = document.getElementById('r3d-canvas');
    const before = { yaw: _r3dCam.yaw, pitch: _r3dCam.pitch, dist: _r3dCam.dist };
    cv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 220, clientY: 160, bubbles: true }));
    const midDrag = { yaw: _r3dCam.yaw, pitch: _r3dCam.pitch, quality: _r3dQuality };
    cv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
    await sleep(320);
    const afterSettle = { quality: _r3dQuality };
    cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }));
    await sleep(30);
    const afterZoom = { dist: _r3dCam.dist };

    const filter = document.getElementById('r3d-filter');
    const height = document.getElementById('r3d-height');
    filter.value = '40'; filter.dispatchEvent(new Event('input', { bubbles: true }));
    height.value = '20'; height.dispatchEvent(new Event('input', { bubbles: true }));
    const sliders = { filterPct: _r3dFilterPct, heightKft: _r3dHeightMaxKft };

    _r3dClose();
    const after = { panel: document.getElementById('r3d-panel').classList.contains('open') };
    return { openState, before, midDrag, afterSettle, afterZoom, sliders, after };
  });
  ok('opening shows the panel', r.openState.panel, JSON.stringify(r.openState));
  ok('dragging the canvas changes yaw and pitch at drag quality',
     r.midDrag.yaw !== r.before.yaw && r.midDrag.pitch !== r.before.pitch
     && r.midDrag.quality === 'fast',
     JSON.stringify({ before: r.before, mid: r.midDrag }));
  ok('and it sharpens back to full quality once the hand stops',
     r.afterSettle.quality === 'fine', r.afterSettle.quality);
  ok('scrolling changes the camera distance', r.afterZoom.dist !== r.before.dist,
     JSON.stringify({ before: r.before.dist, after: r.afterZoom.dist }));
  ok('dragging Show above updates the filter percent', r.sliders.filterPct === 40,
     JSON.stringify(r.sliders));
  ok('dragging Up to updates the height cap', r.sliders.heightKft === 20,
     JSON.stringify(r.sliders));
  ok('closing puts the panel away', !r.after.panel, JSON.stringify(r.after));
}

console.log('\n11a. the two camera bars: a second way to reach the same camera');
{
  const r = await p.evaluate(() => {
    _r3dOpen('kfws');
    const zoomBar = document.getElementById('r3d-zoom');
    const yawBar = document.getElementById('r3d-yaw');
    const out = {};

    // Pushed all the way up, the zoom bar reads its max and the camera
    // sits as close as the distance range allows.
    zoomBar.value = '1000'; zoomBar.dispatchEvent(new Event('input', { bubbles: true }));
    out.zoomedIn = _r3dCam.dist;
    out.atMin = Math.abs(_r3dCam.dist - _r3dDistMin()) < 0.05;
    // All the way down, it reads its farthest.
    zoomBar.value = '0'; zoomBar.dispatchEvent(new Event('input', { bubbles: true }));
    out.zoomedOut = _r3dCam.dist;
    out.atMax = Math.abs(_r3dCam.dist - _r3dDistMax()) < 0.5;

    // The move bar sets yaw directly, in degrees.
    yawBar.value = '90'; yawBar.dispatchEvent(new Event('input', { bubbles: true }));
    out.yawAt90 = Math.abs(_r3dCam.yaw - Math.PI / 2) < 0.01;
    yawBar.value = '-45'; yawBar.dispatchEvent(new Event('input', { bubbles: true }));
    out.yawAtMinus45 = Math.abs(_r3dCam.yaw + Math.PI / 4) < 0.01;

    // Dragging the canvas itself still works, and it pushes its new yaw
    // and distance back out to both bars, so they never fall out of sync
    // with the picture they are supposed to control.
    const cv = document.getElementById('r3d-canvas');
    cv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 5, clientX: 100, clientY: 100, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 5, clientX: 260, clientY: 100, bubbles: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 5, bubbles: true }));
    const yawDeg = _r3dCam.yaw * 180 / Math.PI;
    out.barFollowsDrag = Math.abs(Number(yawBar.value) - yawDeg) < 1.5
      || Math.abs(Number(yawBar.value) - (yawDeg - 360)) < 1.5
      || Math.abs(Number(yawBar.value) - (yawDeg + 360)) < 1.5;

    _r3dClose();
    return out;
  });
  ok('pushed to the top, the zoom bar zooms all the way in',
     r.atMin, JSON.stringify(r));
  ok('pushed to the bottom, it zooms all the way back out',
     r.atMax && r.zoomedOut > r.zoomedIn, JSON.stringify(r));
  ok('the move bar sets yaw to +90 degrees exactly', r.yawAt90, JSON.stringify(r));
  ok('and to -45 degrees the other way', r.yawAtMinus45, JSON.stringify(r));
  ok('dragging the canvas keeps the move bar in sync with the camera it just moved',
     r.barFollowsDrag, JSON.stringify(r));
}

console.log('\n11b. taller: the 80 kft ceiling, vertical exaggeration, and Comfortaa inside the box');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    _r3dFrames = []; _r3dFrameIdx = -1;
    await _r3dRenderIdle(10000);
    const texts = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y) {
      texts.push({ t: String(t), font: this.font, y });
      return orig.call(this, t, x, y);
    };
    const savedExag = _r3dExag, savedH = _r3dHeightMaxKft, savedCam = { ..._r3dCam };
    _r3dHeightMaxKft = 80; _r3dCam.yaw = 0.6; _r3dCam.pitch = 0.3; _r3dCam.dist = 150;
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(10000); };
    _r3dExag = 1; await R();
    const at1 = texts.filter(o => /kft$/.test(o.t)).map(o => ({ t: o.t, y: o.y }));
    texts.length = 0;
    _r3dExag = 3; await R();
    const at3 = texts.filter(o => /kft$/.test(o.t)).map(o => ({ t: o.t, y: o.y }));
    const fonts = texts.map(o => o.font);
    CanvasRenderingContext2D.prototype.fillText = orig;
    const sel = document.getElementById('r3d-exag');
    sel.value = '4'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    const exagAfter = _r3dExag;
    const panelFont = getComputedStyle(document.getElementById('r3d-status')).fontFamily;
    _r3dExag = savedExag; _r3dHeightMaxKft = savedH; Object.assign(_r3dCam, savedCam);
    sel.value = '3';
    _r3dClose();
    return { at1, at3, fonts, exagAfter, panelFont,
             sliderMax: document.getElementById('r3d-height').max };
  });
  const top1 = r.at1.find(o => o.t === '80 kft'), top3 = r.at3.find(o => o.t === '80 kft');
  ok('the height slider reaches 80 kft', r.sliderMax === '80', r.sliderMax);
  ok('labels climb all the way to 80 kft, in true height', !!top1 && !!top3);
  ok('at 3x the 80 kft mark sits much higher on screen than at true scale',
     top1 && top3 && (top1.y - top3.y) > 25, JSON.stringify({ y1: top1 && top1.y, y3: top3 && top3.y }));
  ok('the Height x picker changes the exaggeration', r.exagAfter === 4, String(r.exagAfter));
  ok('every label drawn inside the box is Comfortaa',
     r.fonts.length > 0 && r.fonts.every(f => /Comfortaa/.test(f)), r.fonts[0]);
  ok('and the panel text itself is Comfortaa', /Comfortaa/.test(r.panelFont), r.panelFont);
}

console.log('\n11c. the box is only as tall as the storm in it, and the camera frames the whole box');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    const savedH = _r3dHeightMaxKft;
    _r3dHeightMaxKft = 80;
    const empty = { top: _r3dBoxTopKm() };
    // A shallow 4 km storm: the box should come down to 20 kft, not stay 80.
    const g = [], rs = [];
    for (let x = -2; x <= 2; x += 0.5) for (let y = -2; y <= 2; y += 0.5) for (let z = 0.4; z <= 4; z += 0.3) { g.push(x, y, z, 45); rs.push(0.5, 0.3); }
    _r3dFrames = [{ gates: new Float32Array(g), radii: new Float32Array(rs), count: g.length / 4,
                    segs: [{ start: 0, end: g.length / 4, angle: 0.5 }], time: null, cuts: 1, zMax: 4, _grids: {} }];
    _r3dFrameIdx = 0;
    const withStorm = { top: _r3dBoxTopKm() };
    _r3dCamFit();
    const dist = _r3dCam.dist;
    const texts = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y) { texts.push(String(t)); return orig.call(this, t, x, y); };
    _r3dQuality = 'fine'; _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(10000);
    CanvasRenderingContext2D.prototype.fillText = orig;
    const kft = texts.filter(t => /kft$/.test(t)).map(t => parseInt(t, 10));
    _r3dHeightMaxKft = 10;
    const capped = { top: _r3dBoxTopKm() };
    _r3dHeightMaxKft = savedH;
    _r3dClose();
    return { empty, withStorm, dist, topLabel: Math.max(...kft), capped, exag: _r3dExag };
  });
  ok('with nothing loaded the box stands at the slider cap (80 kft)',
     Math.abs(r.empty.top - 80 / 3.28084) < 1e-6, String(r.empty.top));
  ok('with a 4 km storm the box comes down to 20 kft', Math.abs(r.withStorm.top - 20 / 3.28084) < 1e-6, String(r.withStorm.top));
  ok('and the labels stop there too', r.topLabel === 20, String(r.topLabel));
  ok('the slider can still cap it lower', Math.abs(r.capped.top - 10 / 3.28084) < 1e-6, String(r.capped.top));
  ok('the camera sits far enough back to frame both the width and the drawn height',
     r.dist >= 90 * 1.7 - 1e-6 && r.dist >= r.withStorm.top * r.exag * 1.5 - 1e-6, String(r.dist));
}

console.log('\n11d. the height unit can be changed, and the numbers stay true');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    _r3dFrames = []; _r3dFrameIdx = -1;
    await _r3dRenderIdle(10000);
    const texts = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y) {
      texts.push({ t: String(t), y });
      return orig.call(this, t, x, y);
    };
    const savedH = _r3dHeightMaxKft;
    _r3dHeightMaxKft = 80;
    const sel = document.getElementById('r3d-hunit');
    const grab = async (unit) => {
      sel.value = unit; sel.dispatchEvent(new Event('change', { bubbles: true }));
      texts.length = 0;
      _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(10000);
      return { labels: texts.map(o => o.t).filter(t => /^\d+ /.test(t)),
               slider: document.getElementById('r3d-height-label').textContent,
               y: Object.fromEntries(texts.filter(o => /^\d+ /.test(o.t)).map(o => [o.t, o.y])) };
    };
    const kft = await grab('kft'), km = await grab('km'), m = await grab('m'), ft = await grab('ft');
    CanvasRenderingContext2D.prototype.fillText = orig;
    sel.value = 'kft'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    _r3dHeightMaxKft = savedH;
    _r3dClose();
    return { kft, km, m, ft };
  });
  ok('kft labels run 10 to 80 and the slider reads 80 kft',
     r.kft.labels.includes('80 kft') && r.kft.slider === '80 kft', JSON.stringify(r.kft.labels));
  ok('km labels climb to 24 km (thinned so none overlap) and the slider reads 24.4 km',
     r.km.labels.includes('24 km') && r.km.labels.length >= 6 && r.km.slider === '24.4 km',
     JSON.stringify({ labels: r.km.labels, slider: r.km.slider }));
  ok('metres and feet work too', r.m.labels.includes('24000 m') && r.ft.labels.includes('80000 ft'),
     JSON.stringify({ m: r.m.labels.slice(-1), ft: r.ft.labels.slice(-1) }));
  ok('the same true height lands at the same place on screen whatever the unit',
     Math.abs(r.km.y['24 km'] - r.m.y['24000 m']) < 0.5,
     JSON.stringify({ km24: r.km.y['24 km'], m24000: r.m.y['24000 m'] }));
}

console.log('\n11c. a black gradient panel with gold gradient text, inside the box too');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    _r3dFrames = []; _r3dFrameIdx = -1;
    await _r3dRenderIdle(10000);
    const panel = getComputedStyle(document.getElementById('r3d-panel'));
    const top = getComputedStyle(document.querySelector('#r3d-panel .p3d-top'));
    const title = getComputedStyle(document.querySelector('#r3d-panel .xs-title'));
    const status = getComputedStyle(document.getElementById('r3d-status'));
    const fills = [];
    const orig = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y) {
      fills.push({ t: String(t), gradient: typeof this.fillStyle === 'object' && this.fillStyle !== null });
      return orig.call(this, t, x, y);
    };
    _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(10000);
    CanvasRenderingContext2D.prototype.fillText = orig;
    _r3dClose();
    return {
      panelBg: panel.backgroundImage,
      panelBlur: panel.backdropFilter || panel.webkitBackdropFilter, topBg: top.backgroundImage,
      titleBg: title.backgroundImage, titleClip: title.webkitBackgroundClip || title.backgroundClip,
      titleFill: title.webkitTextFillColor,
      statusBg: status.backgroundImage,
      labels: fills.length, allGradient: fills.every(f => f.gradient),
    };
  });
  // The top (title, controls, sliders) is the black gradient; the panel
  // itself, what shows around and below the picture, is heavy frost.
  ok('the top of the panel is a black gradient',
     /linear-gradient/.test(r.topBg) && /rgb\(28, 28, 34\)/.test(r.topBg) && /rgb\(0, 0, 0\)/.test(r.topBg), r.topBg);
  ok('and the rest is heavy frost: thin dark glass with a 24px blur',
     /rgba\(24, 28, 34, 0\.58\)/.test(r.panelBg) && /blur\(24px\)/.test(r.panelBlur || ''), r.panelBg + ' ' + r.panelBlur);
  ok('the title is gold gradient text (a gradient clipped to the glyphs)',
     /linear-gradient/.test(r.titleBg) && /232, 184, 0/.test(r.titleBg) && r.titleClip === 'text'
     && /transparent|rgba\(0, 0, 0, 0\)/.test(r.titleFill),
     JSON.stringify({ bg: r.titleBg, clip: r.titleClip, fill: r.titleFill }));
  ok('so is the status line', /linear-gradient/.test(r.statusBg) && /232, 184, 0/.test(r.statusBg), r.statusBg);
  ok('and every label drawn inside the 3D box is painted with a gold gradient too',
     r.labels > 0 && r.allGradient, JSON.stringify({ labels: r.labels, allGradient: r.allGradient }));
}

console.log('\n13. playback: the panel\'s own playbar drives it (never the map\'s bar), over a frame cache that copies rather than marches');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');
    _r3dToken++;
    const out = {};
    // Two hand-built frames, then count real paints against renders.
    const mk = (v, zTop) => {
      const g = [], rs = [];
      for (let x = -3; x <= 3; x += 0.5) for (let y = -3; y <= 3; y += 0.5) for (let z = 0.4; z <= zTop; z += 0.3) { g.push(x, y, z, v); rs.push(0.5, 0.3); }
      return { gates: new Float32Array(g), radii: new Float32Array(rs), count: g.length / 4,
               segs: [{ start: 0, end: g.length / 4, angle: 0.5 }], time: Date.UTC(2026, 8, 22, 12), cuts: 1, zMax: zTop, _grids: {} };
    };
    _r3dFrames = [mk(35, 3), mk(50, 6)];
    _r3dFrameIdx = 0;
    _r3dQuality = 'fine';
    _r3dUpdateSlider();
    // The map's bar stays the map's; the panel's own playbar has the volume.
    out.srcId = _animSource().id;
    const pb = document.querySelector('#r3d-panel .p3d-playbar');
    out.pbAfterTop = !!pb && pb.previousElementSibling && pb.previousElementSibling.classList.contains('p3d-top');
    out.playEnabled = !!pb && !pb.querySelector('.p3d-play').disabled;
    out.tlMax = pb ? pb.querySelector('.p3d-scrub').max : '';
    let paints = 0;
    const orig = _r3dPaint;
    _r3dPaint = function () { paints++; return orig.apply(this, arguments); };
    const R = async () => { _r3dDirty = false; _r3dRender(); await _r3dRenderIdle(15000); };
    await R();
    out.firstPaints = paints;
    await R();
    out.secondPaints = paints;
    out.topSteady = _r3dBoxTopKm();
    _r3dSetFrame(1);
    out.topSame = _r3dBoxTopKm() === out.topSteady;
    // Warming draws the frame not yet cached, once, and then has nothing to do.
    out.warm1 = await _r3dWarmOne();
    out.warm2 = await _r3dWarmOne();
    out.paintsAfterWarm = paints;
    await R();
    out.paintsAfterBlit = paints;
    // A drag changes the view, so the cache misses and a real march runs.
    _r3dCam.yaw += 0.3;
    await R();
    out.paintsAfterMove = paints;
    _r3dPaint = orig;
    // The map's step button and scrubber leave the volume alone now.
    _r3dSetFrame(0);
    try { document.getElementById('step-fwd-btn').click(); } catch (e) {}
    try { seekFrame(1); } catch (e) {}
    out.mapBarMoved = _r3dFrameIdx;
    // The panel's scrubber seeks it.
    const scrub = pb.querySelector('.p3d-scrub');
    scrub.value = '1'; scrub.dispatchEvent(new Event('input'));
    await new Promise(res => setTimeout(res, 50));
    out.stepped = _r3dFrameIdx;
    // And its play button runs the loop (warming the moved view first).
    const play = pb.querySelector('.p3d-play');
    play.click();
    out.playing = pb._playing();
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) { seen.add(_r3dFrameIdx); await new Promise(res => setTimeout(res, 50)); }
    out.seenBoth = seen.has(0) && seen.has(1);
    play.click();
    out.stopped = !pb._playing();
    out.label = pb.querySelector('.p3d-time').textContent;
    scrub.value = '0'; scrub.dispatchEvent(new Event('input'));
    await new Promise(res => setTimeout(res, 50));
    out.sought = _r3dFrameIdx;
    _r3dClose();
    out.srcAfterClose = _animSource().id;
    return out;
  });
  ok('with the panel open, the map\'s animation bar is still the map\'s', r.srcId !== 'r3d', JSON.stringify(r));
  ok('the panel\'s own playbar sits under its controls, play enabled, spanning both frames',
     r.pbAfterTop && r.playEnabled === true && r.tlMax === '1', JSON.stringify([r.pbAfterTop, r.playEnabled, r.tlMax]));
  ok('the map\'s step button and scrubber do not move the volume', r.mapBarMoved === 0, String(r.mapBarMoved));
  ok('the first render marches', r.firstPaints === 1, String(r.firstPaints));
  ok('the same view again is a copy from the cache, not a march', r.secondPaints === 1, String(r.secondPaints));
  ok('the box top is the tallest frame, so it stands still through playback',
     Math.abs(r.topSteady - 20 / 3.28084) < 1e-6 && r.topSame, JSON.stringify([r.topSteady, r.topSame]));
  ok('warming paints the other frame once and then reports nothing left', r.warm1 === true && r.warm2 === false && r.paintsAfterWarm === 2,
     JSON.stringify([r.warm1, r.warm2, r.paintsAfterWarm]));
  ok('so stepping to it is a copy too', r.paintsAfterBlit === 2, String(r.paintsAfterBlit));
  ok('moving the camera misses the cache and marches again', r.paintsAfterMove === 3, String(r.paintsAfterMove));
  ok('the playbar\'s scrubber moves the volume', r.stepped === 1, String(r.stepped));
  ok('its play button starts the loop, it genuinely cycles the frames, and stops',
     r.playing === true && r.seenBoth === true && r.stopped === true,
     JSON.stringify([r.playing, r.seenBoth, r.stopped]));
  ok('it names the frame it is on', /\d\/2$/.test(r.label), r.label);
  ok('scrubbing back seeks the volume', r.sought === 0, String(r.sought));
}

console.log('\n14. the Time Machine: a travelled radar loads its 3D volume from the tape archive');
{
  const r = await p.evaluate(async () => {
    const out = {};
    const calls = [];
    const origArc = _l2ArcVolumes, origL3 = _r3dBuildFrameL3, origLive = _fetchVolumeDirect;
    _l2ArcVolumes = async (site, at, n, cap, back) => { calls.push({ kind: 'arc', site, at, n, cap, back }); return []; };
    _r3dBuildFrameL3 = async (site, product, sitePos, zone, token, at) => { calls.push({ kind: 'l3', at }); return null; };
    _fetchVolumeDirect = async () => { calls.push({ kind: 'live' }); throw new Error('no'); };
    _tmAt = Date.UTC(2024, 4, 6, 21, 10);
    _r3dOpenBounds(36.0, -96.05, 36.2, -95.75);
    for (let i = 0; i < 100; i++) { await new Promise(res => setTimeout(res, 50)); if (!_r3dBuilding && i > 2) break; }
    out.calls = calls;
    out.where = document.getElementById('r3d-where').textContent;
    out.hasSync = typeof _r3dTmSync === 'function';
    _tmAt = null;
    _l2ArcVolumes = origArc; _r3dBuildFrameL3 = origL3; _fetchVolumeDirect = origLive;
    _r3dClose();
    return out;
  });
  const arc = r.calls.find(c => c.kind === 'arc');
  const l3 = r.calls.find(c => c.kind === 'l3');
  ok('the whole volume is asked of the archive at the travelled moment, not the live feed',
     !!arc && arc.at === Date.UTC(2024, 4, 6, 21, 10) && arc.cap === 48 * 1024 * 1024 && !r.calls.some(c => c.kind === 'live'),
     JSON.stringify(r.calls));
  ok('when the archive has nothing there yet, the Level 3 tilts are asked for that same moment',
     !!l3 && l3.at === Date.UTC(2024, 4, 6, 21, 10), JSON.stringify(l3));
  ok('the panel says which moment it is showing', /2024-05-06 21:10Z/.test(r.where), r.where);
  ok('and the Time Machine can tell the panel to follow a jump', r.hasSync);
  ok('the jump and the return to live both call it',
     PAGE.split('_r3dTmSync()').length >= 3, String(PAGE.split('_r3dTmSync()').length - 1));
}

console.log('\n12. nothing above threw');
{
  const real = errs.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
