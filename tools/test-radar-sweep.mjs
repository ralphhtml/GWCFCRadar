#!/usr/bin/env node
/*
 * The broadcast sweep: a TV-style beam rotating over the active
 * single-site radar, toggleable in Settings > Radar.
 *
 *     node tools/test-radar-sweep.mjs
 *
 * The spin is pure CSS on one element; the JS only decides where the
 * disc sits (the same _rcMainSite answer the radar comparison reads, so
 * the beam follows the picture through every source) and how many
 * pixels the radar's picture reaches at the current zoom (the furthest
 * cell actually drawn, or 460 km / 300 km for velocity before one is).
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
  ok('the disc spins in CSS, not in JavaScript',
     /@keyframes sweep-spin \{ to \{ transform: rotate\(360deg\); \} \}/.test(PAGE)
     && /animation: sweep-spin var\(--sweep-dur\) linear infinite;/.test(PAGE));
  ok('a reduced-motion screen keeps the disc but not the spin',
     /prefers-reduced-motion[\s\S]{0,120}\.sweep-disc \{ animation: none/.test(PAGE));
  ok('the beam follows the same site answer the radar comparison reads',
     /_rcMainSite === 'function'\) \? _rcMainSite\(\) : null/.test(PAGE));
  ok('the disc is sized to how far the data really reaches, not a fixed 230 km',
     /\(_sweepKmNow \|\| RADAR_RANGE_KM\) \* 1000 \/ \(111320 \* Math\.cos/.test(PAGE)
     && !/230000 \/ \(111320/.test(PAGE));
  ok('every drawn picture tells the sweep its reach',
     /_sweepNoteRange\(station, product, result && result\.bounds\)/.test(PAGE));
  ok('it sits over the radar and under the alerts',
     /sweepPane/.test(PAGE) && /pn\.style\.zIndex = '402';/.test(PAGE));
  ok('the toggle lives in Settings > Radar and persists',
     /id="lqm-set-sweep"/.test(PAGE)
     && /lqmToggleSetting\('sweep',this\.checked\)/.test(PAGE)
     && /localStorage\.setItem\('gwcfc_sweep', val \? '1' : '0'\)/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-radar-sweep.mjs'), 'utf8').includes(EM));
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
const p = await b.newPage({ viewport: { width: 1100, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 150)));
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
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4500);

console.log('\n2. the beam lives and dies with the single-site picture');
{
  const r = await p.evaluate(async () => {
    const out = {};
    map.setView([35.33, -97.28], 7, { animate: false });
    currentProduct = 'ref'; _refStation = 'ktlx';   // a single-site picture
    await new Promise(r2 => setTimeout(r2, 1400));  // one sync tick
    const el = document.querySelector('.radar-sweep .sweep-disc');
    out.appeared = !!el;
    out.anim = el ? getComputedStyle(el).animationName : '';
    out.w7 = el ? parseInt(el.style.width, 10) : 0;
    map.setZoom(6, { animate: false });
    _sweepResize();
    out.w6 = el ? parseInt(el.style.width, 10) : 0;
    lqmToggleSetting('sweep', false);
    out.goneAfterToggle = !document.querySelector('.radar-sweep');
    out.stored = localStorage.getItem('gwcfc_sweep');
    lqmToggleSetting('sweep', true);
    out.backOn = !!document.querySelector('.radar-sweep');
    _refStation = null; currentProduct = 'radar';   // back to the mosaic
    await new Promise(r2 => setTimeout(r2, 1400));
    out.goneWithSite = !document.querySelector('.radar-sweep');
    return out;
  });
  ok('the beam appears over the active site, spinning', r.appeared && r.anim === 'sweep-spin',
     JSON.stringify(r));
  ok('one zoom step out halves the disc, so it hugs the real range',
     r.w7 > 0 && Math.abs(r.w6 - r.w7 / 2) <= 2, r.w7 + ' -> ' + r.w6);
  ok('the settings toggle removes it and remembers',
     r.goneAfterToggle && r.stored === '0', JSON.stringify(r));
  ok('and brings it straight back', r.backOn === true);
  ok('no single-site radar, no beam', r.goneWithSite === true);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n3. the glow trails the beam, and its look is a setting');
{
  // A frozen disc, drawn on its own page so nothing else is in the pixels:
  // at rotation 0 the beam points straight up and turns clockwise, so just
  // anticlockwise of 12 o'clock (behind it) must glow and just clockwise
  // (ahead of it) must be dark.
  const css = await p.evaluate(() => [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch (e) { return []; } })
    .map(r => r.cssText).filter(t => /sweep-disc|--sweep-/.test(t)).join('\n'));
  const q = await b.newPage({ viewport: { width: 220, height: 220 } });
  const sample = async (vars) => {
    await q.setContent(`<style>${css} body{margin:0;background:#000}
      .sweep-disc{animation:none !important;mix-blend-mode:normal;width:200px;height:200px;left:10px;top:10px}
      :root{${vars}}</style><div class="sweep-disc"></div>`);
    return q.screenshot();
  };
  const read = async (vars) => {
    const png = await sample(vars);
    const b64 = png.toString('base64');
    return p.evaluate(async (b64) => {
      const im = new Image(); im.src = 'data:image/png;base64,' + b64; await im.decode();
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const x = c.getContext('2d'); x.drawImage(im, 0, 0);
      const at = (deg) => {   // a point 70 px out from the centre, deg clockwise from 12 o'clock
        const a = deg * Math.PI / 180, px = Math.round(110 + 70 * Math.sin(a)), py = Math.round(110 - 70 * Math.cos(a));
        const d = x.getImageData(px, py, 1, 1).data; return d[0] + d[1] + d[2];
      };
      const hex = (deg) => { const a = deg * Math.PI / 180; const d = x.getImageData(Math.round(110 + 70 * Math.sin(a)), Math.round(110 - 70 * Math.cos(a)), 1, 1).data; return [d[0], d[1], d[2]]; };
      return { behind: at(-8), ahead: at(8), farBehind: at(-150), rgbBehind: hex(-4) };
    }, b64);
  };
  let r = await read('');
  ok('just behind the beam glows, just ahead of it is dark', r.behind > 60 && r.ahead < 10, JSON.stringify(r));
  ok('and the glow fades out behind it', r.farBehind < r.behind / 4, JSON.stringify(r));
  r = await read('--sweep-rgb: 255,0,0; --sweep-trail: 200deg; --sweep-a: 1;');
  ok('the colour, trail and brightness come from the settings variables',
     r.rgbBehind[0] > 150 && r.rgbBehind[1] < 30 && r.farBehind > 5, JSON.stringify(r));
  await q.close();

  const s = await p.evaluate(() => {
    _sweepSet('speed', 6); _sweepSet('color', '#ff0000'); _sweepSet('alpha', 0.9); _sweepSet('trail', 120);
    const st = document.documentElement.style;
    const out = { dur: st.getPropertyValue('--sweep-dur'), rgb: st.getPropertyValue('--sweep-rgb'),
      a: st.getPropertyValue('--sweep-a'), trail: st.getPropertyValue('--sweep-trail'),
      saved: JSON.parse(localStorage.getItem('gwcfc_sweep_cfg')), label: document.getElementById('sweep-speed-val').textContent };
    _sweepSet('reset');
    out.reset = document.documentElement.style.getPropertyValue('--sweep-dur');
    return out;
  });
  ok('Settings > Radar sets the speed, colour, brightness and trail, and keeps them',
     s.dur === '6s' && s.rgb === '255,0,0' && s.a === '0.9' && s.trail === '120deg'
     && s.saved.speed === 6 && s.label === '6.0 s', JSON.stringify(s));
  ok('and Reset puts the broadcast look back', s.reset === '3.2s', s.reset);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
