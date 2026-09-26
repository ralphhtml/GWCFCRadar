#!/usr/bin/env node
/*
 * A comparison split shaped like a polygon.
 *
 *     node tools/test-compare-polygon.mjs
 *
 * The Compare tool cut the map with straight lines only. A polygon can now
 * be the split instead: pane B inside it, pane A outside. It can be drawn
 * from the Compare menu (the Polygon button), taken from the Polygon tool
 * (its Compare button), or taken from the newest shape in the Draw tool.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));
ok('the Compare menu has a Polygon button', /id="cmp-poly" onclick="_cmpToolPoly\(\)"/.test(PAGE));
ok('the Polygon tool has a Compare button', /id="ptb-compare" onclick="_cmpFromPolygon\(\)"/.test(PAGE));
ok('the Draw tool has a Compare button', /id="dtb-compare" onclick="_cmpFromDrawing\(\)"/.test(PAGE));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

console.log('\n1. Drawing one from the Compare menu');
const r = await p.evaluate(async () => {
  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  map.setView([35, -97], 6, { animate: false });
  toggleCompareTool();
  _cmpToolCross();
  _xcSetCell(0, 'radar'); _xcSetCell(1, 'satellite');
  const out = {};
  _cmpToolPoly();
  out.drawing = _cmpPolyDrawing && document.getElementById('cmp-poly').classList.contains('active');
  const box = map.getContainer().getBoundingClientRect();
  const tap = (x, y) => {
    const o = { clientX: box.left + x, clientY: box.top + y, bubbles: true, cancelable: true };
    map.getContainer().dispatchEvent(new PointerEvent('pointerdown', o));
    map.getContainer().dispatchEvent(new MouseEvent('click', o));
  };
  tap(400, 250); tap(800, 250); tap(800, 550); tap(400, 550);
  tap(402, 252);                        // the first corner again closes it
  await wait(100);
  out.set = _cmpPolyActive() && _cmpPolyLL.length === 4 && !_cmpPolyDrawing;
  out.outline = !!_cmpPolyOutline && map.hasLayer(_cmpPolyOutline);
  out.linesHidden = document.body.classList.contains('cmp-poly-on');
  const radar = map.getPane('radarPane').style.clipPath;
  const sat = map.getPane('satPhotoPane').style.clipPath;
  out.radarClip = radar.slice(0, 40); out.satClip = sat.slice(0, 40);
  out.radarOutside = /^path\(evenodd/.test(radar);
  out.satInside = /^path\("?'?M/.test(sat) && !/evenodd/.test(sat);
  // Which pane is where, the way the Inspector asks.
  out.inCentre = _xcLayerAt(box.left + 600, box.top + 400);
  out.outCorner = _xcLayerAt(box.left + 100, box.top + 100);
  // It stays on the same place when the map moves.
  const before = map.latLngToContainerPoint(_cmpPolyLL[0]);
  map.panBy([150, 80], { animate: false });
  await wait(100);
  out.followsPan = _xcLayerAt(box.left + before.x + 150 + 20, box.top + before.y + 80 + 20) === 'satellite';
  // The button takes it away again.
  _cmpToolPoly();
  out.cleared = !_cmpPolyActive() && !document.body.classList.contains('cmp-poly-on')
    && !/evenodd/.test(map.getPane('radarPane').style.clipPath);
  // Esc cancels a half-drawn one.
  _cmpToolPoly(); tap(300, 300); tap(500, 300);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  out.escCancels = !_cmpPolyDrawing && !_cmpPolyActive();
  return out;
});
ok('the Polygon button starts drawing', r.drawing, JSON.stringify(r));
ok('tapping corners and the first corner again makes the polygon', r.set && r.outline, JSON.stringify(r));
ok('the straight split line is hidden while a polygon splits the map', r.linesHidden, JSON.stringify(r));
ok('pane A (radar) shows everywhere outside the shape', r.radarOutside, JSON.stringify(r));
ok('pane B (satellite) shows inside the shape', r.satInside, JSON.stringify(r));
ok('the Inspector knows which pane is under a point', r.inCentre === 'satellite' && r.outCorner === 'radar', JSON.stringify(r));
ok('the shape stays over the same place when the map pans', r.followsPan, JSON.stringify(r));
ok('pressing Polygon again goes back to a straight split', r.cleared, JSON.stringify(r));
ok('Esc cancels a half-drawn polygon', r.escCancels, JSON.stringify(r));

console.log('\n2. From the Polygon tool and the Draw tool');
const q = await p.evaluate(async () => {
  const out = {};
  _cmpToolEnd();
  // The Polygon tool's own shape.
  _polyPts = [L.latLng(34, -99), L.latLng(37, -99), L.latLng(37, -95), L.latLng(34, -95)];
  out.fromPoly = _cmpFromPolygon() && _xcOn && _cmpPolyLL.length === 4
    && _xcGrid.rows * _xcGrid.cols === 2;
  // A quad split becomes a double.
  _cmpPolyClear(); _xcSetGrid(2, 2); _xcRefreshDOM();
  _cmpFromPolygon();
  out.quadToDouble = _xcGrid.rows * _xcGrid.cols === 2;
  _cmpToolEnd();
  out.endClears = !_cmpPolyActive() && !_xcOn;
  // A circle from the Draw tool.
  const circ = L.circle([35, -97], { radius: 150000 }).addTo(map);
  _allToolLayers.push(circ);
  out.fromCircle = _cmpFromDrawing() && _cmpPolyLL.length === 96;
  const c = map.latLngToContainerPoint([35, -97]);
  const box = map.getContainer().getBoundingClientRect();
  out.circleInside = _xcLayerAt(box.left + c.x, box.top + c.y) === _xcCells[1];
  _cmpToolEnd();
  _allToolLayers.pop(); map.removeLayer(circ);
  // Too few corners is refused with a note, and nothing starts.
  _polyPts = [L.latLng(34, -99), L.latLng(37, -99)];
  out.tooFew = _cmpFromPolygon() === false && !_xcOn;
  return out;
});
ok('the Polygon tool\'s Compare button starts a comparison split by its polygon', q.fromPoly, JSON.stringify(q));
ok('a quad or octo split becomes a double for the polygon', q.quadToDouble, JSON.stringify(q));
ok('ending the comparison removes the polygon', q.endClears, JSON.stringify(q));
ok('the Draw tool\'s Compare button uses the newest shape, circles included', q.fromCircle && q.circleInside, JSON.stringify(q));
ok('fewer than three corners is refused', q.tooFew, JSON.stringify(q));
console.log('\n3. The split lands exactly on the drawn line');
const m = await p.evaluate(async () => {
  const out = {};
  _cmpToolEnd();
  const box = map.getContainer().getBoundingClientRect();
  // A finished Polygon tool shape: finishing empties the tool's corner list,
  // so the finished polygon itself on the map is what gets used.
  const poly = L.polygon([[34, -99], [37.5, -98], [36, -94], [33.5, -95.5]]).addTo(map);
  _allToolLayers.push(poly);
  _polyPts = [];
  out.finished = _cmpFromPolygon() && _cmpPolyLL.length === 4
    && _cmpPolyLL.every((q, i) => q.equals(poly.getLatLngs()[0][i]));
  out.noSecondOutline = !_cmpPolyOutline;
  _cmpToolEnd(); _allToolLayers.pop(); map.removeLayer(poly);
  // The finish popup offers Compare.
  _showPolyFilterPopup(L.latLng(35, -97));
  out.popupButton = !!document.getElementById('_pfp-compare');
  document.getElementById('_poly-filter-popup').remove();
  // A Draw tool rectangle, drawn the way a mouse draws it.
  toggleDrawTool(); _dtbSetShape('rect');
  _onDrawDown({ latlng: L.latLng(36.5, -99) }); _onDrawMove({ latlng: L.latLng(34, -95) }); _onDrawUp();
  const rect = _allToolLayers[_allToolLayers.length - 1];
  out.rect = _cmpFromDrawing() && _cmpPolyLL.length === rect.getLatLngs().length
    && _cmpPolyLL.every((q, i) => q.equals(rect.getLatLngs()[i]));
  _cmpToolEnd();
  // A straight line is not a zone: the newest real shape is used instead.
  _dtbSetShape('line');
  _onDrawDown({ latlng: L.latLng(35, -100) }); _onDrawMove({ latlng: L.latLng(36, -93) }); _onDrawUp();
  out.skipsLine = _cmpFromDrawing() && _cmpPolyLL.every((q, i) => q.equals(rect.getLatLngs()[i]));
  _cmpToolEnd();
  deactivateTool();
  // A circle: every traced corner sits on the circle Leaflet drew.
  const circ = L.circle([35, -97], { radius: 200000 }).addTo(map);
  _allToolLayers.push(circ);
  _cmpFromDrawing();
  let worst = 0;
  _cmpPolyLL.forEach(q => {
    const lp = map.project(q).subtract(map.getPixelOrigin()), c = circ._point;
    const e = ((lp.x - c.x) / circ._radius) ** 2 + ((lp.y - c.y) / (circ._radiusY || circ._radius)) ** 2;
    worst = Math.max(worst, Math.abs(Math.sqrt(e) - 1) * circ._radius);
  });
  out.circleErrPx = worst;
  _cmpToolEnd(); _allToolLayers.pop(); map.removeLayer(circ);
  return out;
});
ok('a finished Polygon tool shape is used corner for corner', m.finished, JSON.stringify(m));
ok('no second outline is drawn over a shape that already has its own', m.noSecondOutline, JSON.stringify(m));
ok('the polygon finish popup has a Compare button', m.popupButton, JSON.stringify(m));
ok('a Draw tool rectangle is used point for point', m.rect, JSON.stringify(m));
ok('a straight line is skipped for the newest real shape', m.skipsLine, JSON.stringify(m));
ok(`a circle follows the drawn circle (worst ${m.circleErrPx.toFixed(2)} px off)`, m.circleErrPx < 0.5, JSON.stringify(m));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
