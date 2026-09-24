#!/usr/bin/env node
/*
 * Isothermal reflectivity and VII: the MRMS products read at a temperature
 * (0, -5, -10, -15, -20 C) plus Vertically Integrated Ice get their own
 * "Isothermal & Ice" group, and while one isotherm slice is on the height
 * slider grows an Isotherm column that swaps between them.
 *
 *     node tools/test-isotherm.mjs
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
  ok('the group', /id: 'isotherm', label: 'Isothermal & Ice'/.test(PAGE));
  ok('the slider column', /isotherm: \[0, -5, -10, -15, -20\]/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in this test', !readFileSync(join(ROOT, 'tools/test-isotherm.mjs'), 'utf8').includes(EM));
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
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
ok('the page boots clean', errs.length === 0, errs[0]);

// No parsing server here: the manifest is set by hand and loading is a no-op.
await p.evaluate(() => {
  window._isoLoads = 0;
  _mrmsLoad = async () => { window._isoLoads++; };
  _mrmsManifest = { products: Object.fromEntries(['refl0c', 'reflm5c', 'reflm10c', 'reflm20c', 'vii', 'composite', 'mesh']
    .map(k => [k, { label: k }])) };
});
const dock = () => p.evaluate(() => {
  const d = document.getElementById('lvl-dock');
  if (!d) return null;
  const c = d.querySelector('.lvl-col[data-layer="isotherm"]');
  return { open: d.classList.contains('open'), iso: c ? { active: (c.querySelector('.lvl-notch.active') || {}).dataset?.lvl,
    notches: [...c.querySelectorAll('.lvl-notch')].map(n => n.dataset.lvl), ft: c.querySelector('.lvl-ft').textContent } : null };
});

console.log('\n2. the group');
{
  const g = await p.evaluate(() => ['refl0c', 'reflm5c', 'reflm10c', 'reflm15c', 'reflm20c', 'vii', 'composite', 'mesh', 'h0c', 'refllowest']
    .map(k => k + ':' + _mrmsGroupOf(k)).join(' '));
  ok('the five slices and VII are Isothermal & Ice',
     /refl0c:isotherm reflm5c:isotherm reflm10c:isotherm reflm15c:isotherm reflm20c:isotherm vii:isotherm/.test(g), g);
  ok('and nothing else moved', /composite:refl mesh:severe h0c:winter refllowest:refl/.test(g), g);
  const info = await p.evaluate(() => ['refl0c', 'reflm5c', 'reflm10c', 'reflm15c', 'reflm20c', 'vii', 'group-isotherm']
    .every(k => !!LAYER_DESCRIPTIONS['mrms-' + k]));
  ok('every one has a description', info);
}

console.log('\n3. the Isotherm column');
{
  await p.evaluate(() => _mrmsToggle('vii'));
  await p.waitForTimeout(900);
  ok('VII alone does not bring the column', !(await dock())?.iso);
  await p.evaluate(() => _mrmsToggle('vii'));
  await p.evaluate(() => _mrmsToggle('reflm10c'));
  await p.waitForTimeout(900);
  let d = await dock();
  ok('a slice brings it, coldest at the top, on -10',
     d && d.open && d.iso && d.iso.notches.join(',') === '-20,-15,-10,-5,0' && d.iso.active === '-10', JSON.stringify(d));
  await p.evaluate(() => document.querySelector('#lvl-dock .lvl-notch[data-layer="isotherm"][data-lvl="-20"]').click());
  await p.waitForTimeout(900);
  let on = await p.evaluate(() => Object.keys(_mrmsOn).filter(k => _mrmsOn[k]).join(','));
  ok('stepping swaps the slice rather than stacking', on === 'reflm20c', on);
  d = await dock();
  ok('the notch moves', d.iso.active === '-20', JSON.stringify(d.iso));
  await p.evaluate(() => document.querySelector('#lvl-dock .lvl-notch[data-layer="isotherm"][data-lvl="0"]').click());
  await p.waitForTimeout(900);
  on = await p.evaluate(() => Object.keys(_mrmsOn).filter(k => _mrmsOn[k]).join(','));
  ok('0 C is the melting top', on === 'refl0c' && (await dock()).iso.ft === 'melting top', on);
  await p.evaluate(() => document.querySelector('#lvl-dock .lvl-notch[data-layer="isotherm"][data-lvl="-15"]').click());
  await p.waitForTimeout(900);
  on = await p.evaluate(() => Object.keys(_mrmsOn).filter(k => _mrmsOn[k]).join(','));
  ok('a slice the server does not build is refused, the old one kept', on === 'refl0c', on);
  await p.evaluate(() => { const m = document.getElementById('mode-modal'); if (m) m.style.display = 'none'; });
  await p.screenshot({ path: process.env.SHOT || '/tmp/isotherm.png' });
  await p.evaluate(() => _mrmsToggle('refl0c'));
  await p.waitForTimeout(900);
  ok('and the column leaves with the last slice', !(await dock())?.open);
  ok('no page errors along the way', errs.length === 0, errs[0]);
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
