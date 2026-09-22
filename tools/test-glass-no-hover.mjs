#!/usr/bin/env node
/*
 * A PS5, or any other device driven by a controller or a touch screen
 * rather than a mouse, already has an `@media (hover: none)` rule near the
 * top of the page that strips every backdrop-filter blur outright - the
 * single biggest GPU cost on those platforms. But it is a plain `*`
 * selector, and every heavy-frost popup or panel since (alerts, EAS, the
 * outlook legends, the NWR popup, the loading screen's own fact card) sets
 * its own backdrop-filter with a higher-specificity selector plus
 * `!important`, which wins the cascade over that plain rule regardless of
 * source order - so each one quietly punched a hole back through the kill
 * switch. This checks glass is refused at the one place all of them read
 * from ([data-glass] on <html>) instead, so nothing has to re-win that
 * fight rule by rule.
 *
 *     node tools/test-glass-no-hover.mjs
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

console.log('\n1. the gate is in the page');
{
  ok('a hover-hover check decides whether glass may run at all',
     /function _glassAllowed\(\) \{\s*\n\s*try \{ return matchMedia\('\(hover: hover\)'\)\.matches; \} catch \(e\) \{ return true; \}/.test(PAGE));
  ok('_glassSync reads _glassLevel through that gate',
     /const lvl = _glassAllowed\(\) \? window\._glassLevel : null;/.test(PAGE));
  ok('the first-paint attribute write is gated too, or the blur would flash on for one frame',
     /if \(window\._glassLevel && _glassAllowed\(\)\) \{\s*\n\s*document\.documentElement\.setAttribute\('data-glass', window\._glassLevel\);/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-glass-no-hover.mjs'), 'utf8').includes(EM));
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

async function boot(hasTouch) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 800 }, hasTouch });
  const p = await ctx.newPage();
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
  await p.waitForTimeout(4200);
  const r = await p.evaluate(async () => {
    const out = {};
    out.hoverNone = matchMedia('(hover: none)').matches;
    out.dataGlassAttr = document.documentElement.getAttribute('data-glass');
    // A real alert popup, the exact surface the report keeps landing on.
    try {
      if (typeof _buildAlertPopupHTML === 'function') {
        const html = _buildAlertPopupHTML({
          event: 'Tornado Warning', headline: 'x', description: 'x',
          instruction: '', ends: null, onset: null, areaDesc: 'Testville',
        }, '#ff0000');
        L.popup({ className: 'ap-popup-container' }).setLatLng(map.getCenter())
          .setContent(html).openOn(map);
      }
    } catch (e) {}
    await new Promise(res => setTimeout(res, 200));
    const wrap = document.querySelector('.ap-popup-container .leaflet-popup-content-wrapper');
    out.popupBlur = wrap ? (getComputedStyle(wrap).backdropFilter || 'none') : 'not found';
    // The loading screen's fact card, checked directly since the real one
    // is long gone by the time the app has booted.
    const fc = document.createElement('div');
    fc.className = 'load-fact-wrap';
    document.body.appendChild(fc);
    out.factCardBlur = getComputedStyle(fc).backdropFilter || 'none';
    fc.remove();
    return out;
  });
  await p.close();
  await ctx.close();
  return { r, errs };
}

console.log('\n2. glass is fully off on a no-hover device (PS5, touch)');
{
  const { r, errs } = await boot(true);
  ok('the device really does report no hover, or this run proves nothing',
     r.hoverNone === true, JSON.stringify(r));
  ok('no [data-glass] attribute landed on <html> at all',
     r.dataGlassAttr === null, r.dataGlassAttr);
  ok('a real alert popup carries no backdrop blur',
     r.popupBlur === 'none', r.popupBlur);
  ok('the loading screen fact card carries no backdrop blur either',
     r.factCardBlur === 'none', r.factCardBlur);
  ok('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

console.log('\n3. glass still works normally on a mouse-driven browser');
{
  const { r, errs } = await boot(false);
  ok('this device reports hover the ordinary way',
     r.hoverNone === false, JSON.stringify(r));
  ok('the default subtle level is on', r.dataGlassAttr === 'subtle', r.dataGlassAttr);
  ok('the alert popup carries its heavy blur', r.popupBlur.includes('blur'), r.popupBlur);
  ok('and so does the fact card', r.factCardBlur.includes('blur'), r.factCardBlur);
  ok('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
