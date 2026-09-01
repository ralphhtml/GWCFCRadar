#!/usr/bin/env node
/*
 * The ATCF Updates overlay: live tropical cyclone fixes via KnackWX.
 *
 *     node tools/test-atcf-overlay.mjs
 *
 * The feed is one record per active system worldwide, invests included,
 * and the fixture here is a verbatim sample of the real v2 response (one
 * storm given a movement vector, and one deliberately broken record, so
 * both paths are exercised). The browser half serves that fixture from the
 * route table, drives the real pill, and reads the markers back.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const FIXTURE = readFileSync(join(ROOT, 'tools/fixtures/atcf-v2-sample.json'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the overlay is wired the way the others are');
{
  ok('the pill sits in the overlay row',
     /id="op-atcf" data-ovid="atcf"/.test(PAGE)
     && /toggleOverlayPill\('atcf'\)/.test(PAGE));
  ok('the toggle branch loads on, tears down on off',
     /id === 'atcf'/.test(PAGE)
     && /_atcfTimer = setInterval\(_loadAtcf, 10 \* 60 \* 1000\);/.test(PAGE)
     && /clearInterval\(_atcfTimer\); _atcfTimer = null;/.test(PAGE));
  ok('it reads the v2 feed', /const ATCF_URL = 'https:\/\/api\.knackwx\.com\/atcf\/v2';/.test(PAGE));
  ok('a dead feed says so instead of showing nothing',
     /The ATCF feed is not answering right now/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-atcf-overlay.mjs'), 'utf8').includes(EM));
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
  if (url.includes('api.knackwx.com/atcf/v2'))
    return route.fulfill({ contentType: 'application/json', body: FIXTURE });
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

console.log('\n2. the pill turns the feed into markers');
{
  const r = await p.evaluate(async () => {
    const out = {};
    toggleOverlayPill('atcf');
    await new Promise(res => setTimeout(res, 800));
    out.active = _atcfActive;
    out.pillLit = document.getElementById('op-atcf').classList.contains('active');
    const layers = _atcfLayer ? _atcfLayer.getLayers() : [];
    out.count = layers.length;
    const html = layers.map(l => l.options.icon.options.html);
    out.names = ['EDOUARD', 'KARINA', 'MARIE', 'SAUDEL', 'INVEST']
      .map(n => html.some(x => x.includes(n)));
    out.brokenSkipped = !html.some(x => x.includes('BROKEN'));
    // KARINA is 120 kt: category 4 on the NHC colour ramp.
    const karina = layers.find(l => l.options.icon.options.html.includes('KARINA'));
    out.cat4Color = karina ? karina.options.icon.options.html.includes('#ff8f20') : false;
    // The invest is drawn dashed so a numbered storm reads stronger.
    const invest = layers.find(l => l.options.icon.options.html.includes('INVEST'));
    out.investDashed = invest ? invest.options.icon.options.html.includes('dashed') : false;
    // The western Pacific storm keeps its eastern longitude.
    const saudel = layers.find(l => l.options.icon.options.html.includes('SAUDEL'));
    out.saudelLng = saudel ? saudel.getLatLng().lng : null;
    // The popup carries the whole advisory.
    const ed = layers.find(l => l.options.icon.options.html.includes('EDOUARD'));
    out.popup = ed ? String(ed.getPopup().getContent()) : '';
    out.pane = ed ? ed.options.pane : '';
    return out;
  });
  ok('the pill lights and the engine arms', r.active && r.pillLit);
  ok('every well-formed record is a marker, the broken one is skipped',
     r.count === 5 && r.brokenSkipped, String(r.count));
  ok('every storm and invest is named on the map',
     r.names.every(Boolean), JSON.stringify(r.names));
  ok('a 120 kt hurricane wears the category 4 colour', r.cat4Color);
  ok('an invest is drawn dashed', r.investDashed);
  ok('a west Pacific storm sits at its eastern longitude',
     r.saudelLng === 115.5, String(r.saudelLng));
  ok('the popup carries class, winds in both units, pressure and basin',
     /Tropical Storm/.test(r.popup) && /35 kt \(40 mph\)/.test(r.popup)
     && /1003 mb/.test(r.popup) && /ATL/.test(r.popup), r.popup.slice(0, 120));
  ok('movement reads as a compass heading', /NE at 12 kt/.test(r.popup));
  ok('the fix time and the raw ATCF line are in there too',
     /12:00 UTC 1 Sep/.test(r.popup) && /05L EDOUARD 260901 1200/.test(r.popup));
  ok('markers ride the overlay pane system', r.pane === 'ovp-atcf-m', r.pane);
}

console.log('\n3. off means off');
{
  const r = await p.evaluate(() => {
    toggleOverlayPill('atcf');
    return {
      active: _atcfActive,
      pillLit: document.getElementById('op-atcf').classList.contains('active'),
      layerGone: _atcfLayer === null,
      timerGone: _atcfTimer === null,
    };
  });
  ok('the pill dims and the layer is gone',
     !r.active && !r.pillLit && r.layerGone && r.timerGone, JSON.stringify(r));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
