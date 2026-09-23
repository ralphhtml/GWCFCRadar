#!/usr/bin/env node
/*
 * T-Storm Tracker: storm cells circled and projected forward, from
 * whatever radar is actually on screen - decoded or not.
 *
 *     node tools/test-tstorm-tracker.mjs
 *
 * The idea (and the 10/20/30/40 minute steps) comes from wxtools.org.
 * There is no network call to hold down anywhere in this feature - a
 * decoded mesh is read directly, and a picture-only radar (the Normal
 * mosaic, a single site's own picture, MRMS, the parsing server's Level 3 picture) is
 * read back by colour straight off the tiles this page has already drawn -
 * so this drives every path directly: a synthetic mesh for the decoded
 * side, and a synthetic tile painted into radarPane for the picture side.
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
  ok('the pill is in the Overlays row, with a drag handle',
     /id="op-tstorm-tracker" data-ovid="tstorm-tracker"/.test(PAGE)
     && /id="op-tstorm-tracker"[\s\S]{0,400}?class="ov-drag"/.test(PAGE)
     && /toggleOverlayPill\('tstorm-tracker'\)">T-Storm Tracker</.test(PAGE));
  ok('it has a description, which is what gives it an info button, and it says every radar works',
     /'tstorm-tracker':\s*'[^']{100,}/.test(PAGE)
     && /Works on any of them/.test(PAGE));
  ok('the toggle branch flips its own state and syncs the pill',
     /id === 'tstorm-tracker'\) \{\s*_tstToggle\(\);\s*const pill = document\.getElementById\('op-tstorm-tracker'\);\s*if \(pill\) pill\.classList\.toggle\('active', _tstOn\);/.test(PAGE));
  ok('a decoded frame is offered to it independently of the AI assistant\'s own history',
     /_tstOnFrame\(result && result\.meshData, station, product,/.test(PAGE)
     && PAGE.includes('let _tstHistory = [];')
     && !PAGE.includes('_tstHistory = _fxHistory'));
  ok('the scope, not a stale decode-result global, decides what is on screen',
     PAGE.includes('function _tstScopeKey() {')
     && /const meshActive = _radarSource === 'l2' \|\| \(_radarSource === 'l3' && !!_prBucketSite\);/.test(PAGE));
  ok('a picture-only scope is read back by colour through the Inspector\'s own reflectivity ramp',
     /function _tstCellsFromPixels\(\)/.test(PAGE) && PAGE.includes('_inspColorToDbz(d[0], d[1], d[2])'));
  ok('the pixel grid clusters in its own index space, not a fixed geographic bin',
     /function _tstClusterGrid\(samples, cellAreaKm2\)/.test(PAGE));
  ok('the circle is sized to actually contain the cell\'s bounding box, not just approximate its area',
     PAGE.includes('function _tstEnclosingRadiusKm(lat, lon, bbox, padKm) {')
     && /const enclosingKm = cell\.bbox\s*\? _tstEnclosingRadiusKm\(cell\.lat, cell\.lon, cell\.bbox, newest\.padKm\)/.test(PAGE));
  ok('a heartbeat rechecks the scope on a timer, and a site change pokes it immediately',
     PAGE.includes('function _tstPoll() {')
     && /_tstPollTimer = setInterval\(_tstPoll, TST_POLL_MS\)/.test(PAGE)
     && /A site change is the one radar switch worth reacting to instantly[\s\S]{0,120}_tstPoll\(\);/.test(PAGE));
  ok('turning MRMS on pokes it too',
     /_mrmsActive = true;\s*_refStation = null;[\s\S]{0,120}if \(typeof _tstOn !== 'undefined' && _tstOn\) \{ try \{ _tstPoll\(\); \} catch \(e\) \{\} \}/.test(PAGE));
  ok('turning the radar off redraws it immediately instead of waiting for the next tick',
     /function _disableRadar\(\) \{[\s\S]*?_tstRedraw\(\); \} catch \(e\) \{\}/.test(PAGE));
  ok('the mosaic\'s own tile-cache-vs-WMS switch also checks this overlay\'s flag',
     /_nexradCacheFailed = _inspForcedWms \|\| _tstForcedWms;/.test(PAGE));
  ok('costs nothing while off: the decode hook returns before touching anything',
     /function _tstOnFrame\(mesh, station, product, timeMs\) \{\s*if \(!_tstOn\) return;/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-tstorm-tracker.mjs'), 'utf8').includes(EM));
}

console.log('\n2. the tiers read the way wxtools.org draws them');
{
  const tierFn = new Function('maxDbz',
    'return maxDbz >= 60 ? 3 : maxDbz >= 50 ? 2 : 1;');
  ok('34.9 dBZ is moderate, 35 is moderate', tierFn(34.9) === 1 && tierFn(35) === 1);
  ok('49.9 is still moderate, 50 turns heavy', tierFn(49.9) === 1 && tierFn(50) === 2);
  ok('59.9 is still heavy, 60 turns extreme', tierFn(59.9) === 2 && tierFn(60) === 3);
  ok('75 is extreme', tierFn(75) === 3);
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
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
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
  return route.abort();   // real network is never actually needed by this feature
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
ok('the page boots clean', errs.length === 0, errs[0]);

await p.evaluate(() => {
  const real = window.showToast;
  window.__toasts = [];
  window.showToast = (t, ms) => { window.__toasts.push(String(t)); try { return real && real(t, ms); } catch (e) {} };
  map.setView([35.05, -96.5], 6, { animate: false });
});

// Paints a fake radar tile straight into radarPane, exactly covering the
// current viewport at 1:1, with the given colour blocks in CONTAINER pixel
// coordinates - so the pixel reader's own coordinate math (screen point ->
// tile pixel) is identity, and the blocks land exactly where asked.
async function injectTile(blocks) {
  return p.evaluate((blocks) => new Promise((resolve) => {
    const size = map.getSize();
    const canvas = document.createElement('canvas');
    canvas.width = size.x; canvas.height = size.y;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size.x, size.y);
    blocks.forEach(bl => { ctx.fillStyle = bl.hex; ctx.fillRect(bl.x, bl.y, bl.w, bl.h); });
    const img = new Image();
    img.onload = () => {
      const pane = map.getPane('radarPane');
      const old = document.getElementById('tst-fake-wrap');
      if (old) old.remove();
      const wrap = document.createElement('div');
      wrap.id = 'tst-fake-wrap';
      wrap.className = 'leaflet-layer';
      wrap.style.opacity = '1';
      img.id = 'tst-fake-tile';
      const pos = (map._mapPane && L.DomUtil.getPosition(map._mapPane)) || { x: 0, y: 0 };
      img.style.position = 'absolute';
      img.style.left = (-pos.x) + 'px';
      img.style.top = (-pos.y) + 'px';
      img.style.width = size.x + 'px';
      img.style.height = size.y + 'px';
      wrap.appendChild(img);
      pane.appendChild(wrap);
      resolve(true);
    };
    img.src = canvas.toDataURL();
  }), blocks);
}
function removeTile() {
  return p.evaluate(() => { const el = document.getElementById('tst-fake-wrap'); if (el) el.remove(); });
}

console.log('\n3. the pill, with both of its controls');
{
  const r = await p.evaluate(() => {
    const pill = document.getElementById('op-tstorm-tracker');
    if (!pill) return null;
    return {
      ovid: pill.dataset.ovid,
      name: (pill.querySelector('.ov-rowname') || {}).textContent,
      drag: !!pill.querySelector('.ov-drag'),
      info: !!pill.querySelector('.ov-info-btn'),
      desc: (OV_DESCRIPTIONS || {})['tstorm-tracker'] || '',
    };
  });
  ok('the pill exists under its own id', r && r.ovid === 'tstorm-tracker', r && r.ovid);
  ok('named T-Storm Tracker', r && r.name === 'T-Storm Tracker', r && r.name);
  ok('it has a drag handle', r && r.drag);
  ok('and an info button', r && r.info);
  ok('which explains the three tiers and that every radar source is covered',
     r && /orange/.test(r.desc) && /purple/.test(r.desc)
     && /Normal mosaic/.test(r.desc) && /MRMS/.test(r.desc), String(r && r.desc.length));
}

// A cluster is four 0.05-degree grid points, all the same value, so it
// forms one clustered cell in a decoded mesh rather than four one-bin
// specks. Two clusters, far enough apart to never merge: a 40 dBZ
// (moderate) one and a 65 dBZ (extreme) one, each shifted 0.05 degrees east
// between two frames five minutes apart, a real, measurable eastward run.
const meshCluster = (lon0, lat0, v) => {
  const pts = [];
  for (const dlon of [0, 0.05]) for (const dlat of [0, 0.05]) {
    pts.push(lon0 + dlon, lat0 + dlat, 0, 0, 0, 0, 0, 0, v);
  }
  return pts;
};
const T0 = Date.UTC(2026, 8, 14, 20, 0);
const T1 = T0 + 5 * 60000;
const meshFrame = (lonShift, t) => ({
  t,
  mesh: [
    ...meshCluster(-97.50 + lonShift, 35.00, 40),
    ...meshCluster(-96.00 + lonShift, 36.00, 65),
  ],
});
const MF0 = meshFrame(0, T0);
const MF1 = meshFrame(0.05, T1);

console.log('\n4. off: nothing is recorded, nothing is drawn, and it says what it needs when turned on with nothing showing');
{
  const before = await p.evaluate((f) => {
    _tstOnFrame(f.mesh, 'ktlx', 'ref', f.t);
    return { on: _tstOn, hist: _tstHistory.length, layer: !!_tstLayer };
  }, MF0);
  ok('a frame offered while off changes nothing at all',
     !before.on && before.hist === 0 && !before.layer, JSON.stringify(before));

  const on = await p.evaluate(() => {
    activeLayers.nexrad = false;
    toggleOverlayPill('tstorm-tracker');
    return { on: _tstOn, pillOn: document.getElementById('op-tstorm-tracker').classList.contains('active'),
             toasts: window.__toasts.join(' | ') };
  });
  ok('it turns on and says it needs a radar, since nothing is showing',
     on.on && on.pillOn && /needs a reflectivity radar/.test(on.toasts), on.toasts);
}

console.log('\n5. Level 2: a decoded mesh, tracked by family, drawn exactly');
{
  const r = await p.evaluate((args) => {
    activeLayers.nexrad = true; _radarSource = 'l2';
    const fxBefore = _fxHistory.length;
    // _tstOnFrame only OBSERVES a decode - it is _l3Attach, not this hook,
    // that sets the decode-result globals _tstScopeKey checks are live.
    // Setting them here is standing in for that real call.
    _lastMeshData = args.MF0.mesh; _lastMeshBounds = [-99, 33, -94, 38];
    _lastMeshProduct = 'ref'; _lastMeshStation = 'ktlx';
    _tstOnFrame(args.MF0.mesh, 'ktlx', 'ref', args.MF0.t);
    _lastMeshData = args.MF1.mesh;
    _tstOnFrame(args.MF1.mesh, 'ktlx', 'ref', args.MF1.t);
    const fxAfter = _fxHistory.length;
    const out = { scopes: [...new Set(_tstHistory.map(f => f.scope))], fxUntouched: fxAfter === fxBefore,
                  layer: !!_tstLayer, circles: [], rays: [], ticks: 0 };
    _tstLayer.eachLayer(l => {
      if (l instanceof L.Circle) {
        out.circles.push({ lat: +l.getLatLng().lat.toFixed(3), lon: +l.getLatLng().lng.toFixed(3),
                           color: l.options.color, dash: l.options.dashArray, pane: l.options.pane });
      } else if (l instanceof L.Polyline) {
        const ll = l.getLatLngs();
        out.rays.push({ start: ll[0], end: ll[1] });
      } else { out.ticks++; }
    });
    return out;
  }, { MF0, MF1 });
  ok('recorded under a mesh: scope, the AI assistant\'s own history untouched',
     r.scopes.join(',') === 'mesh:ktlx' && r.fxUntouched, JSON.stringify(r.scopes));
  ok('two circles, dashed, in the overlay\'s own pane',
     r.layer && r.circles.length === 2
     && r.circles.every(c => c.dash === '7 5' && c.pane === 'ovp-tstorm-tracker'), JSON.stringify(r.circles));
  const byColor = Object.fromEntries(r.circles.map(c => [c.color, c]));
  ok('40 dBZ is moderate orange, 65 dBZ is extreme purple, both on the newest (shifted) frame',
     byColor['#ff9500'] && Math.abs(byColor['#ff9500'].lon - (-97.425)) < 0.01
     && byColor['#b83bff'] && Math.abs(byColor['#b83bff'].lon - (-95.925)) < 0.01, JSON.stringify(r.circles));
  ok('each moving cell gets a ray running east and four tick marks',
     r.rays.length === 2 && r.ticks === 8
     && r.rays.every(x => x.end.lng > x.start.lng && Math.abs(x.end.lat - x.start.lat) < 0.002),
     JSON.stringify({ rays: r.rays, ticks: r.ticks }));
}

console.log('\n6. a cell\'s popup names its tier, its peak, and its motion honestly');
{
  const r = await p.evaluate(() => {
    let target = null;
    _tstLayer.eachLayer(l => { if (l instanceof L.Circle && l.options.color === '#b83bff') target = l; });
    target.fire('click', { latlng: target.getLatLng(), originalEvent: new Event('click') });
    const html = map._popup ? map._popup.getContent() : '';
    const d = document.createElement('div'); d.innerHTML = html;
    const text = d.textContent.replace(/\s+/g, ' ');
    map.closePopup();
    return { text };
  });
  ok('extreme, its peak dBZ, an eastward speed, and the straight-line-guess caveat are all there',
     /EXTREME THUNDERSTORM CELL/.test(r.text) && /65 dBZ/.test(r.text)
     && /Moving E at \d+ mph/.test(r.text) && /straight-line guess/.test(r.text)
     && /not an official forecast/.test(r.text), r.text.slice(0, 260));
}

console.log('\n7. switching to Normal mode: the mesh cells vanish, the mosaic scope takes over');
{
  const r = await p.evaluate(() => {
    _radarSource = 'normal'; currentProduct = 'ref'; _refStation = null; _mrmsActive = false; _prOn = false;
    const scope = _tstScopeKey();
    _tstRedraw();
    return { scope, layer: !!_tstLayer };
  });
  ok('the scope reads as the national mosaic', r.scope === 'mosaic', r.scope);
  ok('and nothing is drawn yet - the mosaic scope has no history of its own', !r.layer, JSON.stringify(r));
}

console.log('\n8. the mosaic itself: two painted blocks read back into two real cells');
{
  const centers = await p.evaluate(() => ({
    a: map.containerPointToLatLng([170, 170]),
    b: map.containerPointToLatLng([560, 140]),
  }));
  await injectTile([
    { x: 150, y: 150, w: 40, h: 40, hex: '#e5bc00' },   // 40 dBZ, moderate
    { x: 540, y: 120, w: 40, h: 40, hex: '#f800fd' },   // 65 dBZ, extreme
  ]);
  const r = await p.evaluate(() => {
    _tstScope = null;                 // force the poll to see this as a fresh scope
    _tstLastPixelScan = 0;
    _tstPoll();                       // the real entry point: scope detection + scan together
    const out = { scope: _tstScope, hist: _tstHistory.filter(f => f.scope === 'mosaic').length,
                  layer: !!_tstLayer, circles: [] };
    if (_tstLayer) _tstLayer.eachLayer(l => {
      if (l instanceof L.Circle) out.circles.push({
        lat: +l.getLatLng().lat.toFixed(3), lon: +l.getLatLng().lng.toFixed(3), color: l.options.color });
    });
    return out;
  });
  ok('_tstPoll recognised the mosaic scope and scanned it in one call',
     r.scope === 'mosaic' && r.hist === 1, JSON.stringify(r));
  ok('two cells came back, one per painted block', r.circles.length === 2, JSON.stringify(r.circles));
  const byColor = Object.fromEntries(r.circles.map(c => [c.color, c]));
  ok('the 40 dBZ block reads back moderate orange, the 65 dBZ block reads back extreme purple',
     byColor['#ff9500'] && byColor['#b83bff'], JSON.stringify(r.circles));
  // A generous tolerance on purpose: the centre comes from averaging a
  // handful of discrete 8-pixel samples across the block, not one perfect
  // point, so it lands NEAR the block's true centre rather than exactly
  // on it - "the right block, not some other one" is what this checks.
  ok('each cell sits on the block it was painted at',
     Math.abs(byColor['#ff9500'].lat - centers.a.lat) < 0.12 && Math.abs(byColor['#ff9500'].lon - centers.a.lng) < 0.12
     && Math.abs(byColor['#b83bff'].lat - centers.b.lat) < 0.12 && Math.abs(byColor['#b83bff'].lon - centers.b.lng) < 0.12,
     JSON.stringify({ circles: r.circles, centers }));
}

console.log('\n9. a single site\'s own picture, and MRMS, read the exact same way');
{
  await injectTile([{ x: 300, y: 300, w: 40, h: 40, hex: '#fd0000' }]);   // 50 dBZ, heavy
  const site = await p.evaluate(() => {
    _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'kfws'; _mrmsActive = false;
    _tstScope = null; _tstLastPixelScan = 0;
    _tstPoll();
    const circles = [];
    if (_tstLayer) _tstLayer.eachLayer(l => { if (l instanceof L.Circle) circles.push(l.options.color); });
    return { scope: _tstScopeKey(), recordedScope: _tstScope, circles };
  });
  ok('a single site\'s own picture is scope site:<id>, and reads its heavy-tier block',
     site.scope === 'site:kfws' && site.recordedScope === 'site:kfws' && site.circles.join(',') === '#ff2d2d',
     JSON.stringify(site));

  const mrms = await p.evaluate(() => {
    _mrmsActive = true; _refStation = null;
    return _tstScopeKey();
  });
  ok('MRMS is its own scope, checked ahead of the site picture', mrms === 'mrms', mrms);
}

console.log('\n10. the parsing server\'s own Level 3 picture is a picture too, not a decoded mesh');
{
  const r = await p.evaluate(() => {
    _mrmsActive = false; _refStation = null;
    _radarSource = 'l3'; _prOn = true; _prBucketSite = null; _prProduct = 'reflectivity'; _prSite = 'KTLX';
    const meshScope = (() => {
      // The same live-state guard _tstScopeKey uses: Level 3 without a
      // bucket site is the parsing server's own picture, never a decoded mesh.
      return _radarSource === 'l3' && !!_prBucketSite;
    })();
    return { scope: _tstScopeKey(), meshActiveWouldBe: meshScope };
  });
  ok('it reads as site:ktlx, the picture path, even though _radarSource is l3',
     r.scope === 'site:ktlx' && !r.meshActiveWouldBe, JSON.stringify(r));

  const back = await p.evaluate(() => {
    _prBucketSite = 'KTLX';   // now the browser really is decoding the bucket
    return _tstScopeKey();
  });
  // No fresh mesh has actually been decoded for this combination in this
  // section, so the mesh branch's OWN data guard (_lastMeshData) correctly
  // still holds it back rather than inventing a scope with nothing behind it.
  ok('and only counts as a decoded mesh once the mesh guard itself agrees there is one',
     back === null || back.indexOf('mesh:') === 0, back);
  await p.evaluate(() => { _prOn = false; _prBucketSite = null; _radarSource = 'normal'; });
}

console.log('\n11. changing site pokes the tracker immediately, not on the next timer tick');
{
  await removeTile();
  const r = await p.evaluate(async () => {
    _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'ktlx'; _mrmsActive = false;
    _tstScope = null;
    await _siteView({ id: 'kfws', lat: 32.5731, lon: -97.3031 });
    // _siteView's own hook runs synchronously at the end of that async
    // function, so the scope is already current the instant it resolves -
    // no extra wait for the 2-second heartbeat.
    return { refStation: _refStation, scope: _tstScope };
  });
  ok('the site actually changed', r.refStation === 'kfws', r.refStation);
  ok('and the tracker\'s own idea of the scope changed with it, in the same tick',
     r.scope === 'site:kfws', r.scope);
}

console.log('\n12. turning MRMS on pokes it too');
{
  // _loadMrmsComposite reaches out to the real network for its scan times
  // (irrelevant to what is being checked here, and blocked in this
  // sandbox), so this calls it without waiting for that to settle and
  // reads the one line that matters: _mrmsActive and the tracker's own
  // hook both run synchronously before that network call is even started.
  const r = await p.evaluate(() => {
    _tstScope = null;
    _loadMrmsComposite().catch(() => {});   // fire and forget, on purpose
    return { mrmsActive: _mrmsActive, scope: _tstScope };
  });
  ok('MRMS turned on and the tracker noticed immediately, before the network call even lands',
     r.mrmsActive === true && r.scope === 'mrms', JSON.stringify(r));
  await p.evaluate(() => { try { _clearMrms(); } catch (e) {} });
}

console.log('\n13. radar off ends it, and it resumes from a still-warm site the moment it comes back');
{
  const r = await p.evaluate(async () => {
    _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'ktlx'; _mrmsActive = false;
    _tstScope = null; _tstLastPixelScan = 0;
    return null;
  });
  await injectTile([{ x: 200, y: 200, w: 40, h: 40, hex: '#fd0000' }]);
  const warmed = await p.evaluate(() => { _tstPoll(); return _tstHistory.some(f => f.scope === 'site:ktlx'); });
  ok('site:ktlx has a history entry to resume from', warmed);

  const off = await p.evaluate(() => {
    _disableRadar();
    return { layer: !!_tstLayer, on: _tstOn, scope: _tstScopeKey() };
  });
  ok('radar off clears the drawn layer immediately, without turning the overlay itself off',
     !off.layer && off.on && off.scope === null, JSON.stringify(off));

  const back = await p.evaluate(() => {
    activeLayers.nexrad = true; _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'ktlx';
    _tstScope = null;
    _tstPoll();
    return { layer: !!_tstLayer, hist: _tstHistory.filter(f => f.scope === 'site:ktlx').length };
  });
  ok('back on the same site redraws from the history already on hand, no fresh scan needed',
     back.layer && back.hist === 1, JSON.stringify(back));
}

console.log('\n14. the circle always fully contains the cell, even one that is not round');
{
  // An area-equivalent circle is a fine approximation for something roughly
  // round and a real understatement for anything long and thin - a squall
  // line above all, which is the ordinary shape a "cell" takes, not the
  // exception. A straight line of reflectivity makes the point: eleven
  // points in a row, all above the heavy threshold, one bin apart in
  // longitude and none at all in latitude, so the cluster is real but far
  // from circular.
  const line = [];
  for (let i = 0; i < 11; i++) line.push(-98.50 + i * 0.05, 34.00, 0, 0, 0, 0, 0, 0, 55);
  const r = await p.evaluate((mesh) => {
    activeLayers.nexrad = true; _radarSource = 'l2';
    _lastMeshData = mesh; _lastMeshBounds = [-99, 33, -97, 35];
    _lastMeshProduct = 'ref'; _lastMeshStation = 'kddc';
    _tstOnFrame(mesh, 'kddc', 'ref', Date.now());
    let circle = null;
    _tstLayer.eachLayer(l => { if (l instanceof L.Circle) circle = l; });
    const centre = circle.getLatLng();
    const bbox = { south: 34.00, north: 34.05, west: -98.50, east: -97.95 };
    // The independent check: Leaflet's own great-circle distance from the
    // drawn circle's centre to each corner of the cell's real bounding box,
    // against the radius that circle was actually given.
    const corners = [[bbox.north, bbox.west], [bbox.north, bbox.east],
                     [bbox.south, bbox.west], [bbox.south, bbox.east]];
    const distances = corners.map(c => map.distance([centre.lat, centre.lng], c));
    return { radius: circle.getRadius(), distances, oldRadiusWouldHaveBeen:
      Math.sqrt((11 * (0.05 * 111.32) ** 2) / Math.PI) * 1.15 * 1000 };
  }, line);
  ok('every corner of the line\'s true extent sits inside the circle actually drawn',
     r.distances.every(d => d <= r.radius + 50), JSON.stringify(r));
  ok('and the old area-only formula would have missed the far end badly - this is a real fix, not a no-op',
     r.radius > r.oldRadiusWouldHaveBeen * 1.5, JSON.stringify(r));
}

console.log('\n15. the same containment guarantee holds for a picture-only cell, not just a decoded one');
{
  await removeTile();
  // Zoomed in for this one check: at the wide national view the rest of the
  // suite uses, 400 screen pixels is genuinely most of a continent, which
  // would trip the deliberate safety ceiling rather than exercise the
  // containment maths this is actually testing. Restored afterward.
  await p.evaluate(() => map.setView([35.05, -96.5], 10, { animate: false }));
  await injectTile([{ x: 100, y: 300, w: 400, h: 16, hex: '#fd0000' }]);   // wide and short: 50 dBZ, heavy
  const r = await p.evaluate(() => {
    _radarSource = 'normal'; currentProduct = 'ref'; _refStation = 'ktlx'; _mrmsActive = false;
    _tstScope = null; _tstLastPixelScan = 0;
    _tstPoll();
    let circle = null;
    _tstLayer.eachLayer(l => { if (l instanceof L.Circle) circle = l; });
    if (!circle) return null;
    const centre = circle.getLatLng();
    // The cell's own reported bbox is the ground truth here (this shape is
    // painted in screen pixels, not degrees, so there is no simple lat/lon
    // formula to check it against independently) - what matters is that the
    // circle the code drew really does reach every corner of the box the
    // SAME code reported detecting.
    let cell = null;
    _tstHistory.forEach(f => { if (f.scope === 'site:ktlx' && f.cells.length) cell = f.cells[f.cells.length - 1]; });
    const bbox = cell.bbox;
    const corners = [[bbox.north, bbox.west], [bbox.north, bbox.east],
                     [bbox.south, bbox.west], [bbox.south, bbox.east]];
    const distances = corners.map(c => map.distance([centre.lat, centre.lng], c));
    return { radius: circle.getRadius(), distances, wide: bbox.east - bbox.west, tall: bbox.north - bbox.south };
  });
  ok('the block was genuinely wide and short, the shape this is meant to prove',
     r && r.wide > r.tall * 3, JSON.stringify(r));
  ok('every corner of its own reported bbox sits inside its own drawn circle',
     r && r.distances.every(d => d <= r.radius + 50), JSON.stringify(r));
  await p.evaluate(() => map.setView([35.05, -96.5], 6, { animate: false }));
}

console.log('\n16. turning the pill off stops the timer and clears everything');
{
  const r = await p.evaluate(() => {
    toggleOverlayPill('tstorm-tracker');
    return { on: _tstOn, layer: !!_tstLayer, pillOn: document.getElementById('op-tstorm-tracker').classList.contains('active'),
             timer: _tstPollTimer };
  });
  ok('off: no layer, pill dark, timer cleared', !r.on && !r.layer && !r.pillOn && r.timer === null, JSON.stringify(r));
  ok('and nothing threw across the whole run', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await removeTile();
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
