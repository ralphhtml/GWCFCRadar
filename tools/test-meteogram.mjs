#!/usr/bin/env node
/*
 * Meteograms, NBM 1D Viewer style: right-click the map, "Meteogram here",
 * and a panel like the sounding panel opens with one stacked chart per
 * variable on a shared time axis: box and whisker percentiles with member
 * plumes for temperature, dew point, wind and gusts, stacked precipitation
 * type chances, nested precipitation total chances and CAPE, with one
 * crosshair and a table of exact percentiles for the hour under it.
 *
 *     node tools/test-meteogram.mjs
 *
 * The members come from the parsing server's own ensembles (/ens/point),
 * built here by the real pipeline from members whose answers are known;
 * Open-Meteo is the fallback, faked, for a point off the parsing server's grid.
 */

import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the pieces are in the page');
{
  ok('a Meteogram row in the map menu', /_cmMeteogramHere\(\)">\$\{ic\('chart-bar'\)\} Meteogram here/.test(PAGE));
  ok('the panel shares the sounding panel shell', /#snd-panel, #mtg-panel[, ]/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  const a = PAGE.indexOf('// -- METEOGRAMS'), b = PAGE.indexOf('function _cmMeteogramHere');
  ok('no em dashes in the new code or this test', a > 0 && !PAGE.slice(a, b).includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-meteogram.mjs'), 'utf8').includes(EM));
}

// The parsing server's data, from the real pipeline, plus its point door.
const DATA = mkdtempSync(join(tmpdir(), 'gwcfc-mtg-'));
const PY = `
import sys, json, numpy as np
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'pi'))})
import ens_fields_pipeline as ef
`;
execFileSync('python3', ['-c', PY + `
tl, tn = ef.target()
shape = (len(tl), len(tn))
F = lambda f: (f - 32) * 5 / 9 + 273.15
def fake(mem, fhr):
    if fhr > 18: return None
    k = int(mem[-2:])
    return ({"t2m": np.full(shape, F(50 + 10 * k)), "td2m": np.full(shape, F(40 + 5 * k)),
             "u10": np.full(shape, 4.4704 * (1 + k)), "v10": np.zeros(shape), "gust": np.full(shape, 4.4704 * (5 + 2 * k)),
             "tp": np.full(shape, 25.4 * 0.5 * k if fhr == 6 else 0.0),
             "crain": np.full(shape, 1.0 if k in (1, 2) else 0.0), "csnow": np.full(shape, 1.0 if k == 3 else 0.0),
             "cfrzr": np.full(shape, 1.0 if k == 4 else 0.0)},
            {"tp_start": fhr - 6, "tp_units_m": False})
ef.ENSEMBLES["gefs"] = dict(ef.ENSEMBLES["gefs"], members=["gec00", "gep01", "gep02", "gep03", "gep04"], steps=[6, 12, 18, 24])
ef.build("gefs", "20260924", "12", fetch=fake, workers=2)
ef.ENSEMBLES["gfs"] = dict(ef.ENSEMBLES["gfs"], steps=[6, 12, 18, 24])
ef.build("gfs", "20260924", "12", fetch=lambda mem, fhr: fake("gfs02", fhr), workers=1)
`], { env: { ...process.env, GWCFC_DATA: DATA }, stdio: 'pipe' });
const point = (lat, lon, model = 'gefs') => {
  try {
    return { ok: true, body: execFileSync('python3', ['-c', PY + `print(json.dumps(ef.point_series("${model}", ${lat}, ${lon})))`],
      { env: { ...process.env, GWCFC_DATA: DATA } }).toString() };
  } catch (e) { return { ok: false, body: JSON.stringify({ error: 'outside the ensemble grid' }) }; }
};

// Open-Meteo, faked: 31 members, member m is m-15 degrees off a daily cycle.
const HOURS = 24 * 10, M = 31;
const times = Array.from({ length: HOURS }, (_, i) => new Date(Date.UTC(2026, 8, 25) + i * 3600e3).toISOString().slice(0, 16));
const omFake = () => {
  const hourly = { time: times };
  for (let m = 0; m < M; m++) {
    const suf = m ? '_member' + String(m).padStart(2, '0') : '';
    hourly['temperature_2m' + suf] = times.map((_, i) => 60 + 10 * Math.sin(i / 24 * 2 * Math.PI) + (m - 15));
    hourly['dew_point_2m' + suf] = times.map(() => 50);
    hourly['precipitation' + suf] = times.map((_, i) => (i % 24 === 12 ? 0.1 : 0));
    hourly['snowfall' + suf] = times.map(() => 0);
    hourly['wind_speed_10m' + suf] = times.map(() => 10);
    hourly['wind_gusts_10m' + suf] = times.map(() => 20);
  }
  return { hourly };
};

const { chromium } = await import('playwright');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); localStorage.removeItem('gwcfc_mtg_source'); } catch (e) {} }, CL_ID);
const asked = [];
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.startsWith('http://pi.test/ens/point')) {
    asked.push(url);
    const u = new URL(url), r = point(+u.searchParams.get('lat'), +u.searchParams.get('lon'), u.searchParams.get('model'));
    return route.fulfill({ status: r.ok ? 200 : 404, contentType: 'application/json', body: r.body });
  }
  if (url.startsWith('http://pi.test/ens/')) {
    try { return route.fulfill({ contentType: 'application/json', body: readFileSync(join(DATA, new URL(url).pathname.slice(1))) }); }
    catch (e) { return route.fulfill({ status: 404, body: '' }); }
  }
  if (url.includes('ensemble-api.open-meteo.com')) { asked.push(url); return route.fulfill({ contentType: 'application/json', body: JSON.stringify(omFake()) }); }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);
await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; _hdBase = 'http://pi.test'; });

console.log('\n2. opened from the map menu, on the real ensemble');
{
  await p.evaluate(() => { map.fire('contextmenu', { latlng: L.latLng(35.2, -97.4), originalEvent: { clientX: 400, clientY: 300, preventDefault() {} } }); });
  await p.waitForTimeout(300);
  await p.evaluate(() => [...document.querySelectorAll('#map-ctx-menu .cm-item')].find(x => /Meteogram/.test(x.textContent)).click());
  await p.waitForTimeout(2500);
  const u = new URL(asked.find(a => a.includes('/ens/point')) || 'http://x');
  ok('asks the parsing server for every member at the clicked point', u.searchParams.get('model') === 'gefs'
     && u.searchParams.get('lat') === '35.200' && u.searchParams.get('lon') === '-97.400' && !asked.some(a => a.includes('open-meteo')), asked.join(' | '));
  const st = await p.evaluate(() => {
    const el = document.getElementById('mtg-panel');
    return { open: el.classList.contains('open'), where: el.querySelector('.snd-where').textContent,
      sources: [...el.querySelectorAll('.snd-src option')].map(o => o.value), note: el.querySelector('.snd-note').textContent,
      charts: [...el.querySelectorAll('.mtg-chart-card')].map(c => c.dataset.chart), pos: getComputedStyle(el).position };
  });
  ok('the panel opens where it was asked, in the sounding panel shell', st.open && st.where === '35.20, -97.40' && st.pos === 'fixed', JSON.stringify(st));
  ok('the parsing server ensembles first, Open-Meteo after', st.sources.join() === 'pi:gefs,pi:gfs,om:gfs025,om:ecmwf_ifs025,om:icon_seamless,om:gem_global', st.sources.join());
  ok('one chart per variable the ensemble has', st.charts.join() === 't2m,td2m,wind10,gust,ptype,qpf', st.charts.join());
  ok('says it is real model members, and where', /GEFS, 09\/24 12z run, 5 members/.test(st.note) && /from the parsing server, at the grid point 35, -97.5/.test(st.note), st.note);
}

console.log('\n3. the numbers');
{
  const r = await p.evaluate(() => {
    const S = document.getElementById('mtg-panel')._mtg;
    return { t: S.stats.t2m[1], w: S.stats.wind10[1], ex: S.exceed[1], pt: S.ptype[1], times: S.times.length };
  });
  const near = (a, b) => Math.abs(a - b) < 0.1;
  ok('temperature percentiles across the five members', near(r.t.p10, 54) && near(r.t.p25, 60) && near(r.t.p50, 70) && near(r.t.p75, 80) && near(r.t.p90, 86), JSON.stringify(r.t));
  ok('wind in mph', near(r.w.p50, 30), JSON.stringify(r.w));
  ok('precipitation total chances: 80, 80, 80, 80, 60, 20%', r.ex.map(Math.round).join() === '80,80,80,80,60,20', r.ex.join());
  ok('precipitation type chances: liquid 40, frozen 20, freezing 20', Math.round(r.pt.liquid) === 40 && Math.round(r.pt.frozen) === 20 && Math.round(r.pt.freezing) === 20, JSON.stringify(r.pt));
}

console.log('\n4. drawing and the crosshair');
{
  const lit = await p.evaluate(() => [...document.querySelectorAll('#mtg-panel .mtg-chart-card canvas')].map(cv => {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++;
    return n;
  }));
  ok('every chart draws', lit.every(n => n > 1500), lit.join());
  const box = await p.evaluate(() => { const r = document.querySelector('#mtg-panel [data-chart="t2m"] canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await p.mouse.move(box.x + 40 + (box.w - 50) / 3, box.y + box.h / 2);
  await p.waitForTimeout(150);
  const h = await p.evaluate(() => ({ read: document.querySelector('#mtg-panel .mtg-read').textContent,
    cursors: [...document.querySelectorAll('#mtg-panel .mtg-cursor')].filter(c => getComputedStyle(c).display === 'block').length,
    lefts: [...new Set([...document.querySelectorAll('#mtg-panel .mtg-cursor')].map(c => c.style.left))] }));
  ok('one crosshair through every chart', h.cursors === 6 && h.lefts.length === 1, JSON.stringify(h));
  ok('and the exact percentiles for that hour', /Temperature5460708086°F/.test(h.read.replace(/\s/g, '')) && /Type: liquid 40% · frozen 20% · freezing 20%/.test(h.read)
     && /Total at least: 0.01 in 80%/.test(h.read), h.read);
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-big').click());
  await p.waitForTimeout(300);
  await p.screenshot({ path: process.env.SHOT || '/tmp/meteogram.png' });
  const big = await p.evaluate(() => document.querySelector('#mtg-panel [data-chart="t2m"] canvas').getBoundingClientRect().height);
  ok('expanding makes the charts bigger', big > 150, big);
  await p.evaluate(() => document.querySelector('#mtg-panel .snd-big').click());
}

console.log('\n4b. the ordinary GFS run from the parsing server, as a line');
{
  await p.evaluate(() => { const s = document.querySelector('#mtg-panel .snd-src'); s.value = 'pi:gfs'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(2000);
  const r = await p.evaluate(() => { const el = document.getElementById('mtg-panel'), S = el._mtg;
    return { members: S.members, source: S.source, t: S.vars.t2m[1][0], note: el.querySelector('.snd-note').textContent,
      label: el.querySelector('.snd-src').selectedOptions[0].textContent, charts: el.querySelectorAll('.mtg-chart-card').length }; });
  ok('the single GFS run from the parsing server, drawn as a line', r.members === 1 && r.source === 'server' && Math.abs(r.t - 70) < 0.1
     && /a single run \(drawn as a line\)/.test(r.note) && r.label === 'GFS run (parsing server)' && r.charts >= 4, JSON.stringify(r));
}

console.log('\n5. Open-Meteo, and the fallback');
{
  asked.length = 0;
  await p.evaluate(() => { const s = document.querySelector('#mtg-panel .snd-src'); s.value = 'om:ecmwf_ifs025'; s.dispatchEvent(new Event('change')); });
  await p.waitForTimeout(1200);
  const r = await p.evaluate(() => { const S = document.getElementById('mtg-panel')._mtg; return { members: S.members, n: S.times.length, gap: (S.times[1] - S.times[0]) / 3600e3,
    saved: localStorage.getItem('gwcfc_mtg_source'), note: document.querySelector('#mtg-panel .snd-note').textContent }; });
  ok('Open-Meteo still works, every third hour', r.members === 31 && r.gap === 3 && /Open-Meteo ensemble API/.test(r.note), JSON.stringify(r));
  ok('the choice is remembered', r.saved === 'om:ecmwf_ifs025');
  await p.evaluate(() => localStorage.removeItem('gwcfc_mtg_source'));
  await p.evaluate(() => { _mtgSource = null; openMeteogram(10.5, -95); });
  await p.waitForTimeout(2500);
  const f = await p.evaluate(() => ({ alert: document.querySelector('#mtg-panel .snd-alert').textContent, src: document.querySelector('#mtg-panel .snd-src').value }));
  ok('a point off the parsing server\'s grid falls back to Open-Meteo, and says so', /could not answer here/.test(f.alert) && f.src === 'om:gfs025', JSON.stringify(f));
  // A parsing server with nothing built yet: Open-Meteo, and it says why.
  await p.route('http://pi.test/ens/index.json**', route => route.fulfill({ status: 404, body: '' }));
  await p.evaluate(() => { _mtgSource = null; openMeteogram(35.2, -97.4); });
  await p.waitForTimeout(2500);
  const e = await p.evaluate(() => ({ alert: document.querySelector('#mtg-panel .snd-alert').textContent,
    src: document.querySelector('#mtg-panel .snd-src').value }));
  ok('with no ensembles built yet it says why it is on Open-Meteo', e.src === 'om:gfs025'
     && /has not built its ensembles yet/.test(e.alert), JSON.stringify(e));
  await p.unroute('http://pi.test/ens/index.json**');
  await p.keyboard.press('Escape');
  ok('Escape closes it', !(await p.evaluate(() => document.getElementById('mtg-panel').classList.contains('open'))));
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
