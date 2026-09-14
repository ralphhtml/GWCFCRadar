#!/usr/bin/env node
/*
 * The animation bar's clock pill never crowds its tick labels into looking
 * like overlapping text.
 *
 *     node tools/test-animbar-time-overlap.mjs
 *
 * #anim-time-display ("01:40 PM EDT MON") sits beside the timeline in
 * #animbar's own flex row. On a phone narrow enough that #speed-wrap is
 * already hidden, there was not enough width left for the pill AND a
 * legible track, so the track's own flex:1 got squeezed down toward
 * nothing, and the tick labels under it ("09:41 ... 11:48") ended up
 * crammed right against the pill's text - reading, on screen, as one run
 * of overlapping, jumbled characters.
 *
 * Two things fix it: at that narrowest breakpoint the pill is simply
 * hidden now, the same trade already made for the speed control there (the
 * time is still readable off the tick labels, and the hold-to-change-
 * timezone gesture it also offered has a full equivalent in
 * Settings -> Timezone). At the wider phone widths where it stays visible,
 * a plain div would otherwise wrap onto a second line and spill out the
 * bottom of its own fixed-height box the moment it runs out of room, so it
 * is clipped to one line with an ellipsis instead - a safety net for
 * whatever squeeze is left once the pill is not the one thing giving way.
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

console.log('\n1. the two fixes are in the page');
{
  ok('the pill cannot wrap onto a second line or overflow its own box',
     /#anim-time-display \{[\s\S]{0,1400}?white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/.test(PAGE));
  ok('and on the narrowest phones it steps aside entirely, the same trade already made for the speed control',
     /#speed-wrap \{ display: none; \}[\s\S]{0,900}?#anim-time-display \{ display: none; \}/.test(PAGE));
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

console.log('\n2. the narrowest phones: the pill steps aside, the track gets its room back');
{
  const p = await boot(360);   // well inside the <=480px breakpoint, same as the screenshot this fixes
  ok('the page boots clean', errs.length === 0, errs[0]);
  const r = await p.evaluate(() => {
    const pill = document.getElementById('anim-time-display');
    const wrap = document.getElementById('timeline-wrap');
    return {
      pillDisplay: getComputedStyle(pill).display,
      wrapWidth: wrap.getBoundingClientRect().width,
    };
  });
  ok('the clock pill does not render at all here', r.pillDisplay === 'none', JSON.stringify(r));
  // With the pill out of the row, the track is the only flexible child left
  // and should get real width back rather than being squeezed toward zero -
  // the actual mechanism behind the crowding in the screenshot.
  ok('and the timeline, freed of competing with it, has real width to work with',
     r.wrapWidth > 100, JSON.stringify(r));
  await p.close();
}

console.log('\n3. above 480px the pill stays visible, and the ellipsis backstop actually clips rather than wraps');
{
  const p = await boot(490);   // just above the 480px breakpoint: the pill stays visible
  const r = await p.evaluate(() => {
    const el = document.getElementById('anim-time-display');
    return { display: getComputedStyle(el).display };
  });
  ok('the pill is shown here, unlike the narrowest phones', r.display !== 'none', JSON.stringify(r));

  // #anim-time-display never shrinks itself below its own content width
  // (flex-shrink: 0, unchanged by this fix) - real squeeze here falls on
  // #timeline-wrap beside it instead, which is the point of hiding the
  // pill entirely one breakpoint down. What the ellipsis rule guards is a
  // narrower case: whatever the reason the box ends up tighter than its
  // text one day (a longer localised time string, a future style tweak),
  // it clips instead of spilling a second line out the bottom - checked
  // directly here by forcing that width, rather than by hoping today's
  // flex arithmetic happens to produce it.
  const forced = await p.evaluate(() => {
    const el = document.getElementById('anim-time-display');
    el.textContent = '01:40 PM EDT MONDAY, SEPTEMBER';
    el.style.width = '60px';
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height,
             overflowing: el.scrollWidth > el.clientWidth };
  });
  ok('forced narrow, there really is more text than room for it',
     forced.overflowing, JSON.stringify(forced));
  ok('and it still stays exactly one line tall - clipped with an ellipsis, not wrapped',
     forced.height > 0 && forced.height < 34, JSON.stringify(forced));
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
  await p.close();
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
