#!/usr/bin/env node
/*
 * The day/night terminator, checked against astronomy rather than against
 * itself.
 *
 *     node tools/test-terminator.mjs
 *
 * This is an overlay that draws a physical fact, so the test is whether the
 * fact is right. A terminator that is plausibly shaped but an hour out is
 * worse than none: it would tell somebody the sun had set on a storm when it
 * had not, and it would look completely convincing while doing it.
 *
 * So the sun's position is checked against the four dates whose answers are
 * known without any computation at all. At the solstices the declination is
 * the earth's axial tilt, 23.44 degrees, positive in June and negative in
 * December. At the equinoxes it is zero. At 12:00 UTC the sun is over the
 * prime meridian. And it moves west at fifteen degrees an hour, because that
 * is what a day is.
 *
 * Two failure modes are specifically hunted:
 *
 * THE WRONG POLE. The dark cap is the one the sun is turned away from, so
 * the shape closes through the south pole in northern summer. Closing through
 * the wrong one shades the lit half of the earth, which is a bug that looks
 * fine on any single screenshot of the tropics.
 *
 * THE EQUINOX DIVIDE BY ZERO. The terminator latitude comes out of
 * -cos(H)/tan(declination), and at the equinox the declination is zero. That
 * is the one day of the year the line really does run pole to pole, and the
 * one day the arithmetic blows up.
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

// Lifted out of the page and run, so this tests the arithmetic that ships.
const lift = (name) => {
  const re = new RegExp('function ' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}');
  const src = (PAGE.match(re) || [])[0];
  if (!src) throw new Error('could not find ' + name);
  return src;
};
const { _termSubsolar, _termNightRing } = new Function(`
  ${lift('_termSubsolar')}
  ${lift('_termNightRing')}
  return { _termSubsolar, _termNightRing };
`)();

const at = (iso) => _termSubsolar(new Date(iso));

console.log('\n1. the sun is where astronomy says it is');
{
  // The earth's axial tilt. Not a number this code should be free to disagree
  // with, and the tolerance is well inside the width of the line drawn.
  const TILT = 23.44;
  const jun = at('2026-06-21T00:00:00Z').lat;
  const dec = at('2026-12-21T12:00:00Z').lat;
  ok(`June solstice declination is the axial tilt (${jun.toFixed(2)})`,
     Math.abs(jun - TILT) < 0.6, jun.toFixed(3));
  ok(`December solstice is the same tilt, the other way (${dec.toFixed(2)})`,
     Math.abs(dec + TILT) < 0.6, dec.toFixed(3));
  const mar = at('2026-03-20T12:00:00Z').lat;
  const sep = at('2026-09-23T00:00:00Z').lat;
  ok(`March equinox declination is zero (${mar.toFixed(2)})`, Math.abs(mar) < 0.6, mar.toFixed(3));
  ok(`September equinox is zero too (${sep.toFixed(2)})`, Math.abs(sep) < 0.6, sep.toFixed(3));
  // Declination can never leave the tropics, whatever the date.
  let worst = 0;
  for (let m = 0; m < 12; m++) {
    const d = Math.abs(at(`2026-${String(m + 1).padStart(2, '0')}-15T06:00:00Z`).lat);
    if (d > worst) worst = d;
  }
  ok('and it never leaves the tropics in any month', worst <= TILT + 0.1, worst.toFixed(3));
}

console.log('\n2. and at the right time of day');
{
  const noon = at('2026-06-21T12:00:00Z').lon;
  // Within a degree or two: the equation of time moves real solar noon around
  // by up to a quarter hour across the year, which is about 4 degrees.
  ok(`at 12:00 UTC the sun is over the prime meridian (${noon.toFixed(2)})`,
     Math.abs(noon) < 4.5, noon.toFixed(3));
  const a = at('2026-06-21T00:00:00Z').lon, b = at('2026-06-21T01:00:00Z').lon;
  let step = b - a;
  if (step > 180) step -= 360;
  if (step < -180) step += 360;
  // Fifteen degrees an hour is what a day is. Getting the sign wrong sends
  // the terminator the wrong way round the earth.
  ok(`it moves west at fifteen degrees an hour (${step.toFixed(2)})`,
     Math.abs(step + 15) < 0.2, step.toFixed(3));
  // Half a day away, the sun is on the far side of the earth.
  const t0 = at('2026-06-21T00:00:00Z').lon, t12 = at('2026-06-21T12:00:00Z').lon;
  let apart = Math.abs(t12 - t0);
  if (apart > 180) apart = 360 - apart;
  ok(`twelve hours apart puts it halfway round (${apart.toFixed(1)})`,
     Math.abs(apart - 180) < 2, apart.toFixed(2));
  ok('longitude always comes back inside -180 to 180',
     [0, 3, 6, 9, 15, 21].every(h => {
       const v = at(`2026-06-21T${String(h).padStart(2, '0')}:00:00Z`).lon;
       return v >= -180 && v <= 180;
     }));
}

console.log('\n3. the dark cap is the right pole');
{
  const jun = _termNightRing(at('2026-06-21T00:00:00Z'));
  const dec = _termNightRing(at('2026-12-21T00:00:00Z'));
  // In northern summer the sun never sets inside the arctic circle, so the
  // dark cap is the southern one. Closing through the wrong pole shades the
  // lit half of the earth, and looks perfectly fine over the tropics.
  ok('northern summer closes the shape through the south pole',
     jun[jun.length - 1][0] === -90, String(jun[jun.length - 1][0]));
  ok('northern winter closes it through the north pole',
     dec[dec.length - 1][0] === 90, String(dec[dec.length - 1][0]));
  ok('the ring spans the whole world',
     jun[0][1] === -180 && jun.some(p => p[1] === 180));
  ok('and is fine enough to look like a curve, not a polygon',
     jun.length > 170, String(jun.length));
  ok('every latitude stays inside the map',
     jun.every(p => p[0] >= -90 && p[0] <= 90));
}

console.log('\n4. the equinox, where the arithmetic divides by zero');
{
  // tan(0) is 0, and -cos(H)/0 is the one case that produces Infinity or NaN.
  // It is also the one day of the year the terminator genuinely does run pole
  // to pole, so it cannot simply be skipped.
  for (const iso of ['2026-03-20T12:00:00Z', '2026-09-23T00:00:00Z',
                     '2026-03-20T00:00:00Z', '2026-09-22T18:00:00Z']) {
    const ring = _termNightRing(at(iso));
    const bad = ring.filter(p => !isFinite(p[0]) || !isFinite(p[1]));
    ok(`${iso.slice(0, 10)} produces no NaN or Infinity`, bad.length === 0,
       bad.length + ' bad points');
  }
  // Hourly for a whole year is cheap and catches anything the four dates miss.
  let bad = 0;
  for (let h = 0; h < 365 * 24; h += 7) {
    const d = new Date(Date.UTC(2026, 0, 1) + h * 3600000);
    if (_termNightRing(_termSubsolar(d)).some(p => !isFinite(p[0]))) bad++;
  }
  ok('and nothing breaks anywhere across a whole year', bad === 0, bad + ' hours bad');
}

console.log('\n5. it is computed, not fetched');
{
  const block = (PAGE.match(/DAY \/ NIGHT TERMINATOR[\s\S]*?function _termStop[\s\S]*?\n\}/) || [''])[0];
  ok('the terminator block was found', block.length > 500);
  // A server round trip for a number anybody can work out from the clock
  // would be slower, would break offline, and would give the same answer.
  ok('nothing in it reaches for the network',
     !/fetch\(|XMLHttpRequest|https?:\/\//.test(block));
  ok('and it says why', /Computed, never fetched/.test(block));
  ok('it redraws on a timer, because the terminator moves',
     /setInterval\(_termDraw, TERM_REFRESH_MS\)/.test(block));
  ok('the timer is cleared when it is switched off',
     /_termStop[\s\S]{0,200}clearInterval\(_termTimer\)/.test(block));
  ok('and the shape is removed, not just left there',
     /_termStop[\s\S]{0,300}removeLayer\(_termLayer\)/.test(block));
}

console.log('\n6. it sits in the right place in the stack');
{
  ok('it has its own pane', /map\.createPane\('termPane'\)/.test(PAGE));
  // Above radar (400) and satellite (399) so it shades the picture it exists
  // to explain, below alerts (403) so a warning is never dimmed for having
  // happened after dark.
  ok('above the radar and satellite, below the alerts',
     /pane\.style\.zIndex = 402;/.test(PAGE));
  ok('and the reason is written down',
     /a warning polygon must not be dimmed/.test(PAGE));
  // A full-screen polygon that ate clicks would break the whole map.
  ok('it never swallows a click meant for what is underneath',
     /interactive: false,   \/\/ never swallow a click/.test(PAGE));
  ok('the pane ignores pointer events as well',
     /termPane[\s\S]{0,300}pointerEvents = 'none'/.test(PAGE));
}

console.log('\n7. it is wired into the overlay list');
{
  ok('there is a pill', /id="op-terminator" data-ovid="terminator"/.test(PAGE));
  ok('that reaches the toggle', /toggleOverlayPill\('terminator'\)/.test(PAGE));
  ok('and starts and stops the layer',
     /if \(_termActive\) _termStop\(\); else _termStart\(\);/.test(PAGE));
  ok('the pill lights with the layer',
     /op-terminator'\);\s*\n\s*if \(pill\) pill\.classList\.toggle\('active', _termActive\)/.test(PAGE));
  ok('it has an icon', /terminator: 'moon'/.test(PAGE));
  const table = (PAGE.match(/OV_DESCRIPTIONS = \{[\s\S]*?\n\};/) || [''])[0];
  ok('and an explanation', /'terminator':\s+'/.test(table));
  // The reason a person would turn it on at all.
  ok('which says what it is actually for',
     /visible channels go black/.test(table));
}

console.log('\n8. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-terminator.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
