#!/usr/bin/env node
/*
 * Right-click > Radar: opens the nearest radar, whatever was on screen.
 *
 *     node tools/test-cm-radar.mjs
 *
 * It passed the product showing straight to the Level 2 decoder, so from the
 * national mosaic or a Normal-menu product (hydro class) it asked for a
 * product no radar volume carries and nothing appeared; and it never set the
 * Level 2 site, so the next product tapped went to another radar.
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

const { chromium } = await import('playwright');
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 1280, height: 860 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
const CL_ID = (PAGE.match(/const APP_CHANGELOG = \[\s*\{ id: '([^']+)'/) || [])[1];
await p.addInitScript(id => { localStorage.setItem('gwcfc_tutorial_seen', '1'); localStorage.setItem('gwcfc_changelog_seen', id); }, CL_ID);
const L = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(L + '/leaflet.js', 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(L + '/leaflet.css', 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);

console.log('\nright-click near KTLX, then Radar, from each kind of picture');
for (const prod of ['radar', 'mrms', 'ref', 'vel', 'hc']) {
  const r = await p.evaluate(async (prod) => {
    const calls = [];
    const orig = loadL3Data;
    loadL3Data = function (a, b2) { calls.push([a, b2]); return Promise.resolve(); };
    currentProduct = prod; _radarSource = 'normal';
    map.setView([35.3, -97.3], 7, { animate: false });
    map.fire('contextmenu', { latlng: L.latLng(35.3, -97.3), containerPoint: L.point(600, 400),
      originalEvent: new MouseEvent('contextmenu', { clientX: 600, clientY: 400 }) });
    await new Promise(r => setTimeout(r, 200));
    const item = [...document.querySelectorAll('#map-ctx-menu .cm-item')].find(x => /Radar:/.test(x.textContent));
    if (item) item.click();
    await new Promise(r => setTimeout(r, 600));
    loadL3Data = orig;
    return { found: !!item, calls, src: _radarSource, l2Site: _l2Site,
             menu: [...document.querySelectorAll('#sub-bubbles .sub-bubble')].map(x => x.id).join(',') };
  }, prod);
  const want = prod === 'vel' ? 'vel' : 'ref';
  ok(`from "${prod}": KTLX opens in Level 2 as ${want}`, r.found && r.calls.length === 1 && r.calls[0][0] === want
     && r.calls[0][1] === 'ktlx' && r.src === 'l2' && r.l2Site === 'ktlx', JSON.stringify(r));
  ok('  with the Level 2 row on screen', /sub-l2-ref/.test(r.menu), r.menu);
}
ok('no page errors', errs.length === 0, errs.join(' | '));
ok('no em dashes', !readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
