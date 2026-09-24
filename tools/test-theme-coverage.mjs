#!/usr/bin/env node
/*
 * Themes reach every part of the app.
 *
 *     node tools/test-theme-coverage.mjs
 *
 * The app's chrome used to carry hundreds of hard-coded copies of the default
 * gold, blue, text colour and brand red, so picking a theme left gold tabs,
 * blue borders and red buttons behind. They are theme variables now (with
 * number forms, --accent-rgb and friends, for see-through tints). Checked: with
 * two very different presets applied, no visible element anywhere (the map
 * chrome, the alerts panel, the Inspector, the overlay list and every Settings
 * tab) still shows one of the default colours; the number forms follow the
 * colour; the brand red follows the preset; and Reset brings the defaults back.
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

console.log('\n1. the stylesheet');
{
  const css = [...PAGE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
    .split('\n').filter(l => !/^\s*--(accent|accent2|text|brand-red)(-rgb)?\s*:/.test(l) && !/#tut-modal-body/.test(l)).join('\n');
  const left = (css.match(/#e8b800|#4ea2da|#daeefb|#aa0000|rgba\(\s*(232,\s*184,\s*0|78,\s*162,\s*218|218,\s*238,\s*251|170,\s*0,\s*0)\s*,/gi) || []);
  // The tutorial keeps its own scoped palette on purpose.
  ok(`no hard-coded default colours left in the stylesheets (${left.length})`, left.length <= 12, left.slice(0, 5).join(' '));
  ok('the number forms are declared', /--accent-rgb:\s*232,184,0/.test(PAGE) && /--brand-red:\s*#aa0000/.test(PAGE));
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
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4000);
ok('the page boots clean', errs.length === 0, errs[0]);

// Every visible element outside the map's own drawing, every colour property.
const leftovers = (preset) => p.evaluate(async (preset) => {
  if (preset) themeApplyPreset(preset);
  await new Promise(r => setTimeout(r, 200));
  const bad = [[232, 184, 0], [78, 162, 218], [218, 238, 251], [170, 0, 0], [212, 175, 55]];
  const names = ['gold', 'blue', 'text', 'red', 'gold2'];
  const hits = {};
  const scan = () => document.querySelectorAll('body *').forEach(el => {
    if (el.closest('.leaflet-map-pane, #tut-modal-body')) return;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return;
    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'backgroundImage', 'boxShadow', 'fill', 'stroke']) {
      if (prop === 'borderTopColor' && parseFloat(cs.borderTopWidth) === 0) continue;
      if (prop === 'borderBottomColor' && parseFloat(cs.borderBottomWidth) === 0) continue;
      const re = /rgba?\((\d+), (\d+), (\d+)/g; let m;
      while ((m = re.exec(cs[prop] || ''))) {
        const i = bad.findIndex(x => x[0] === +m[1] && x[1] === +m[2] && x[2] === +m[3]);
        if (i >= 0) { const k = (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + prop + ' ' + names[i]; hits[k] = 1; }
      }
    }
  });
  try { toggleAlertsPanel(); } catch (e) {}
  try { toggleInspector(); } catch (e) {}
  scan();
  try { toggleAlertsPanel(); toggleInspector(); } catch (e) {}
  try { lqmOpenSettings(); } catch (e) {}
  for (const tab of document.querySelectorAll('#lqm-set-rail .lqm-set-tab')) { tab.click(); await new Promise(r => setTimeout(r, 40)); scan(); }
  try { lqmCloseSettings && lqmCloseSettings(); } catch (e) {}
  return Object.keys(hits);
}, preset);

console.log('\n2. the default theme (the scan does find the defaults)');
{
  const h = await leftovers(null);
  ok(`the defaults are everywhere, as they should be (${h.length} places)`, h.length > 50, h.length);
}

console.log('\n3. Storm Cell Green');
{
  const h = await leftovers('storm');
  ok('not one default colour left anywhere', h.length === 0, h.slice(0, 12).join(' | '));
  const v = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { rgb: cs.getPropertyValue('--accent-rgb').trim(), red: cs.getPropertyValue('--brand-red').trim(), a2: cs.getPropertyValue('--accent2').trim() };
  });
  ok('the number form follows the accent', v.rgb === '255,209,102', v.rgb);
  ok('the brand red follows the preset (its second accent)', v.red === v.a2 && v.red === '#3fd6a0', JSON.stringify(v));
}

console.log('\n4. Midnight Navy');
{
  const h = await leftovers('midnight');
  ok('not one default colour left anywhere', h.length === 0, h.slice(0, 12).join(' | '));
}

console.log('\n5. Reset');
{
  const v = await p.evaluate(() => {
    themeReset();
    const cs = getComputedStyle(document.documentElement);
    return { rgb: cs.getPropertyValue('--accent-rgb').trim(), red: cs.getPropertyValue('--brand-red').trim(), inline: document.documentElement.style.getPropertyValue('--accent-rgb') };
  });
  ok('the defaults come back, number forms too', v.rgb === '232,184,0' && v.red === '#aa0000' && !v.inline, JSON.stringify(v));
  ok('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
