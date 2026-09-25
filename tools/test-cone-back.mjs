#!/usr/bin/env node
/*
 * The Storm Cone tool's Back button, and the forecaster-only Issue button.
 *
 *     node tools/test-cone-back.mjs
 *
 * Clicking the map with a cone on screen starts a new cone in its place;
 * done by accident, that erased the old cone for good. Back now brings it
 * back, with its speed and settings, and drops the new one. The toolbar also
 * has an Issue button that only forecasters see, which publishes the cones
 * through the Forecaster Desk's own Issue after reading the outlook in force.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1300, height: 850 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); localStorage.setItem('gwcfc_sc_mode', 'drag'); }, CL_ID);
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

console.log('\n1. Back after an accidental new cone');
const r = await p.evaluate(async () => {
  map.setView([28, -85], 6, { animate: false });
  toggleStormConeTool();
  const click = (lat, lng) => _onScClick({ latlng: L.latLng(lat, lng), originalEvent: null });
  const move = (lat, lng) => _onScMove({ latlng: L.latLng(lat, lng) });
  const out = {};
  out.backOffAtStart = document.getElementById('sc-back-btn').disabled;
  document.getElementById('sc-speed-input').value = 18;
  click(24, -86); move(28, -84); click(30, -83);
  const first = _scTrack; out.firstId = _scActiveConeId;
  // An accidental click starts a new one, which previews over the old.
  click(26, -90);
  document.getElementById('sc-speed-input').value = 40;   // set for the new one
  move(29, -92);
  out.previewed = !!_scTrack && _scTrack !== first;
  out.backOn = !document.getElementById('sc-back-btn').disabled;
  click(31, -93);
  out.replaced = _scTrack !== first;
  _scBack();
  out.restored = _scTrack === first && _scActiveConeId === out.firstId;
  out.speed = document.getElementById('sc-speed-input').value;
  out.onMap = !!_scPolygon && map.hasLayer(_scPolygon);
  out.backOffAfter = document.getElementById('sc-back-btn').disabled;
  // Multi-point mode keeps a replaced cone too.
  _scSetMode('multi');
  _scMultiClick(L.latLng(22, -80)); _scMultiClick(L.latLng(25, -79));
  out.multiBack = !document.getElementById('sc-back-btn').disabled;
  _scBack();
  out.multiRestored = _scTrack === first;
  // + New keeps the old one and does not need Back.
  _scSetMode('drag');
  _scNew();
  out.kept = _scCones.length === 1;
  return out;
});
ok('Back is off until something is replaced', r.backOffAtStart, JSON.stringify(r));
ok('the next cone still previews while the mouse moves', r.previewed, JSON.stringify(r));
ok('starting a new cone makes Back available', r.backOn, JSON.stringify(r));
ok('Back brings the replaced cone back, with its number', r.replaced && r.restored, JSON.stringify(r));
ok('and its own speed', r.speed === '18', JSON.stringify(r));
ok('drawn on the map again', r.onMap, JSON.stringify(r));
ok('with nothing left to go back to, Back switches off', r.backOffAfter, JSON.stringify(r));
ok('multi-point: a new placement can be undone the same way', r.multiBack && r.multiRestored, JSON.stringify(r));
ok('+ New still keeps the old cone on the map', r.kept, JSON.stringify(r));

console.log('\n2. Issue, forecasters only');
const f = await p.evaluate(async () => {
  const btn = document.getElementById('sc-issue-btn');
  const out = {};
  window._fdLoadProfile = async () => ({});
  _currentUser = { uid: 'u1', email: 'someone@example.com', isAnonymous: false };
  await _scSyncIssueBtn();
  out.hiddenForOthers = btn.style.display === 'none';
  window._fdLoadProfile = async () => ({ forecaster: true, displayName: 'Tester' });
  await _scSyncIssueBtn();
  out.shownForForecaster = btn.style.display !== 'none';
  // Issue goes through the desk, after reading the outlook in force.
  const calls = [];
  window._fdSeedFromPublished = async () => { calls.push('seed'); };
  window._fdPublish = async () => { calls.push('publish:' + _fdSerializeCones().length); _fdStatus('Issued at 12:00Z as Tester.'); };
  window.confirm = () => true;
  await _scIssue();
  out.calls = calls.slice();
  out.status = document.getElementById('stormcone-status').textContent;
  window.confirm = () => false; calls.length = 0;
  await _scIssue();
  out.cancelled = calls.length === 0;
  return out;
});
ok('hidden for anyone who is not a forecaster', f.hiddenForOthers, JSON.stringify(f));
ok('shown for a forecaster', f.shownForForecaster, JSON.stringify(f));
ok('issuing reads the outlook in force, then publishes the cones', f.calls.join() === 'seed,publish:1', JSON.stringify(f));
ok('the toolbar says it went', /Issued at/.test(f.status), JSON.stringify(f));
ok('saying no to the confirmation issues nothing', f.cancelled, JSON.stringify(f));
ok('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
