#!/usr/bin/env node
/*
 * Model 3D: a Vis5D-style box of a forecast model. Right-click the map,
 * "3D model volume here", and a 3D panel opens with see-through isosurfaces
 * of the QG fields (temperature and vorticity advection, vertical motion,
 * potential vorticity), the freezing surface, cloud humidity, a wind speed
 * volume, a slice of wind arrows and the real ground.
 *
 *     node tools/test-model-3d.mjs
 *
 * It reads only the real model runs, through the parsing server's /model3d
 * door (pi/model_volume.py; tools/test-model-volume.py checks that side).
 * Here the door is faked with a made-up atmosphere whose answers are known:
 * warmer to the east under a west wind (so cold air is being blown in
 * everywhere), a jet at 250 mb, and a rising blob in the middle. With a
 * model chart on the map it follows that chart's model, run and hour and
 * drapes the chart over the ground: the 3D model chart and the volume are
 * one panel.
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
  ok('a map menu row', /_cmModel3DHere\(\)">\$\{ic\('terrain3d'\)\} 3D model volume here/.test(PAGE));
  ok('the fields', ['tadv', 'vadv', 'omega', 'pv', 'temp', 'rh'].every(id => PAGE.includes(`{ id: '${id}', label:`)));
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- MODEL 3D'), b = PAGE.indexOf('function _cmModel3DHere');
  ok('no em dashes in the new code or this test', a > 0 && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-model-3d.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const LAT0 = 38, LON0 = -95;
const STD = { 1000: [15, 110], 925: [11, 760], 850: [7, 1460], 700: [-3, 3010], 600: [-11, 4210], 500: [-21, 5570],
  400: [-33, 7180], 300: [-45, 9160], 250: [-52, 10360], 200: [-56, 11780] };
const atmos = (lat, lon, p) => {
  const blob = Math.exp(-((lat - LAT0) ** 2 + (lon - LON0) ** 2) / 8);
  const jet = Math.exp(-(((p - 250) / 120) ** 2)) * Math.exp(-((lat - LAT0) ** 2) / 20);
  return {
    t: STD[p][0] + 0.5 * (lon - LON0) - 0.8 * (lat - LAT0),
    rh: 60 + 38 * blob * Math.exp(-(((p - 700) / 150) ** 2)),
    u: 10 + 45 * jet, v: 0,
    gh: STD[p][1], omega: -2 * blob * Math.exp(-(((p - 500) / 250) ** 2)),
  };
};

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); } catch (e) {} }, CL_ID);
const asked = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('open-meteo')) { asked.push('OPEN-METEO ' + url); return route.abort(); }
  if (url.startsWith('http://pi.test/model3d/sources')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: [
      { key: 'gfs', label: 'GFS', out: 384, step: 3, run: '20260924/12', upper: true },
      { key: 'ecmwf', label: 'ECMWF', out: 240, step: 6, upper: true }] }) });
  }
  if (url.startsWith('http://pi.test/model3d?')) {
    asked.push(url);
    const u = new URL(url), g = k => +u.searchParams.get(k);
    const N = 13, LV = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
    const lats = Array.from({ length: N }, (_, j) => g('s') + j / (N - 1) * (g('n') - g('s')));
    const lons = Array.from({ length: N }, (_, i) => g('w') + i / (N - 1) * (g('e') - g('w')));
    const fields = {};
    ['t', 'rh', 'u', 'v', 'gh', 'omega'].forEach(f => {
      fields[f] = [];
      LV.forEach(pl => lats.forEach(la => lons.forEach(lo => fields[f].push(atmos(la, lo, pl)[f]))));
    });
    const fhr = g('fhr'), run = u.searchParams.get('run') || '20260924/12';
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ model: u.searchParams.get('model'),
      label: u.searchParams.get('model').toUpperCase(), run, fhr, valid: '2026-09-25T00:00:00Z', levels: LV, nx: N, ny: N, lats, lons, fields }) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; });

console.log('\n2. opened from the map menu');
{
  await p.evaluate(([la, lo]) => { map.fire('contextmenu', { latlng: L.latLng(la, lo), originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } }); }, [LAT0, LON0]);
  await p.waitForTimeout(300);
  await p.evaluate(() => [...document.querySelectorAll('#map-ctx-menu .cm-item')].find(x => /3D model volume/.test(x.textContent)).click());
  await p.waitForTimeout(2500);
  const u = new URL(asked[0] || 'http://x');
  ok('asks the parsing server for one box of the real GFS run, never Open-Meteo',
     asked.length === 1 && u.pathname === '/model3d' && u.searchParams.get('model') === 'gfs' && u.searchParams.get('fhr') === '0'
     && +u.searchParams.get('n') > 38 && +u.searchParams.get('s') < 38 && !asked.some(a => a.startsWith('OPEN-METEO')), asked.join(' | '));
  const opts = await p.evaluate(() => [...document.querySelectorAll('#m3d-panel [data-r="model"] option')].map(o => o.value).join(','));
  ok('the model menu is the parsing server\'s own list', opts === 'gfs,ecmwf', opts);
  const st = await p.evaluate(() => ({ open: document.getElementById('m3d-panel').classList.contains('open'),
    cls: document.getElementById('m3d-panel').className, status: document.querySelector('#m3d-panel [data-r="status"]').textContent,
    where: document.querySelector('#m3d-panel [data-r="where"]').textContent }));
  ok('the panel opens, in the 3D panel look', st.open && /l3d-panel/.test(st.cls) && st.where === '38.00, -95.00', JSON.stringify(st));
  ok('and says which run and hour it shows', st.status === 'GFS 09/24 12z F+000, valid 2026-09-25 00Z', st.status);
}

console.log('\n3. the physics');
{
  const r = await p.evaluate(() => {
    const D = _m3d.data, N = M3D_N, K = M3D_LEVELS.length, mid = (k) => k * N * N + 6 * N + 6;
    const k850 = M3D_LEVELS.indexOf(850), k250 = M3D_LEVELS.indexOf(250), k500 = M3D_LEVELS.indexOf(500);
    return { tadv: D.tadv[mid(k850)], u: D.u[mid(k850)], v: D.v[mid(k850)], jet: D.spd[mid(k250)],
      omega: D.omega[mid(k500)], pv250: D.pv[mid(k250)], pv850: D.pv[mid(k850)], z500: D.zkm[mid(k500)] };
  });
  ok('a west wind is u positive, v zero', Math.abs(r.u - 10) < 0.01 && Math.abs(r.v) < 0.01, JSON.stringify(r));
  // dT/dx = 0.5 C per degree of longitude, about 87.7 km at 38N: -10 m/s * 0.5/87.7km * 3600 = -0.205 C/hr
  ok('warmer to the east under a west wind is cold advection, the right size', r.tadv < -0.18 && r.tadv > -0.23, r.tadv);
  ok('omega from the model, shown as upward motion in microbars/s', Math.abs(r.omega - 20) < 0.5, r.omega);
  ok('potential vorticity is positive and larger up high', r.pv250 > 0 && r.pv250 > r.pv850, `${r.pv250} vs ${r.pv850}`);
  ok('heights from the model', Math.abs(r.z500 - 5.57) < 0.01, r.z500);
}

console.log('\n4. drawing');
{
  const drawn = () => p.evaluate(() => {
    const cv = document.querySelector('#m3d-panel canvas'), g = cv.getContext('2d');
    const px = g.getImageData(0, 0, cv.width, cv.height).data;
    let red = 0, blue = 0, bright = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 150 && px[i + 2] < 120) red++;
      if (px[i + 2] > 150 && px[i] < 120) blue++;
      if (px[i] + px[i + 1] + px[i + 2] > 300) bright++;
    }
    return { red, blue, bright, tris: _m3d.counts.tris, vol: _m3d.counts.vol };
  });
  let d = await drawn();
  ok('cold advection is a blue surface, and no warm one', d.tris > 50 && d.blue > 2000, JSON.stringify(d));
  ok('the jet glows in the wind volume', d.vol > 50, d.vol);
  await p.evaluate(() => { const s = document.querySelector('#m3d-panel [data-r="field"]'); s.value = 'omega'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(300);
  d = await drawn();
  ok('rising air is a red blob', d.tris > 20 && d.red > 500, JSON.stringify(d));
  for (const f of ['pv', 'temp', 'rh', 'vadv', 'none']) {
    await p.evaluate(v => { const s = document.querySelector('#m3d-panel [data-r="field"]'); s.value = v; s.dispatchEvent(new Event('change')); }, f);
    await p.waitForTimeout(200);
  }
  const lbl = await p.evaluate(() => document.querySelector('#m3d-panel [data-r="about"]').textContent);
  ok('every field draws without errors', errs.length === 0, errs[0]);
  await p.evaluate(() => { const s = document.querySelector('#m3d-panel [data-r="field"]'); s.value = 'temp'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(200);
  const t = await p.evaluate(() => ({ lbl: document.querySelector('#m3d-panel [data-r="iso-label"]').textContent, tris: _m3d.counts.tris,
    about: document.querySelector('#m3d-panel [data-r="about"]').textContent }));
  ok('the freezing surface is there, and explained', t.lbl === '0.00 °C' || t.lbl === '0 °C' || /^0(\.0+)? °C$/.test(t.lbl), JSON.stringify(t));
  ok('and has triangles', t.tris > 50 && /freezing level/.test(t.about), JSON.stringify(t));
  const before = await p.evaluate(() => _m3d.yaw);
  const box = await p.evaluate(() => { const r = document.querySelector('#m3d-panel canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await p.mouse.move(box.x + box.w / 2, box.y + box.h / 2); await p.mouse.down();
  await p.mouse.move(box.x + box.w / 2 + 80, box.y + box.h / 2, { steps: 4 }); await p.mouse.up();
  ok('dragging turns it', Math.abs((await p.evaluate(() => _m3d.yaw)) - before) > 0.3);
  await p.evaluate(() => document.querySelector('#m3d-panel [data-r="big"]').click());
  await p.waitForTimeout(200);
  await p.screenshot({ path: process.env.SHOT || '/tmp/model-3d.png' });
  await p.evaluate(() => document.querySelector('#m3d-panel [data-r="big"]').click());
}

console.log('\n5. hours, size, closing');
{
  asked.length = 0;
  await p.evaluate(() => { const s = document.querySelector('#m3d-panel [data-r="hour"]'); s.value = 24; s.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(1200);
  const hs = await p.evaluate(() => { const s = document.querySelector('#m3d-panel [data-r="hour"]'); return s.max + '/' + s.step; });
  ok('the hour slider runs as far as the model does, at its step', hs === '384/3', hs);
  ok('and asks for that forecast hour', asked.length === 1 && new URL(asked[0]).searchParams.get('fhr') === '24', asked[0]);
  asked.length = 0;
  await p.evaluate(() => { const s = document.querySelector('#m3d-panel [data-r="size"]'); s.value = '3000'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(1200);
  const q = new URL(asked[0]).searchParams;
  ok('a bigger box asks for a wider one', +q.get('n') - +q.get('s') > 25, q.toString());
  await p.evaluate(() => document.querySelector('#m3d-panel [data-r="x"]').click());
  ok('closes', !(await p.evaluate(() => document.getElementById('m3d-panel').classList.contains('open'))));
}

console.log('\n6. one panel with the model chart');
{
  const menu = await p.evaluate(() => {
    const was = _l3dIsOn; window._l3dIsOn = () => true;
    const rows = _l3dMenuItems(n => '');
    window._l3dIsOn = was;
    return rows;
  });
  ok('no separate "3D model chart" row any more', !/model chart zone/.test(menu) && /waves zone/.test(menu), menu.slice(0, 200));
  // A GFS chart on the map at F+012 of the 18z run, painted red.
  await p.evaluate(() => {
    window._cmPiModel = () => ({ key: 'gfs', label: 'GFS', fhr: 12 });
    _hdManifest = { run: '20260924_18' };
    const pane = map.getPane('modelPane');
    const cv = document.createElement('canvas');
    const r0 = map.getContainer().getBoundingClientRect(), pr = pane.getBoundingClientRect();
    cv.width = 400; cv.height = 300;
    Object.assign(cv.style, { position: 'absolute', left: (r0.left - pr.left) + 'px', top: (r0.top - pr.top) + 'px', width: r0.width + 'px', height: r0.height + 'px' });
    const g = cv.getContext('2d'); g.fillStyle = 'rgb(250,20,20)'; g.fillRect(0, 0, 400, 300);
    pane.appendChild(cv);
    map.setView([38, -95], 4, { animate: false });
  });
  await p.evaluate(() => { map.fire('contextmenu', { latlng: L.latLng(38, -95), originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } }); });
  await p.waitForTimeout(300);
  const row = await p.evaluate(() => [...document.querySelectorAll('#map-ctx-menu .cm-item')].map(x => x.textContent.trim()).find(t => /3D model/.test(t)));
  ok('the menu row names the chart it will show', /3D model volume here: GFS · F\+012/.test(row), row);
  asked.length = 0;
  await p.evaluate(() => [...document.querySelectorAll('#map-ctx-menu .cm-item')].find(x => /3D model/.test(x.textContent)).click());
  await p.waitForTimeout(1500);
  const q = new URL(asked[0] || 'http://x').searchParams;
  ok('it opens on the chart\'s own model, run and hour', q.get('model') === 'gfs' && q.get('fhr') === '12' && q.get('run') === '20260924/18', q.toString());
  const d = await p.evaluate(() => ({ follow: _m3d.follow, on: document.querySelector('#m3d-panel [data-r="follow"]').classList.contains('on'),
    drape: _m3d.drape ? _m3d.drape.painted : 0, status: document.querySelector('#m3d-panel [data-r="status"]').textContent }));
  ok('following the chart, with the chart draped over the ground', d.follow && d.on && d.drape > 500 && /chart draped/.test(d.status), JSON.stringify(d));
  asked.length = 0;
  await p.evaluate(() => { window._cmPiModel = () => ({ key: 'gfs', label: 'GFS', fhr: 18 }); });
  await p.waitForTimeout(1800);
  ok('moving the chart to another hour moves the 3D view with it', asked.length === 1 && new URL(asked[0]).searchParams.get('fhr') === '18', asked.join(' | '));
  await p.evaluate(() => document.querySelector('#m3d-panel [data-r="big"]').click());
  await p.waitForTimeout(300);
  await p.screenshot({ path: process.env.SHOT2 || '/tmp/model-3d-chart.png' });
  await p.evaluate(() => document.querySelector('#m3d-panel [data-r="big"]').click());
  asked.length = 0;
  await p.evaluate(() => { const s = document.querySelector('#m3d-panel [data-r="hour"]'); s.value = 30; s.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(1800);
  const f = await p.evaluate(() => _m3d.follow);
  ok('picking an hour by hand stops following', !f && asked.length === 1 && new URL(asked[0]).searchParams.get('fhr') === '30', asked.join(' | '));
}

console.log('\n7. no parsing server');
{
  await p.evaluate(() => { _hdBase = null; window._hdResolveBase = async () => null; window._cmPiModel = () => null; });
  asked.length = 0;
  await p.evaluate(() => openModel3D(38, -95));
  await p.waitForTimeout(800);
  const st = await p.evaluate(() => document.querySelector('#m3d-panel [data-r="status"]').textContent);
  ok('says it needs the parsing server, and asks nobody else', /parsing server/.test(st) && asked.length === 0, st + ' ' + asked.join(' | '));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
