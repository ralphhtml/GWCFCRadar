#!/usr/bin/env node
/*
 * A forecast cone issued anywhere shows up everywhere, and stays.
 *
 *     node tools/test-cone-publish.mjs
 *
 * A cone issued from the radar's Storm Cone toolbar never appeared in the
 * Forecasting Portal: the portal read the published cones "for the record"
 * and never drew them, and the next Publish from the portal wrote only the
 * cones on its own tool, deleting the radar's. The radar did the same thing
 * to portal cones. Every published cone now carries a stable id, both sides
 * load, draw and list the cones in force, and a new issue adds to them.
 * The GWCFC Outlooks overlay draws them, and checks for new ones each minute.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const PORTAL = readFileSync(join(ROOT, 'forecasting-portal.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};
ok('no em dashes', ![PAGE, PORTAL, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
async function open(file) {
  const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); localStorage.setItem('gwcfc_sc_mode', 'drag'); }, CL_ID);
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, file), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  return { p, errs };
}

// A cone as the portal publishes it: a real 3N+1 ring round a centre line.
const portalCone = (pid, lat0) => {
  const N = 6, centre = [], left = [], right = [], cap = [];
  for (let i = 0; i <= N; i++) centre.push([lat0 + i, -60 - i]);
  centre.forEach(([la, lo], i) => { const w = 0.3 + i * 0.1; left.push([la, lo - w]); right.push([la, lo + w]); });
  for (let i = 1; i < N; i++) cap.push([lat0 + N + 0.5, -60 - N]);
  return { pid, id: 1, dots: 3, style: null, cats: null, mode: 'drag', dotIdx: null,
           ring: left.concat(cap, right.slice().reverse()), center: centre };
};

console.log('\n1. The radar: issuing keeps the portal\'s cones, and the overlay draws them all');
{
  const { p, errs } = await open('index.html');
  const r = await p.evaluate(async (pc) => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const store = { latest: { issued: '2026-09-26T10:00:00Z', forecaster: 'Portal Person',
                              v: JSON.stringify({ storms: [], areas: [], cones: [pc], alerts: [] }) } };
    const coll = { doc: (id) => ({ set: async (d, o) => { store[id] = o && o.merge ? Object.assign({}, store[id], d) : d; } }),
                   add: async () => {} };
    _fbDb = { collection: () => coll };
    _currentUser = { uid: 'u1', displayName: 'Radar Person', email: '' };
    window._fdLoadProfile = async () => ({ forecaster: true, displayName: 'Radar Person' });
    window._fdIsForecaster = () => true;
    window.confirm = () => true;
    window._gwcfcFetch = async () => {
      const d = Object.assign({}, store.latest);
      try { Object.assign(d, JSON.parse(d.v)); } catch (e) {}
      delete d.v; return d;
    };
    const cones = () => JSON.parse(store.latest.v).cones;
    map.setView([28, -85], 6, { animate: false });
    toggleStormConeTool();
    const click = (lat, lng) => _onScClick({ latlng: L.latLng(lat, lng), originalEvent: null });
    const move = (lat, lng) => _onScMove({ latlng: L.latLng(lat, lng) });
    click(24, -86); move(28, -84); click(30, -83);
    _scNew();
    const out = {};
    await _scIssue();
    out.first = cones().map(c => c.pid);
    out.keptPortal = out.first.includes(pc.pid);
    await _scIssue();
    out.second = cones().map(c => c.pid);
    // The overlay, as anyone would see it.
    _gwcfcOutlookToggle();
    await wait(400);
    out.overlayRings = _gwcfcLayers.filter(l => l instanceof L.Polygon && l.options.weight === 4).length;
    out.overlayLines = _gwcfcLayers.filter(l => l instanceof L.Polyline && !(l instanceof L.Polygon) && l.options.dashArray === '6 5').length;
    // The desk lists the portal cone and can take it off.
    _fdActive = true;
    _fdRenderList();
    out.deskRow = /Published forecast cone/.test(document.body.innerHTML);
    _fdRemovePubCone(pc.pid);
    await _fdPublish();
    out.afterRemove = cones().map(c => c.pid);
    // The overlay notices the change on its own minute check.
    _gwcfcDocCache = { at: 0, doc: null };
    await _gwcfcRefresh();
    out.overlayAfter = _gwcfcLayers.filter(l => l instanceof L.Polygon && l.options.weight === 4).length;
    // Unchanged outlook: no redraw, no toast every minute.
    const before = _gwcfcLayers[0];
    let toasts = 0; const st = window.showToast; window.showToast = () => { toasts++; };
    _gwcfcDocCache = { at: 0, doc: null };
    await _gwcfcRefresh();
    window.showToast = st;
    out.quiet = toasts === 0 && _gwcfcLayers[0] === before;
    return out;
  }, portalCone('portal1', 18));
  ok('issuing from the Storm Cone toolbar keeps the portal\'s cone and adds the new one',
     r.first.length === 2 && r.keptPortal, JSON.stringify(r));
  ok('issuing the same cone again replaces it rather than doubling it',
     r.second.length === 2 && JSON.stringify(r.second) === JSON.stringify(r.first), JSON.stringify(r));
  ok('the GWCFC Outlooks overlay draws both cones with their centre lines',
     r.overlayRings === 2 && r.overlayLines === 2, JSON.stringify(r));
  ok('the Forecaster Desk lists a published cone and can remove it', r.deskRow && r.afterRemove.length === 1 && !r.afterRemove.includes('portal1'), JSON.stringify(r));
  ok('the overlay picks up the change on its next check', r.overlayAfter === 1, JSON.stringify(r));
  ok('an unchanged outlook is not redrawn or announced again', r.quiet, JSON.stringify(r));
  ok('no page errors on the radar', errs.length === 0, errs.join(' | '));
  await p.close();
}

console.log('\n2. The portal: cones issued from the radar are drawn, listed and kept');
{
  const { p, errs } = await open('forecasting-portal.html');
  const r = await p.evaluate(async ({ a, c }) => {
    const store = { latest: { issued: '2026-09-26T11:00:00Z', forecaster: 'Radar Person',
                              v: JSON.stringify({ storms: [], areas: [], cones: [a], alerts: [] }) } };
    const coll = { doc: (id) => ({
      get: async () => ({ exists: !!store[id], data: () => Object.assign({}, store[id]) }),
      set: async (d, o) => { store[id] = o && o.merge ? Object.assign({}, store[id], d) : d; } }),
      add: async () => {} };
    _fbDb = { collection: () => coll };
    const out = {};
    await loadLatest();
    out.drawn = layers.cones.getLayers().filter(l => l instanceof L.Polygon).length;
    out.lines = layers.cones.getLayers().filter(l => l instanceof L.Polyline && !(l instanceof L.Polygon)).length;
    out.dots = layers.cones.getLayers().filter(l => l instanceof L.CircleMarker).length;
    out.listed = /Published forecast cone/.test(document.getElementById('tool-list').innerHTML);
    // Another cone issued from the radar while the portal is open.
    store.latest = { issued: '2026-09-26T11:05:00Z', forecaster: 'Radar Person',
                     v: JSON.stringify({ storms: [], areas: [], cones: [a, c], alerts: [] }) };
    let said = '';
    const t = window.toast; window.toast = (m) => { said = m; };
    await pollNewCones();
    window.toast = t;
    out.afterPoll = layers.cones.getLayers().filter(l => l instanceof L.Polygon).length;
    out.said = said;
    // Publishing from the portal keeps both.
    USER = { uid: 'u2' }; PROFILE = { forecaster: true };
    window.isForecaster = () => true;
    OUTLOOK.forecaster = 'Portal Person';
    await publishOutlook();
    out.published = JSON.parse(store.latest.v).cones.map(x => x.pid);
    // Removing one takes it off the next publish.
    removePubCone(a.pid);
    await publishOutlook();
    out.afterRemove = JSON.parse(store.latest.v).cones.map(x => x.pid);
    await pollNewCones();
    out.removedStaysRemoved = !OUTLOOK.cones.some(x => x.pid === a.pid);
    return out;
  }, { a: portalCone('radar1', 20), c: portalCone('radar2', 14) });
  ok('a cone issued from the radar is drawn on the portal map, with its centre line and dots',
     r.drawn === 1 && r.lines === 1 && r.dots === 3, JSON.stringify(r));
  ok('it is listed in the portal\'s tool list', r.listed, JSON.stringify(r));
  ok('a cone issued while the portal is open appears within a minute, with a note',
     r.afterPoll === 2 && /1 forecast cone just issued by Radar Person/.test(r.said), JSON.stringify(r));
  ok('publishing from the portal keeps the radar\'s cones',
     r.published.length === 2 && r.published.includes('radar1') && r.published.includes('radar2'), JSON.stringify(r));
  ok('a cone removed in the portal leaves the outlook and does not come back',
     JSON.stringify(r.afterRemove) === JSON.stringify(['radar2']) && r.removedStaysRemoved, JSON.stringify(r));
  ok('no page errors on the portal', errs.length === 0, errs.join(' | '));
  await p.close();
}
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
