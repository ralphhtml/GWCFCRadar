#!/usr/bin/env node
/*
 * Forecaster alerts say GWCFC; fun alerts live in the Storm Cone tool.
 *
 *     node tools/test-fun-alerts.mjs
 *
 * The Alert Desk used to be open to everyone and stamped SIMULATED on every
 * product, including the ones GWCFC forecasters issue to everyone. Now:
 *   - the Alert Desk is for forecasters, and what it issues is labelled GWCFC,
 *     drawn solid, and never called simulated;
 *   - making a warning for fun is the Storm Cone tool's Fun Alert, for anyone:
 *     draw a box, or turn the cone into the warning; on that screen only,
 *     marked as not real, never published;
 *   - fake alerts made before stay, as fun alerts, unless a forecaster made
 *     them, in which case they are claimed as GWCFC products.
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
ok('the Storm Cone toolbar has a Fun Alert button', /id="sc-fun-btn" onclick="_scToggleFun\(event\)"/.test(PAGE));

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const LF = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
const OLD = { uid: 'sim-old1', code: 'TOR', haz: { tornado: { lvl: 2, amt: '' } }, tag: 'none', source: 'Radar indicated',
  extra: '', body: null, areaDesc: 'Old County',
  geometry: { type: 'Polygon', coordinates: [[[-97.8, 35.2], [-97.2, 35.2], [-97.2, 35.7], [-97.8, 35.7], [-97.8, 35.2]]] },
  issued: Date.now(), expires: Date.now() + 3600000, status: 'active', area: { mode: 'draw', poly: [], zones: [] } };
async function open(file, forecaster, items) {
  const ctx = await b.newContext({ viewport: { width: 1300, height: 850 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
  await p.addInitScript(({ id, items }) => {
    localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id);
    localStorage.setItem('gwcfc_sc_mode', 'drag');
    if (items) localStorage.setItem('gwcfc_alertdesk', JSON.stringify({ items }));
  }, { id: CL_ID, items });
  await p.route('**://**', r => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(LF + '/leaflet.js', 'utf8') });
    if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(LF + '/leaflet.css', 'utf8') });
    return r.abort();
  });
  await p.goto('file://' + join(ROOT, file), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  if (file === 'index.html') {
    await p.evaluate((f) => {
      window._fdLoadProfile = async () => (f ? { forecaster: true, displayName: 'Tester' } : {});
      window._fdIsForecaster = (pr) => !!(pr && pr.forecaster);
      _fdProfile = f ? { forecaster: true } : null;
    }, forecaster);
  }
  return { p, errs, ctx };
}

console.log('\n1. Someone who is not a forecaster');
{
  const { p, errs, ctx } = await open('index.html', false, [OLD]);
  const r = await p.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const out = {};
    let said = ''; const st = window.showToast; window.showToast = (m) => { said = m; };
    out.opened = await _adOpen();
    out.deskShown = !!(document.getElementById('ad-modal') && document.getElementById('ad-modal').style.display === 'flex');
    out.said = said;
    window.showToast = st;
    await _fdSyncButton();
    out.rowHidden = document.getElementById('lqm-ad-row').style.display === 'none';
    _srchCat = null;
    const cat = _srchCatalog().map(c => c.label);
    out.catFun = cat.includes('Fun Alert'); out.catDesk = cat.includes('Alert Desk');
    // Their old practice alert stays, as a fun one.
    _adRedrawAlerts();
    const f = _lastAlertFeatures.find(x => x.properties.id === 'sim-old1');
    out.oldKept = !!f && f.properties._simulated === true && /JUST FOR FUN/.test(f.properties.headline);
    out.oldNotPublished = !_fdSerializeDesk().some(a => a.uid === 'sim-old1');

    // The Storm Cone tool: draw a box.
    map.setView([35.5, -97.5], 7, { animate: false });
    toggleStormConeTool();
    _scToggleFun();
    out.panel = document.getElementById('sc-fun-panel').classList.contains('open')
      && document.getElementById('sc-fun-code').options.length >= 15;
    document.getElementById('sc-fun-code').value = 'SVR'; _scFunSyncMins();
    _scFunDraw();
    out.panelAway = !document.getElementById('sc-fun-panel').classList.contains('open');
    const box = map.getContainer().getBoundingClientRect();
    const tap = (x, y) => {
      const o = { clientX: box.left + x, clientY: box.top + y, bubbles: true, cancelable: true };
      map.getContainer().dispatchEvent(new PointerEvent('pointerdown', o));
      map.getContainer().dispatchEvent(new MouseEvent('click', o));
    };
    const before = _adState.items.length;
    tap(500, 300); tap(800, 300); tap(800, 500); tap(500, 500); tap(502, 302);
    await wait(100);
    const made = _adState.items[0];
    out.drawn = _adState.items.length === before + 1 && made.kind === 'fun' && made.code === 'SVR'
      && made.geometry.coordinates[0].length === 5;
    out.noConeStarted = !_scTrack && !_scCones.length;
    const ff = _lastAlertFeatures.find(x => x.properties.id === made.uid);
    out.drawnMarked = !!ff && ff.properties._simulated && /not a real alert/i.test(_adText(made));
    out.named = /near /.test(made.areaDesc) || made.areaDesc === 'the drawn area';
    // Turn a cone into one.
    const click = (lat, lng) => _onScClick({ latlng: L.latLng(lat, lng), originalEvent: null });
    const move = (lat, lng) => _onScMove({ latlng: L.latLng(lat, lng) });
    click(34.8, -98.2); move(35.4, -97.4); click(35.9, -96.6);
    const ring = _scTrack && _scTrack.ring;
    document.getElementById('sc-fun-code').value = 'TOR';
    const coneFun = _scFunFromCone();
    out.fromCone = !!coneFun && coneFun.code === 'TOR' && coneFun.geometry.coordinates[0].length === ring.length + 1
      && /storm cone/.test(coneFun.areaDesc);
    _scToggleFun();
    out.listed = document.querySelectorAll('#sc-fun-list .sc-fun-item').length === 3;
    out.published = _fdSerializeDesk().length;
    _scFunRemove(made.uid);
    out.removed = !_adState.items.some(a => a.uid === made.uid);
    _scFunRemove('*');
    out.cleared = !_adState.items.some(a => a.status === 'active' && _adIsFun(a));
    return out;
  });
  ok('the Alert Desk does not open, and says where fun alerts are now', !r.opened && !r.deskShown && /Storm Cone/.test(r.said), JSON.stringify(r));
  ok('the Alert Desk row in Settings is hidden', r.rowHidden, JSON.stringify(r));
  ok('search offers Fun Alert, not the Alert Desk', r.catFun && !r.catDesk, JSON.stringify(r));
  ok('an old practice alert stays, marked as just for fun, and is not published', r.oldKept && r.oldNotPublished, JSON.stringify(r));
  ok('Fun Alert opens in the Storm Cone tool with every warning type', r.panel, JSON.stringify(r));
  ok('drawing a box makes a fun alert of the chosen type', r.panelAway && r.drawn, JSON.stringify(r));
  ok('the corners never start a storm cone underneath', r.noConeStarted, JSON.stringify(r));
  ok('it is marked as not real, and named for where it is', r.drawnMarked && r.named, JSON.stringify(r));
  ok('"Use this cone" turns the cone into the warning area, point for point', r.fromCone, JSON.stringify(r));
  ok('fun alerts are listed in the panel, and nothing is published', r.listed && r.published === 0, JSON.stringify(r));
  ok('one can be removed, or all of them', r.removed && r.cleared, JSON.stringify(r));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n2. A GWCFC forecaster');
{
  const { p, errs, ctx } = await open('index.html', true, [OLD]);
  const r = await p.evaluate(async () => {
    const out = {};
    await _fdSyncButton();
    out.claimed = _adState.items[0].kind === 'gwcfc';
    out.rowShown = document.getElementById('lqm-ad-row').style.display !== 'none';
    out.opened = (await _adOpen()) !== false && document.getElementById('ad-modal').style.display === 'flex';
    out.headNote = document.getElementById('ad-head-note').textContent;
    _adClose();
    _adDraft = _adNewDraft('TOR');
    _adDraft.poly = [[35, -97.5], [35.4, -97.5], [35.4, -97], [35, -97]].map(q => ({ lat: q[0], lng: q[1] }));
    _adDraft.areaName = 'Test County';
    _adIssue();
    const a = _adState.items[0];
    const f = _adToFeature(a);
    const text = _adText(a);
    out.kind = a.kind;
    out.head = f.properties.headline;
    out.sender = f.properties.senderName;
    out.flags = [f.properties._gwcfc, f.properties._simulated];
    out.text = /^ISSUED BY GWCFC\./.test(text) && !/SIMULATED|NOT A REAL/i.test(text);
    const popup = _buildAlertPopupHTML(f.properties, '#ff0000');
    out.popup = /ap-gwcfc-banner">GWCFC</.test(popup) && !/SIMULATED/i.test(popup);
    _adRedrawAlerts();
    const card = Array.from(document.querySelectorAll('#alerts-panel-body .alert-card')).find(c => /Test County/.test(c.textContent));
    out.card = !!card && /GWCFC/.test(card.textContent) && !/SIMULATED/i.test(card.textContent);
    out.published = _fdSerializeDesk().map(x => x.uid).includes(a.uid);
    // Their fun alert stays off the air.
    const fun = _scFunMake([[36, -98], [36.3, -98], [36.3, -97.6]]);
    out.funNotPublished = !_fdSerializeDesk().some(x => x.uid === fun.uid);
    out.deskListsNoFun = (() => { _adOpen(); return true; })();
    return out;
  });
  await p.waitForTimeout(200);
  const listed = await p.evaluate(() => document.getElementById('ad-active').textContent);
  ok('their old products are claimed as GWCFC ones', r.claimed, JSON.stringify(r));
  ok('the Alert Desk row shows, and the desk opens', r.rowShown && r.opened && /GWCFC/.test(r.headNote), JSON.stringify(r));
  ok('what they issue is a GWCFC product', r.kind === 'gwcfc' && r.sender === 'GWCFC' && r.flags[0] === true && r.flags[1] === false, JSON.stringify(r));
  ok('the headline says GWCFC and never "simulated"', /issued by GWCFC/.test(r.head) && !/SIMULATED/i.test(r.head), r.head);
  ok('so does the text, the popup and the Alerts panel card', r.text && r.popup && r.card, JSON.stringify(r));
  ok('it is published to everyone; their fun alert is not', r.published && r.funNotPublished, JSON.stringify(r));
  ok('the desk lists only GWCFC products', !/just for fun/i.test(listed), listed.slice(0, 200));
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n3. The Forecasting Portal, sharing the same saved alerts');
{
  const fun = Object.assign({}, OLD, { uid: 'fun-1', kind: 'fun', areaDesc: 'Fun Place' });
  const gw = Object.assign({}, OLD, { uid: 'gw-1', kind: 'gwcfc', areaDesc: 'Real Place' });
  const { p, errs, ctx } = await open('forecasting-portal.html', true, [fun, gw]);
  const r = await p.evaluate(() => {
    renderAlerts();
    let n = 0; _portalDeskLayer.eachLayer(() => n++);
    return { drawn: n, published: portalSerializeDesk().map(a => a.uid),
             head: _adHeadline(gw_ = _adLoad().items.find(a => a.uid === 'gw-1')),
             text: _adText(gw_) };
  });
  ok('the portal draws and publishes only the GWCFC product, never a fun one',
     r.drawn === 1 && JSON.stringify(r.published) === '["gw-1"]', JSON.stringify(r));
  ok('and labels it GWCFC, not simulated', /issued by GWCFC/.test(r.head) && /ISSUED BY GWCFC/.test(r.text) && !/SIMULATED/.test(r.text + r.head), JSON.stringify(r));
  ok('no page errors in the portal', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
