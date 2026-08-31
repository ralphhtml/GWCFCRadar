#!/usr/bin/env node
/*
 * The four SHARPpy side panels, as sounding tabs.
 *
 *     node tools/test-sounding-tabs.mjs
 *
 * Theta-E with pressure, storm-relative wind with height, inferred
 * temperature advection, and the possible-hazard call. Each one reads the
 * profile the panel already holds; none of them fetch anything.
 *
 * The physics is what gets tested hardest, because a chart that draws the
 * wrong number with total confidence is worse than no chart: Bolton's
 * theta-e against known values, the thermal-wind advection against the
 * textbook case (veering wind = warm advection), and the hazard tree
 * against profiles whose right answer is not in dispute.
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

console.log('\n1. the tabs and panes exist in the source');
{
  ['thermo', 'srwind', 'advect', 'hazard'].forEach(id =>
    ok(`the ${id} tab is on the menu and has a pane`,
       new RegExp(`id: '${id}', {2}label:`).test(PAGE)
       && new RegExp(`data-pane="${id}"`).test(PAGE)));
  ok('every new view is painted by the shared dispatcher',
     /_sndDrawThetaE\(el\.querySelector/.test(PAGE)
     && /_sndDrawSRWind\(el\.querySelector/.test(PAGE)
     && /_sndDrawAdvect\(el\.querySelector/.test(PAGE)
     && /_sndHazardHTML\(d\)/.test(PAGE));
  ok('the hazard pane admits it is simplified',
     /Simplified from SHARPpy/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-sounding-tabs.mjs'), 'utf8').includes(EM));
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
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'),
             { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. the physics holds up');
{
  const r = await p.evaluate(() => {
    const out = {};
    // Bolton theta-e at a canonical warm-sector point: 1000 mb, 25/20.
    // Every published calculator puts this in the mid-340s K.
    out.thetaE = _sndThetaEK(1000, 25, 20);
    out.moreMoistureIsMore = _sndThetaEK(1000, 25, 20) > _sndThetaEK(1000, 25, 10);
    out.higherIsConservedish = _sndThetaEK(850, 15, 12);

    // The textbook advection case: a southerly under a westerly (veering
    // with height) must read as WARM advection; the mirror image as cold.
    const veer = [{ p: 1000, u: 0, v: 20 }, { p: 850, u: 20, v: 0 }];
    const back = [{ p: 1000, u: 20, v: 0 }, { p: 850, u: 0, v: 20 }];
    out.veerAdv = _sndTempAdvLayers(veer, 35)[0].adv;
    out.backAdv = _sndTempAdvLayers(back, 35)[0].adv;

    // The hazard tree against profiles whose answer is not in dispute.
    const hz = d => _sndHazard(d).type;
    out.pds = hz({ ml: { cape: 2500 }, stp: 5, stpFixed: 4, srh1: 300,
                   shear6: 50, scp: 12, pwat: 35 });
    out.tor = hz({ ml: { cape: 1500 }, stp: 1.4, srh1: 150, shear6: 40,
                   scp: 4, pwat: 30 });
    out.svr = hz({ ml: { cape: 1800 }, stp: 0.1, srh1: 40, shear6: 42,
                   scp: 3, pwat: 30 });
    out.none = hz({ ml: { cape: 80 }, stp: 0, srh1: 10, shear6: 8,
                    scp: 0, pwat: 15 });
    out.flood = hz({ ml: { cape: 900 }, stp: 0, srh1: 20, shear6: 12,
                     scp: 0, pwat: 55 });
    return out;
  });
  ok('theta-e lands where Bolton says (1000 mb, 25/20 in the 340s K)',
     r.thetaE > 335 && r.thetaE < 355, String(r.thetaE));
  ok('more moisture means higher theta-e', r.moreMoistureIsMore);
  ok('veering wind reads as warm advection', r.veerAdv > 0, String(r.veerAdv));
  ok('backing wind reads as cold advection', r.backAdv < 0, String(r.backAdv));
  ok('and the two are mirror images',
     Math.abs(r.veerAdv + r.backAdv) < 1e-9, `${r.veerAdv} vs ${r.backAdv}`);
  ok('a loaded tornado profile calls PDS TOR', r.pds === 'PDS TOR', r.pds);
  ok('a tornado profile calls TOR', r.tor === 'TOR', r.tor);
  ok('shear and CAPE without low SRH calls SVR', r.svr === 'SVR', r.svr);
  ok('a soaked but calm profile calls FLASH FLOOD', r.flood === 'FLASH FLOOD',
     r.flood);
  ok('a quiet profile calls NONE', r.none === 'NONE', r.none);
}

console.log('\n3. the panel draws all four, from one synthetic profile');
{
  const r = await p.evaluate(async () => {
    const out = {};
    // A veering, moist, sheared profile: enough of everything that every
    // pane has something real to draw.
    const prof = { lat: 35, lon: -97, levels: [
      { p: 1000, t: 25, td: 21, u: 0,  v: 20 },
      { p: 925,  t: 20, td: 17, u: 10, v: 25 },
      { p: 850,  t: 15, td: 12, u: 20, v: 25 },
      { p: 700,  t: 6,  td: -2, u: 30, v: 20 },
      { p: 500,  t: -10, td: -25, u: 45, v: 10 },
      { p: 400,  t: -20, td: -40, u: 55, v: 5 },
      { p: 300,  t: -33, td: -55, u: 65, v: 0 },
      { p: 250,  t: -42, td: -65, u: 70, v: 0 },
      { p: 200,  t: -54, td: -75, u: 70, v: 0 },
    ]};
    const d = _sndDerive(prof);
    out.derived = !!d && !!d.motion;

    // Build the panel without waiting for its network fetch to fail.
    openSounding(35, -97);
    await new Promise(res => setTimeout(res, 400));
    const el = document.getElementById('snd-panel');
    el.classList.add('open', 'big');
    el._snd = d; el._prof = prof;

    out.tabs = [...el.querySelectorAll('.snd-tab')].map(t => t.dataset.tab);
    const painted = (id) => {
      const c = el.querySelector('#' + id);
      if (!c || !c.width) return false;
      const g = c.getContext('2d');
      const px = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return true;
      return false;
    };
    _sndTab(el, 'thermo');  out.thetaePainted = painted('snd-thetae');
    _sndTab(el, 'srwind');  out.srPainted = painted('snd-srwind');
    _sndTab(el, 'advect');  out.advPainted = painted('snd-advect');
    _sndTab(el, 'hazard');
    const hazEl = el.querySelector('.snd-hazard');
    out.hazText = hazEl ? hazEl.textContent : '';
    out.hazShown = !el.querySelector('.snd-pane[data-pane="hazard"]').hidden;
    el.classList.remove('open');
    return out;
  });
  ok('the synthetic profile derives cleanly', r.derived);
  ok('all eight tabs are on the panel',
     ['chart', 'hodo', 'wind', 'numbers', 'thermo', 'srwind', 'advect', 'hazard']
       .every(t => r.tabs.includes(t)), JSON.stringify(r.tabs));
  ok('the theta-e pane paints real pixels', r.thetaePainted);
  ok('the SR wind pane paints real pixels', r.srPainted);
  ok('the advection pane paints real pixels', r.advPainted);
  ok('the hazard pane renders a verdict with its reasons',
     r.hazShown && /TOR|SVR|NONE|FLOOD/.test(r.hazText)
     && /shear/i.test(r.hazText), r.hazText.slice(0, 80));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}
await b.close();

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
