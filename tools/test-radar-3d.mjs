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
  ok('it has a product picker and a zone size picker',
     PAGE.includes('id="r3d-product"') && PAGE.includes('id="r3d-zone"'));
  ok('the zone picker offers small, medium and large boxes',
     /id="r3d-zone"[\s\S]{0,300}value="50"[\s\S]{0,200}value="90"[\s\S]{0,200}value="150"/.test(PAGE));
  ok('there is no site picker - the zone finds its own nearest radar',
     !PAGE.includes('id="r3d-site"'));
  ok('it keeps the two sliders: Show above and Up to',
     PAGE.includes('id="r3d-filter"') && PAGE.includes('id="r3d-height"'));
  ok('it has a time control: play, a slider, a time label',
     PAGE.includes('id="r3d-play"') && PAGE.includes('id="r3d-slider"')
     && PAGE.includes('id="r3d-time-label"'));
  ok('the double-click/long-press map menu has a row for it',
     /_cmRadar3DHere\(\)/.test(PAGE) && /View in 3D here/.test(PAGE));
  ok('the renderer is a ray marcher, not a dot painter',
     /_r3dMarchDraw/.test(PAGE) && /Trilinear/.test(PAGE));
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

console.log('\n2. the map menu places the zone and finds the nearest radar');
{
  const r = await p.evaluate(() => {
    _cmOpen({ latlng: L.latLng(36.1, -95.9) });
    const row = Array.from(document.querySelectorAll('#map-ctx-menu .cm-item'))
      .find(el => /View in 3D here/i.test(el.textContent));
    if (row) row.click();
    const rectOnMap = !!(_r3dZoneRect && map.hasLayer(_r3dZoneRect));
    let rectKm = 0;
    if (rectOnMap) {
      const rb = _r3dZoneRect.getBounds();
      rectKm = (rb.getNorth() - rb.getSouth()) * 111.32;
    }
    const out = {
      rowExists: !!row,
      on: _r3dOn,
      zone: _r3dZone ? { lat: _r3dZone.lat, lng: _r3dZone.lng } : null,
      station: _r3dStation,
      km: _r3dStationKm,
      rectOnMap, rectKm,
      panelOpen: document.getElementById('r3d-panel').classList.contains('open'),
      menuClosed: !document.getElementById('map-ctx-menu').classList.contains('open'),
    };
    _r3dClose();
    out.rectGoneAfterClose = !_r3dZoneRect;
    out.zoneClearedAfterClose = !_r3dZone;
    return out;
  });
  ok('the row is really in the menu', r.rowExists);
  ok('clicking it opens the panel', r.on && r.panelOpen);
  ok('the zone is centred exactly where the map was tapped',
     r.zone && Math.abs(r.zone.lat - 36.1) < 1e-6 && Math.abs(r.zone.lng - -95.9) < 1e-6,
     JSON.stringify(r.zone));
  ok('the nearest radar to that spot was chosen, with a real distance',
     !!r.station && r.km > 0 && r.km < 420, r.station + ' ' + r.km);
  ok('a rectangle appears on the map, sized to the medium box',
     r.rectOnMap && Math.abs(r.rectKm - 90) < 2, String(r.rectKm));
  ok('and the map menu itself closes on the way', r.menuClosed);
  ok('closing takes the rectangle and the zone away with it',
     r.rectGoneAfterClose && r.zoneClearedAfterClose);
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

console.log('\n5. gates become voxels: gridding, vertical continuity, the floor');
{
  const r = await p.evaluate(() => {
    const savedSize = _r3dZoneSizeKm;
    _r3dZoneSizeKm = 90;
    // One column of air sampled by two tilts: 2 km and 5 km up, both 55
    // dBZ, exactly what a radar's cone stack really hands us.
    const gates = new Float32Array([0, 0, 2, 55, 0, 0, 5, 55]);
    const frame = { gates, count: 2, segs: [
      { start: 0, end: 1, angle: 0.5 }, { start: 1, end: 2, angle: 3.0 },
    ], time: null, cuts: 2, _grids: {} };
    const G = _r3dGridFrame(frame, 90, false);
    const nx = G.nx, ny = G.ny;
    const ic = Math.floor((0 + 45) / G.cellXY);
    const col = [];
    for (let iz = 0; iz < G.nz; iz++) col.push(G.grid[(iz * ny + ic) * nx + ic]);
    const iz2 = Math.floor(2 / G.cellZ), iz5 = Math.floor(5 / G.cellZ);
    const betweenFilled = col.slice(iz2 + 1, iz5).every(v => v > 0);
    const carriedToGround = col.slice(0, iz2).every(v => v > 0);
    const emptyAbove = col.slice(iz5 + 1).every(v => v === 0);
    const floorByte = G.floor[ic * nx + ic];
    const occHit = G.occ[(((iz2 / G.blockB) | 0) * G.cny + ((ic / G.blockB) | 0)) * G.cnx + ((ic / G.blockB) | 0)];
    // A far, empty corner's occupancy block stays clear.
    const occEmpty = G.occ[0];
    _r3dZoneSizeKm = savedSize;
    return { iz2, iz5, betweenFilled, carriedToGround, emptyAbove,
             floorByte, occHit, occEmpty, sizeKm: G.sizeKm };
  });
  ok('both real samples land in the column', r.iz5 > r.iz2, JSON.stringify(r));
  ok('the gap between the two tilts is interpolated, not left as stripes',
     r.betweenFilled, JSON.stringify(r));
  ok('a low sample is carried down to the ground', r.carriedToGround);
  ok('above the top sample stays honestly empty', r.emptyAbove);
  ok('the floor texture holds the lowest tilt', r.floorByte > 0, String(r.floorByte));
  ok('occupancy marks the storm block and leaves empty air clear',
     r.occHit === 1 && r.occEmpty === 0, JSON.stringify({ occHit: r.occHit, occEmpty: r.occEmpty }));
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
    const zone = { lat: 35.5, lng: -97.0 };              // the fake mesh sits around here
    const farZone = { lat: 44.0, lng: -80.0 };           // nowhere near it
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
      { lat: 35.5, lng: -97.0 }, token, (snap, done, total) => progress.push([done, total, snap ? snap.cuts : 0]));
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

console.log('\n7. the ray march draws a solid volume, and the two sliders really cut it');
{
  const r = await p.evaluate(async () => {
    _r3dOpen('kfws');                                    // panel visible, zone at the site
    const savedCam = { ..._r3dCam };
    const savedH = _r3dHeightMaxKft, savedF = _r3dFilterPct;
    // A tall thin 55 dBZ pillar: 3 km wide, from the ground to 16 km.
    const g = [];
    const segs = [{ start: 0, end: 0, angle: 0.5 }];
    for (let x = -1.5; x <= 1.5; x += 0.7) {
      for (let y = -1.5; y <= 1.5; y += 0.7) {
        for (let z = 0.4; z <= 16; z += 0.35) {
          g.push(x, y, z, 55);
        }
      }
    }
    segs[0].end = g.length / 4;
    const frame = { gates: new Float32Array(g), count: g.length / 4,
                    segs, time: null, cuts: 1, _grids: {} };
    _r3dToken++;                                         // park any real load still in flight
    _r3dFrames = [frame];
    _r3dFrameIdx = 0;
    _r3dQuality = 'fine';
    _r3dCam.yaw = 0.6; _r3dCam.pitch = 0.35; _r3dCam.dist = 60;

    const cv = document.getElementById('r3d-canvas');
    const ctx = cv.getContext('2d');
    const redCount = () => {
      const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 150 && data[i + 1] < 60 && data[i + 2] < 60) n++;
      }
      return n;
    };

    _r3dHeightMaxKft = 60; _r3dFilterPct = 0; _r3dLutCache = null;
    _r3dRender();
    const full = redCount();

    _r3dHeightMaxKft = 10;                               // 10 kft is about 3 km
    _r3dRender();
    const capped = redCount();

    _r3dHeightMaxKft = 60; _r3dFilterPct = 90; _r3dLutCache = null;  // cutoff 70 dBZ
    _r3dRender();
    const filtered = redCount();

    _r3dHeightMaxKft = savedH; _r3dFilterPct = savedF; _r3dLutCache = null;
    Object.assign(_r3dCam, savedCam);
    _r3dClose();
    return { full, capped, filtered };
  });
  ok('the pillar paints a real area of solid red, not scattered dots',
     r.full > 400, String(r.full));
  ok('capping the height cuts most of it away', r.capped > 0 && r.capped < r.full * 0.6,
     JSON.stringify(r));
  ok('filtering above its strength removes it, floor included',
     r.filtered < 30, String(r.filtered));
}

console.log('\n8. changing the box size re-grids in place, no refetch');
{
  const r = await p.evaluate(() => {
    const savedSize = _r3dZoneSizeKm;
    const gates = new Float32Array([0, 0, 2, 55]);
    const frame = { gates, count: 1, segs: [{ start: 0, end: 1, angle: 0.5 }],
                    time: null, cuts: 1, _grids: {} };
    _r3dZoneSizeKm = 90;
    const g90 = _r3dGridFor(frame, false);
    _r3dZoneSizeKm = 50;
    const g50 = _r3dGridFor(frame, false);
    const oneCached = Object.keys(frame._grids).length;
    _r3dZoneSizeKm = savedSize;
    return { s90: g90.sizeKm, s50: g50.sizeKm,
             cellShrank: g50.cellXY < g90.cellXY, oneCached };
  });
  ok('the grid follows the selected size', r.s90 === 90 && r.s50 === 50, JSON.stringify(r));
  ok('a smaller box means finer voxels over the same spot', r.cellShrank);
  ok('only the current size stays cached per frame', r.oneCached === 1, String(r.oneCached));
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
    const zone = { lat: 35.4, lng: -97.1 };
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
    _r3dZone = { lat: 32.9, lng: -97.0 };
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
    let capAsked = null, recentArgs = null;
    window._fetchVolumeDirect = async (site, cap) => { capAsked = cap; return new ArrayBuffer(16); };
    window._fetchRecentVolumes = async (site, n, cap, startBack) => { recentArgs = [n, cap, startBack]; return []; };
    const keepCache = window._l2VolCache;
    const statuses = [];
    const realSay = window._r3dSay;
    window._r3dSay = (m, k) => { statuses.push(m); realSay(m, k); };
    _r3dZone = { lat: 35.5, lng: -97.0 };
    _r3dStation = 'ktlx'; _r3dStationKm = 60;
    await _r3dLoad();
    await new Promise(res => setTimeout(res, 30));
    const out = {
      capAsked, recentArgs,
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
  ok('and the cache is marked as the whole thing for next time', r.cacheMarkedFull);
  ok('every tilt was announced as it landed', r.progressSeen === 3, String(r.progressSeen));
  ok('all three cuts are in the frame', r.cuts === 3, String(r.cuts));
  ok('history is asked for whole volumes too, skipping the live one already on screen',
     r.recentArgs && r.recentArgs[0] === 3 && r.recentArgs[1] >= 40 * 1024 * 1024 && r.recentArgs[2] === 1,
     JSON.stringify(r.recentArgs));
  ok('the status ends on the gate count', /gates/.test(r.final), r.final);
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

    const zoneSel = document.getElementById('r3d-zone');
    zoneSel.value = '50'; zoneSel.dispatchEvent(new Event('change', { bubbles: true }));
    const zoneAfter = {
      sizeKm: _r3dZoneSizeKm,
      rectKm: _r3dZoneRect ? (_r3dZoneRect.getBounds().getNorth() - _r3dZoneRect.getBounds().getSouth()) * 111.32 : 0,
    };
    zoneSel.value = '90'; zoneSel.dispatchEvent(new Event('change', { bubbles: true }));
    _r3dZoneSizeKm = 90;

    _r3dClose();
    const after = { panel: document.getElementById('r3d-panel').classList.contains('open') };
    return { openState, before, midDrag, afterSettle, afterZoom, sliders, zoneAfter, after };
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
  ok('the box size select resizes the map rectangle too',
     r.zoneAfter.sizeKm === 50 && Math.abs(r.zoneAfter.rectKm - 50) < 2,
     JSON.stringify(r.zoneAfter));
  ok('closing puts the panel away', !r.after.panel, JSON.stringify(r.after));
}

console.log('\n12. nothing above threw');
{
  const real = errs.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
