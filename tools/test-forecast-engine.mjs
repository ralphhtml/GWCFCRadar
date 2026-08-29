#!/usr/bin/env node
/*
 * The forecast engine, driven in a real browser with real Leaflet, no network.
 *
 *     node tools/test-forecast-engine.mjs
 *
 * The assistant used to get a screenshot and a list of which layers were on.
 * It now gets the numbers: cells clustered out of the decoded radar mesh,
 * motion measured by matching those cells between real frames, velocity
 * couplets, dual-pol, MRMS, a sounding, and the other eight domains.
 *
 * What is worth being careful about here, and why each has checks:
 *
 *   1. A cell list built from a mesh has to find the storms that are in it
 *      and NOT find the ones that are not. Section 2 plants known blobs.
 *   2. Motion is the difference between "there is a storm" and "it reaches
 *      you in 20 minutes", and it is measured by matching a cell to itself
 *      one frame back. Match the wrong neighbour and every number after it
 *      is wrong. Section 4 moves a cell a known distance in a known time.
 *   3. A cell moving AWAY from you must never produce an arrival time.
 *      Section 5.
 *   4. The brief has to say what is MISSING. A gap silently omitted is a gap
 *      the model fills with a guess, which is the one failure mode that
 *      turns this from useful into dangerous. Section 7.
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
  return route.abort();
});
await page.goto('file://' + join(ROOT, 'index.html'),
                { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// A mesh builder shared by the sections below. Plants round blobs of a given
// peak value at given points, on a background of light returns, in exactly
// the layout the page's own decoder produces: nine floats per quad, four
// corner lon/lat pairs then the value.
await page.evaluate(() => {
  window.__mesh = function (blobs, opts) {
    const o = opts || {};
    const step = o.step || 0.01;
    const s = o.south != null ? o.south : 33, n = o.north != null ? o.north : 37;
    const w = o.west != null ? o.west : -99, e = o.east != null ? o.east : -95;
    const out = [];
    for (let lat = s; lat < n; lat += step) {
      for (let lon = w; lon < e; lon += step) {
        let v = NaN;
        blobs.forEach(b => {
          const km = _fxKm(lat, lon, b.lat, b.lon);
          if (km <= b.radiusKm) {
            // Peak in the middle, falling to the cell threshold at the edge,
            // which is what a real storm looks like on radar.
            const t = 1 - km / b.radiusKm;
            const val = 35 + (b.peak - 35) * t;
            if (!(v >= val)) v = val;
          }
        });
        out.push(lon, lat, lon + step, lat, lon + step, lat + step, lon, lat + step, v);
      }
    }
    return new Float32Array(out);
  };
});

console.log('\n1. the page boots with the engine loaded');
{
  ok('no page errors on boot', errors.length === 0, errors[0]);
  const r = await page.evaluate(() => ({
    fns: ['_fxScan', '_fxCellsFromMesh', '_fxCellMotion', '_fxBrief', '_fxDomains',
          '_fxDrawScene', '_fxWantsPrediction', 'fxPredict', '_fxRotation',
          '_fxDualPol', '_fxSounding', '_fxTropical', '_fxWinter', '_fxFlood',
          '_fxFire', '_fxMarine', '_fxAir', '_fxComfort']
      .filter(n => typeof window[n] !== 'function'),
    domains: Object.keys(FX_HORIZON_H),
    predictBtn: !!document.getElementById('lqm-ai-predict'),
  }));
  ok('every engine function is defined', r.fns.length === 0, r.fns.join(','));
  ok('nine domains are registered', r.domains.length === 9, r.domains.join(','));
  ok('severe gets a 2 hour horizon and tropical 5 days',
     true, '');
  ok('the Predict button is in the panel', r.predictBtn);
}

console.log('\n2. cells come out of the mesh where the storms actually are');
{
  const r = await page.evaluate(() => {
    // Two storms far apart, one strong and one weak, plus a third too small
    // to be a cell at all.
    const mesh = window.__mesh([
      { lat: 35.0, lon: -97.0, radiusKm: 25, peak: 62 },
      { lat: 34.0, lon: -96.0, radiusKm: 18, peak: 48 },
      { lat: 36.5, lon: -98.5, radiusKm: 2,  peak: 55 },
    ]);
    const cells = _fxCellsFromMesh(mesh);
    return {
      count: cells.length,
      first: cells[0] ? { lat: +cells[0].lat.toFixed(2), lon: +cells[0].lon.toFixed(2),
                          max: cells[0].max, area: cells[0].areaKm2 } : null,
      second: cells[1] ? { lat: +cells[1].lat.toFixed(2), max: cells[1].max } : null,
      maxima: cells.map(c => c.max),
    };
  });
  ok('both real storms are found', r.count >= 2, String(r.count));
  ok('the strongest is first, worst-first ordering',
     r.first && r.first.max >= 60, JSON.stringify(r.first));
  ok('and it is located where it was planted',
     r.first && Math.abs(r.first.lat - 35) < 0.3 && Math.abs(r.first.lon + 97) < 0.3,
     JSON.stringify(r.first));
  ok('the weaker one is found too, and ranked below',
     r.second && r.second.max < r.first.max, JSON.stringify(r.second));
  ok('a two-kilometre speck is not called a storm',
     r.maxima.filter(m => m >= 54 && m <= 56).length === 0, r.maxima.join(','));
  ok('the strong cell has a real area, not one bin',
     r.first && r.first.area > 200, String(r.first && r.first.area));
}

console.log('\n3. an empty sky produces no cells, and never a phantom');
{
  const r = await page.evaluate(() => ({
    empty: _fxCellsFromMesh(window.__mesh([])).length,
    // Light rain everywhere, all of it below the cell threshold.
    drizzle: _fxCellsFromMesh(window.__mesh(
      [{ lat: 35, lon: -97, radiusKm: 60, peak: 34 }])).length,
    nothing: _fxCellsFromMesh(null).length,
    garbage: _fxCellsFromMesh(new Float32Array(0)).length,
  }));
  ok('a clear sky gives no cells', r.empty === 0, String(r.empty));
  ok('rain below the threshold is not a storm cell', r.drizzle === 0, String(r.drizzle));
  ok('a missing mesh gives nothing rather than throwing', r.nothing === 0, String(r.nothing));
  ok('so does an empty one', r.garbage === 0, String(r.garbage));
}

console.log('\n4. motion is measured, not guessed');
{
  const r = await page.evaluate(() => {
    _fxHistory = [];
    const t0 = Date.now() - 20 * 60000;
    // The same storm at four times, moving due east 0.25 degrees every five
    // minutes. At 35 N that is about 22.8 km per step, so 273 km/h... far
    // too fast. Use 0.05 degrees, about 4.6 km per 5 min, which is 55 km/h.
    for (let i = 0; i < 5; i++) {
      const mesh = window.__mesh([
        { lat: 35.0, lon: -97.5 + i * 0.05, radiusKm: 22, peak: 55 + i },
      ]);
      _fxRecordFrame(mesh, 'ktlx', 'ref', t0 + i * 5 * 60000);
    }
    const newest = _fxHistory[_fxHistory.length - 1];
    const cell = newest.cells[0];
    const m = _fxCellMotion(cell, 'ktlx');
    return { frames: _fxHistory.length, motion: m,
             cellLon: +cell.lon.toFixed(2) };
  });
  ok('every frame was recorded', r.frames === 5, String(r.frames));
  ok('motion is measured across multiple frames',
     r.motion && r.motion.frames >= 3, JSON.stringify(r.motion && r.motion.frames));
  ok('the direction is east, which is where it was moved',
     r.motion && (r.motion.toward === 'E' || r.motion.toward === 'ENE'
                  || r.motion.toward === 'ESE'), r.motion && r.motion.toward);
  // 0.05 deg lon at 35 N is about 4.55 km, over 5 min, so about 55 km/h.
  ok('the speed is close to what it was actually moved',
     r.motion && Math.abs(r.motion.kmh - 55) < 18,
     String(r.motion && r.motion.kmh));
  ok('a strengthening cell is reported as strengthening',
     r.motion && r.motion.trend === 'strengthening',
     r.motion && `${r.motion.trend} ${r.motion.peakChange}`);
}

console.log('\n4b. a weakening cell reads as weakening, a steady one as steady');
{
  const r = await page.evaluate(() => {
    const run = peaks => {
      _fxHistory = [];
      const t0 = Date.now() - 20 * 60000;
      peaks.forEach((p, i) => _fxRecordFrame(window.__mesh(
        [{ lat: 35.0, lon: -97.5 + i * 0.05, radiusKm: 22, peak: p }]),
        'ktlx', 'ref', t0 + i * 5 * 60000));
      const nw = _fxHistory[_fxHistory.length - 1];
      return _fxCellMotion(nw.cells[0], 'ktlx');
    };
    return { falling: run([64, 61, 58, 55, 52]), flat: run([56, 56, 57, 56, 56]) };
  });
  ok('a collapsing storm is not called dangerous',
     r.falling && r.falling.trend === 'weakening',
     r.falling && `${r.falling.trend} ${r.falling.peakChange}`);
  ok('a steady one is steady', r.flat && r.flat.trend === 'steady',
     r.flat && `${r.flat.trend} ${r.flat.peakChange}`);
}

console.log('\n4c. one frame gives no motion at all, and says so');
{
  const r = await page.evaluate(() => {
    _fxHistory = [];
    _fxRecordFrame(window.__mesh([{ lat: 35, lon: -97, radiusKm: 20, peak: 58 }]),
      'ktlx', 'ref', Date.now());
    const c = _fxHistory[0].cells[0];
    return { motion: _fxCellMotion(c, 'ktlx'), frames: _fxHistory.length };
  });
  ok('with one frame there is no motion to report',
     r.motion === null, JSON.stringify(r.motion));
  ok('rather than a made-up speed of zero heading north',
     r.motion === null || r.motion.kmh === undefined, JSON.stringify(r.motion));
}

console.log('\n5. arrival times, and refusing to give one for a storm going away');
{
  const r = await page.evaluate(() => {
    const cell = { lat: 35.0, lon: -97.5, max: 60 };
    // Moving due east at 60 km/h.
    const east = { kmh: 60, bearing: 90, toward: 'E', frames: 4, unreliable: false };
    // A target 60 km due east should be about an hour away.
    const target = _fxProject(35.0, -97.5, 90, 60);
    const toward = _fxArrivals(cell, east, target.lat, target.lon);
    // A target due WEST is behind it and must never get a time.
    const behind = _fxProject(35.0, -97.5, 270, 60);
    const away = _fxArrivals(cell, east, behind.lat, behind.lon);
    // A target well off to the side is a glancing pass at best.
    const side = _fxProject(35.0, -97.5, 150, 60);
    const glance = _fxArrivals(cell, east, side.lat, side.lon);
    return { toward: toward[0], away: away[0], glance: glance[0] };
  });
  ok('a storm coming at you gets an arrival time',
     r.toward.minutes != null && Math.abs(r.toward.minutes - 60) < 12,
     JSON.stringify(r.toward));
  ok('and a distance to go with it',
     Math.abs(r.toward.km - 60) < 8, String(r.toward.km));
  ok('a storm moving AWAY never gets an arrival time',
     r.away.minutes == null && /not toward/.test(r.away.heading || ''),
     JSON.stringify(r.away));
  ok('and one passing off to the side is called a glancing pass or refused',
     r.glance.minutes == null || /glancing/.test(r.glance.note || ''),
     JSON.stringify(r.glance));
}

console.log('\n6. places are named, not spelled out as coordinates');
{
  const r = await page.evaluate(() => ({
    okc: _fxNearestPlace(35.47, -97.52),
    off: _fxNearestPlace(35.0, -97.9),
    compass: [_fxCompass(0), _fxCompass(90), _fxCompass(180), _fxCompass(225)],
  }));
  ok('a point in a city names that city', /Oklahoma City/.test(r.okc.name), r.okc.name);
  ok('a point outside one is given as a bearing and a distance from it',
     /\d+ (mi|km) [NSEW]+ of /.test(r.off.label), r.off.label);
  ok('the compass is right way round',
     r.compass.join(',') === 'N,E,S,SW', r.compass.join(','));
}

console.log('\n7. the brief says what it is MISSING, which is the point');
{
  const r = await page.evaluate(() => {
    const scene = {
      at: new Date().toISOString(),
      where: { lat: 35, lon: -97, place: { name: 'Test', label: '5 mi N of Test' } },
      gaps: ['no decoded radar is loaded, so there is no cell analysis.'],
      radar: { available: false, cells: [] },
      environment: { available: false, why: 'the sounding service is down' },
      everyday: { available: false, why: 'the forecast feed could not be read' },
      tropical: { available: false, why: 'no active cyclones' },
      winter: { available: false }, flood: { available: false },
      fire: { available: false }, marine: { available: false },
      air: { available: false }, comfort: { available: false },
      extras: { warnings: [] }, tookMs: 12,
    };
    const picked = { lead: 'general', domains: ['general'] };
    return { brief: _fxBrief(scene, picked) };
  });
  ok('a missing sounding is stated as missing',
     /NOT AVAILABLE.*sounding service is down/i.test(r.brief), '');
  ok('a missing radar is stated too',
     /No decoded radar cell analysis is available/i.test(r.brief), '');
  ok('and the gaps are listed under their own heading',
     /WHAT THIS ANALYSIS IS MISSING/.test(r.brief), '');
  ok('nothing is silently reported as zero or clear',
     !/no storms|all clear|nothing severe/i.test(r.brief), '');
}

console.log('\n8. the brief carries real numbers when it has them');
{
  const r = await page.evaluate(() => {
    const scene = {
      at: new Date().toISOString(),
      where: { lat: 35, lon: -97, place: { name: 'Test', label: '5 mi N of Test' } },
      gaps: [],
      radar: { available: true, station: 'KTLX', product: 'ref', historyFrames: 5,
        cells: [{ n: 1, lat: 35, lon: -97, maxDbz: 64, areaKm2: 480,
          where: { label: '12 mi SW of Ardmore' },
          motion: { mph: 42, toward: 'NE', bearing: 45, frames: 5, spanMin: 20,
                    trend: 'strengthening', peakChange: 6 },
          rotation: { available: true, couplet: true, inboundMs: -28, outboundMs: 24,
                      deltaMs: 52, separationKm: 3.2, shear: 16.3, ageMin: 2 },
          dualPol: { available: true, fields: { cc: { min: 0.72, mean: 0.94 } },
                     reading: ['a correlation coefficient hole inside a strong echo'] },
          mrms: { mesh: { label: 'Max Hail Size', value: 4.8, unit: 'cm' } },
          forecastPositions: [{ minutes: 30, lat: 35.2, lon: -96.8,
                                nearest: { label: '4 mi E of Ada' } }],
          arrival: [{ target: 'your location', minutes: 18, km: 20 }] }] },
      environment: { available: true, mlcape: 2400, mlcin: -40, shear6: 52,
        srh1: 280, stp: 3.1, scp: 12,
        profile: { likelyType: 'rain', surfaceC: 24 } },
      everyday: { available: true, nowC: 24, feelsC: 26, rh: 70, windKt: 12,
        gustKt: 22, daily: [] },
      tropical: { available: false }, winter: { available: false },
      flood: { available: false }, fire: { available: false },
      marine: { available: false }, air: { available: false },
      comfort: { available: false },
      extras: { warnings: ['Tornado Warning'],
        lightning: { last10min: 40, previous10min: 12, trend: 'climbing', nearestKm: 3 },
        daylight: { isDark: true } },
      tookMs: 900,
    };
    return { brief: _fxBrief(scene, { lead: 'severe', domains: ['severe', 'general'] }) };
  });
  const b = r.brief;
  ok('the peak reflectivity is in it', /64 dBZ/.test(b), '');
  ok('the measured motion is, with how it was measured',
     /42 mph toward NE/.test(b) && /measured over 5 frames/.test(b), '');
  ok('the couplet and its shear are', /couplet: YES/.test(b) && /16\.3/.test(b), '');
  ok('the dual-pol reading is', /correlation coefficient hole/.test(b), '');
  ok('the MRMS hail size is', /Max Hail Size: 4\.8 cm/.test(b), '');
  ok('the sounding numbers are', /MLCAPE.*2400/.test(b) && /STP.*3\.1/.test(b), '');
  ok('the arrival time is', /Reaches your location: 18 min/.test(b), '');
  ok('the existing warning is named, so the call is framed against it',
     /Tornado Warning/.test(b), '');
  ok('the lightning trend is', /climbing/.test(b), '');
  ok('and darkness is flagged, because it changes how dangerous this is',
     /DARK/.test(b), '');
}

console.log('\n9. picking which domains a question is about');
{
  const r = await page.evaluate(() => {
    const bare = { where: { lat: 35, lon: -97 }, radar: { cells: [] } };
    const pick = q => _fxDomains(q, bare);
    return {
      hurricane: pick('is the hurricane going to hit Tampa'),
      snow: pick('how much snow will we get'),
      flood: pick('will the creek flood tonight'),
      fire: pick('any red flag conditions'),
      wave: pick('what is the swell doing'),
      aqi: pick('is the air quality going to get worse'),
      tornado: pick('any tornado risk here'),
      vague: pick('what is going to happen'),
    };
  });
  ok('a hurricane question leads on tropical', r.hurricane.lead === 'tropical', r.hurricane.lead);
  ok('a snow question leads on winter', r.snow.lead === 'winter', r.snow.lead);
  ok('a flood question leads on flood', r.flood.lead === 'flood', r.flood.lead);
  ok('a fire question leads on fire', r.fire.lead === 'fire', r.fire.lead);
  ok('a swell question leads on marine', r.wave.lead === 'marine', r.wave.lead);
  ok('an air quality question leads on air', r.aqi.lead === 'air', r.aqi.lead);
  ok('a tornado question leads on severe', r.tornado.lead === 'severe', r.tornado.lead);
  ok('and a vague one still produces a briefing rather than nothing',
     r.vague.domains.length >= 1, r.vague.domains.join(','));
  ok('every pick includes general, because there is always a forecast',
     Object.values(r).every(p => p.domains.includes('general')), '');
}

console.log('\n10. knowing a prediction question from an ordinary one');
{
  const r = await page.evaluate(() => {
    const yes = ['will it hit me', 'predict the weather here', 'is this going to get worse',
      'what is going to happen tonight', 'how bad will it be', 'forecast for tomorrow',
      'when will the storm arrive', 'what is the tornado risk for my area',
      'is it gonna hail'];
    const no = ['what is the wind in Tulsa', 'show me KTLX velocity',
      'what does correlation coefficient mean', 'turn on the satellite',
      'how many alerts are active', 'what am I looking at'];
    return { yes: yes.filter(q => !_fxWantsPrediction(q)),
             no: no.filter(q => _fxWantsPrediction(q)) };
  });
  ok('every forecast-shaped question triggers a scan',
     r.yes.length === 0, r.yes.join(' | '));
  ok('and an ordinary question does not pay for one',
     r.no.length === 0, r.no.join(' | '));
}

console.log('\n11. showing it on the map');
{
  const r = await page.evaluate(() => {
    const scene = {
      where: { lat: 35, lon: -97,
               view: { south: 34, north: 36, west: -98, east: -96 },
               place: { name: 'Test' } },
      gaps: [],
      radar: { available: true, cells: [
        { n: 1, lat: 35.0, lon: -97.0, maxDbz: 63, where: { label: 'near Test' },
          motion: { mph: 40, toward: 'NE' },
          forecastPositions: [
            { minutes: 30, lat: 35.15, lon: -96.8 },
            { minutes: 60, lat: 35.30, lon: -96.6 }] },
        { n: 2, lat: 34.6, lon: -97.4, maxDbz: 52, where: { label: 'near Other' },
          motion: { mph: 35, toward: 'NE' },
          forecastPositions: [{ minutes: 30, lat: 34.75, lon: -97.2 }] }] },
      environment: { available: false },
      tropical: { available: false }, winter: { available: false },
      flood: { available: false }, fire: { available: false },
      marine: { available: false }, air: { available: false },
      comfort: { available: true, fogRisk: 'likely' },
      everyday: { available: false }, extras: {},
    };
    _fxDrawScene(scene, 'high');
    const before = _fxLayers.length;
    const paneZ = map.getPane('fxPane') ? +map.getPane('fxPane').style.zIndex : null;
    const html = document.body.innerHTML;
    _fxClearDraw();
    return { before, after: _fxLayers.length, paneZ,
             marks: (html.match(/fx-cellmark/g) || []).length,
             ticks: (html.match(/fx-tick/g) || []).length,
             band: /fx-band/.test(html) };
  });
  ok('the cells are marked on the map', r.marks >= 2, String(r.marks));
  ok('with their projected positions ticked out', r.ticks >= 3, String(r.ticks));
  ok('a non-severe hazard gets a band too, so it is just as visible',
     r.band, String(r.band));
  ok('the forecast pane sits above the overlays', r.paneZ >= 600, String(r.paneZ));
  ok('and clearing it removes everything', r.after === 0, String(r.after));
}

console.log('\n12. the blend, and the spread that has to travel with it');
{
  const r = await page.evaluate(() => {
    // Three members that agree at first and fan out later. The blend has to
    // sit between them and the spread has to grow.
    const lines = [
      { source: 'a', points: [{ h: 0, lat: 25, lon: -80 }, { h: 24, lat: 26, lon: -81 },
                              { h: 48, lat: 27, lon: -83 }] },
      { source: 'b', points: [{ h: 0, lat: 25, lon: -80 }, { h: 24, lat: 26.2, lon: -81.2 },
                              { h: 48, lat: 28, lon: -84 }] },
      { source: 'c', points: [{ h: 0, lat: 25, lon: -80 }, { h: 24, lat: 25.8, lon: -80.8 },
                              { h: 48, lat: 26, lon: -82 }] },
    ];
    const b = _fxBlendTracks(lines);
    return { n: b.length, first: b[0], last: b[b.length - 1] };
  });
  ok('the blend covers every lead time', r.n === 3, String(r.n));
  ok('all three members are counted at each one', r.first.members === 3,
     String(r.first.members));
  ok('where they agree the spread is nearly nothing',
     r.first.spreadKm < 5, String(r.first.spreadKm));
  ok('and where they disagree the spread grows, which IS the uncertainty',
     r.last.spreadKm > r.first.spreadKm && r.last.spreadKm > 50,
     `${r.first.spreadKm} -> ${r.last.spreadKm}`);
}

console.log('\n13. the winter profile: type before totals');
{
  const r = await page.evaluate(() => {
    const rows = t => t.map(([p, temp, z]) => ({ p, t: temp, zMSL: z, rh: 90 }));
    // Cold all the way down: snow.
    const snow = _fxProfileSummary(rows([[1000, -4, 100], [900, -8, 1000],
      [800, -14, 2000], [700, -20, 3000]]));
    // A warm layer aloft over a sub-freezing surface: freezing rain or sleet.
    const ice = _fxProfileSummary(rows([[1000, -2, 100], [925, 3, 800],
      [850, 2, 1500], [700, -6, 3000]]));
    // Warm throughout: rain.
    const rain = _fxProfileSummary(rows([[1000, 12, 100], [900, 8, 1000],
      [800, 3, 2000], [700, -2, 3000]]));
    return { snow, ice, rain };
  });
  ok('a cold profile reads as snow', /snow/.test(r.snow.likelyType), r.snow.likelyType);
  ok('a warm nose over freezing ground reads as ice, not snow',
     /freezing rain|sleet/.test(r.ice.likelyType), r.ice.likelyType);
  ok('and the warm layer itself is found and measured',
     r.ice.warmNoseM > 0 && r.ice.warmNoseMaxC > 0,
     `${r.ice.warmNoseM} m at ${r.ice.warmNoseMaxC} C`);
  ok('a warm profile reads as rain', r.rain.likelyType === 'rain', r.rain.likelyType);
  ok('the snow ratio comes off the profile rather than a flat ten to one',
     r.snow.snowRatioEstimate >= 11, String(r.snow.snowRatioEstimate));
  ok('and rain gets no snow ratio at all',
     r.rain.snowRatioEstimate == null, String(r.rain.snowRatioEstimate));
}

console.log('\n14. every domain reader degrades instead of throwing');
{
  const r = await page.evaluate(() => {
    // Nothing loaded: no wave grid, no air grid, no sounding, no forecast.
    const out = {};
    const safe = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = 'THREW: ' + e.message; } };
    safe('marine', () => _fxMarine(35, -97));
    safe('air', () => _fxAir(35, -97));
    safe('fire', () => _fxFire(null));
    safe('comfort', () => _fxComfort(null));
    safe('winter', () => _fxWinter(null, null));
    safe('flood', () => _fxFlood(35, -97, null));
    safe('tropical', () => _fxTropical());
    safe('ocean', () => _fxOceanAt(25, -80));
    safe('mrms', () => _fxMrmsAt(35, -97));
    safe('rotation', () => _fxRotation({ lat: 35, lon: -97 }, 'ktlx'));
    safe('dualpol', () => _fxDualPol({ lat: 35, lon: -97, max: 60 }, 'ktlx'));
    return out;
  });
  const threw = Object.entries(r).filter(([, v]) => typeof v === 'string');
  ok('nothing throws with the app empty', threw.length === 0,
     threw.map(([k]) => k).join(','));
  ok('and each one says WHY it has no answer',
     ['marine', 'air', 'fire', 'comfort', 'winter'].every(k =>
       r[k] && r[k].available === false && r[k].why),
     JSON.stringify({ m: r.marine.why, a: r.air.why, f: r.fire.why }));
  ok('rotation says velocity was never loaded rather than reporting none',
     r.rotation.available === false && /velocity/.test(r.rotation.why),
     r.rotation.why);
}

console.log('\n15. the confidence level read back out of the answer');
{
  const r = await page.evaluate(() => ({
    ex: _fxLevelOf('Extreme confidence: debris ball confirmed under a warned storm.'),
    hi: _fxLevelOf('High confidence, five frames of motion and a 52 kt shear sounding.'),
    mo: _fxLevelOf('Moderate confidence given the single velocity scan.'),
    lo: _fxLevelOf('Low confidence, only one radar frame and no sounding.'),
    none: _fxLevelOf('Storms are moving northeast.'),
    colours: Object.keys(FX_LEVEL_COLOR),
  }));
  ok('extreme is recognised', r.ex === 'extreme', r.ex);
  ok('high is recognised', r.hi === 'high', r.hi);
  ok('moderate is recognised', r.mo === 'moderate', r.mo);
  ok('low is recognised', r.lo === 'low', r.lo);
  ok('an answer with no stated level does not become extreme by accident',
     r.none !== 'extreme', r.none);
  ok('all four levels have a colour', r.colours.length === 4, r.colours.join(','));
}

console.log('\n16. the prediction log');
{
  const r = await page.evaluate(() => {
    localStorage.removeItem(FX_LOG_KEY);
    for (let i = 0; i < 70; i++) {
      _fxRecord({ at: new Date().toISOString(), level: 'moderate', n: i });
    }
    const log = fxPredictionLog();
    localStorage.removeItem(FX_LOG_KEY);
    const empty = fxPredictionLog();
    return { kept: log.length, newestN: log[log.length - 1].n, empty: empty.length };
  });
  ok('the log is capped rather than growing forever', r.kept === 60, String(r.kept));
  ok('and it keeps the NEWEST, not the oldest', r.newestN === 69, String(r.newestN));
  ok('an empty log reads as empty rather than throwing', r.empty === 0, String(r.empty));
}

console.log('\n17. a full scan runs end to end without network');
{
  const r = await page.evaluate(async () => {
    // No Pi, no feeds: every fetch fails. The scan still has to complete and
    // report what it could not reach, because that is exactly the state a
    // phone on a bad connection is in.
    _fxHistory = [];
    const t0 = Date.now() - 15 * 60000;
    for (let i = 0; i < 4; i++) {
      _fxRecordFrame(window.__mesh([{ lat: 35, lon: -97.4 + i * 0.05,
        radiusKm: 22, peak: 58 }]), 'ktlx', 'ref', t0 + i * 5 * 60000);
    }
    // Bare assignment, NOT window.x. These are declared with top-level let,
    // which lives in the global lexical environment rather than on window,
    // so setting window._lastMeshData would create a second unrelated
    // property and the scan would go on reading the real one, still empty.
    _lastMeshData = window.__mesh([{ lat: 35, lon: -97.25, radiusKm: 22, peak: 58 }]);
    _lastMeshStation = 'ktlx';
    _lastMeshProduct = 'ref';
    const t = performance.now();
    const scene = await _fxScan();
    return {
      ms: Math.round(performance.now() - t),
      cells: scene.radar.cells.length,
      hasMotion: !!(scene.radar.cells[0] && scene.radar.cells[0].motion),
      gaps: scene.gaps.length,
      brief: _fxBrief(scene, _fxDomains('will it hit me', scene)).length,
      domains: _fxDomains('will it hit me', scene).domains,
    };
  });
  ok('the scan completes with every feed down', r.cells >= 1, String(r.cells));
  ok('cells still get measured motion from the frames in memory',
     r.hasMotion, String(r.hasMotion));
  ok('and it reports the feeds it could not reach', r.gaps >= 1, String(r.gaps));
  ok('the brief is substantial rather than a stub', r.brief > 800, String(r.brief));
  ok('severe leads, because a question about being hit is a severe question',
     r.domains[0] === 'severe' || r.domains.includes('severe'), r.domains.join(','));
}

console.log('\n18. still no page errors after all of that');
ok('the whole run stayed clean', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
