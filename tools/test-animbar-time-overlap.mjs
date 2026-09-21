#!/usr/bin/env node
/*
 * The animation bar's clock never crowds its tick labels into looking like
 * overlapping text.
 *
 *     node tools/test-animbar-time-overlap.mjs
 *
 * History: #anim-time-display ("01:40 PM EDT MON") used to sit beside the
 * timeline in #animbar's own flex row, and on narrow phones it squeezed the
 * track's tick labels into a jumble. The first fix hid it at the narrowest
 * breakpoint and clipped it with an ellipsis elsewhere.
 *
 * The clock has since moved OUT of the row entirely: the stamp chip
 * (#anim-stamp) sits centred ABOVE the bar, absolutely positioned, so it
 * competes with nothing in the row at any width. The old pill stays in the
 * DOM (the timezone machinery reads it, and it is the chip's data heartbeat)
 * but never renders. What this suite now holds:
 *   - the pill is display:none at every width
 *   - the chip exists, renders above the bar, in Comfortaa
 *   - the chip carries the valid moment in z time plus an Updated line
 *   - scrubbing moves the chip's time
 *   - the timeline keeps real width on the narrowest phones
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

console.log('\n1. the replacement is in the page');
{
  ok('the old pill is retired at every width, not just the narrowest',
     /#anim-time-display \{ display: none !important; \}/.test(PAGE));
  ok('the stamp chip exists and is welded to the bar top like a browser tab',
     /id="anim-stamp"/.test(PAGE)
     && /#anim-stamp \{[\s\S]{0,700}?bottom: 100%;/.test(PAGE)
     && /#anim-stamp::before,/.test(PAGE)
     && /radial-gradient\(circle at 0 0,/.test(PAGE));
  ok('and it is set in Comfortaa',
     /#anim-stamp \{[\s\S]{0,700}?font-family: 'Comfortaa', sans-serif;/.test(PAGE));
  ok('the chip reads every playback source through one cascade',
     /_stampState/.test(PAGE) && /_stampRefresh/.test(PAGE)
     && /new MutationObserver\(kick\)/.test(PAGE));
  ok('the timezone hold moved with the clock',
     /_tzAnchorEl/.test(PAGE)
     && /\[el, document\.getElementById\('anim-stamp'\)\]/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here or in the page',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-animbar-time-overlap.mjs'), 'utf8').includes(EM));
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
const errs = [];

async function boot(width) {
  const p = await b.newPage({ viewport: { width, height: 740 } });
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
  await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4200);
  await p.evaluate(() => {
    document.getElementById('animbar').style.display = 'flex';
    document.getElementById('timeline-labels').innerHTML =
      '<span>09:41</span><span>10:25</span><span>11:48</span>';
  });
  return p;
}

console.log('\n2. the narrowest phones: nothing competes with the track');
{
  const p = await boot(360);
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(() => {
    const pill = document.getElementById('anim-time-display');
    const wrap = document.getElementById('timeline-wrap');
    const chip = document.getElementById('anim-stamp');
    const bar = document.getElementById('animbar');
    const cr = chip.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    return {
      pillDisplay: getComputedStyle(pill).display,
      wrapWidth: wrap.getBoundingClientRect().width,
      chipShown: getComputedStyle(chip).display !== 'none' && cr.width > 0,
      // The chip overlaps the bar's top edge on purpose: that shared edge
      // is what welds the two into one tab-and-strip shape. Its bottom
      // lands 6px in (the 3px weld measured from the padding box, which
      // sits inside the 3px border), so anything within 7px is the weld
      // and anything deeper would be the chip drowning in the bar.
      chipAboveBar: cr.bottom <= br.top + 7,
      chipFont: getComputedStyle(chip).fontFamily,
    };
  });
  ok('the clock pill does not render at all', r.pillDisplay === 'none', JSON.stringify(r));
  // The row has grown buttons since the 100px day (zoom step, fullscreen,
  // frame steps), and 96px is what a 360px phone honestly leaves the track
  // now, measured identically on main before the chip existed. The guard
  // is against the squeeze-toward-zero that caused the original jumble,
  // not against the row having controls.
  ok('the timeline keeps real width with nothing beside it',
     r.wrapWidth > 80, JSON.stringify(r));
  ok('the stamp chip renders, grown out of the bar top, out of the row',
     r.chipShown && r.chipAboveBar, JSON.stringify(r));
  ok('and it is drawn in Comfortaa', /Comfortaa/.test(r.chipFont), r.chipFont);
  await p.close();
}

console.log('\n3. the chip carries the stamp, and scrubbing moves it');
{
  const p = await boot(900);
  const r = await p.evaluate(async () => {
    const main = document.getElementById('anim-stamp-main');
    const sub = document.getElementById('anim-stamp-sub');
    const before = main.textContent;
    seekFrame(1);
    await new Promise(res => setTimeout(res, 400));
    const after = main.textContent;
    return { before, after, sub: sub.textContent,
             zform: /^\w{3} \d{2}\/\d{2}\/\d{2} \d{2}:\d{2}z$/.test(after) };
  });
  ok('the top line is the valid moment, stamped in z time',
     r.zform, r.after);
  ok('the bottom line says when the data arrived',
     /^Updated: \d{1,2}:\d{2} (AM|PM)$/.test(r.sub), r.sub);
  ok('scrubbing moves the stamp', r.before !== r.after,
     r.before + ' -> ' + r.after);
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
  await p.close();
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
