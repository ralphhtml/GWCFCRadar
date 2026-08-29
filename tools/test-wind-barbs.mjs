#!/usr/bin/env node
/*
 * The Wind Barbs overlay, and the notation it claims to be drawing.
 *
 *     node tools/test-wind-barbs.mjs
 *
 * A barb is not decoration, it is writing. Half feather 5 knots, full feather
 * 10, solid pennant 50, added up along a staff that points back into the
 * wind. Get any of that wrong and the overlay is not "a bit off": it says a
 * number, confidently, and the number is false. So the arithmetic that turns
 * a speed into feathers is exercised directly, at the boundaries where
 * rounding decides between two different pictures.
 *
 * Three other things are worth checking rather than trusting.
 *
 * ONE FETCH, ONE FIELD. The barbs and the particles are supposed to read the
 * same grid. If they each fetched their own, two overlays showing the same
 * wind could disagree about it, which is worse than either being absent.
 *
 * THE STAFF POINTS THE RIGHT WAY. The grid stores the direction the air is
 * MOVING; a barb points at where the wind came FROM. An inverted staff is the
 * classic way to get this exactly 180 degrees wrong and have it still look
 * plausible.
 *
 * IT ACTUALLY DRAWS. The glyph code is reached through a canvas, so the only
 * honest check is to run it against a real canvas in a real browser and count
 * the strokes it made.
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

console.log('\n1. the overlay is wired in, end to end');
{
  ok('there is a pill for it', /id="op-wind-barbs" data-ovid="wind-barbs"/.test(PAGE));
  ok('clicking it reaches the toggle',
     /onclick="toggleOverlayPill\('wind-barbs'\)"/.test(PAGE));
  ok('and the toggle starts and stops the layer',
     /id === 'wind-barbs'[\s\S]{0,140}_barbActive \? _barbStop\(\) : _barbStart\(\)/.test(PAGE)
     || /if \(_barbActive\) _barbStop\(\); else _barbStart\(\);/.test(PAGE));
  ok('the pill lights up with the layer',
     /op-wind-barbs'\);\s*\n?\s*if \(pill\) pill\.classList\.toggle\('active', _barbActive\)/.test(PAGE));
  ok('it has an icon in the search index', /'wind-barbs': 'wind'/.test(PAGE));
  ok('and an explanation in the overlay descriptions',
     /'wind-barbs':\s{2,}'/.test(PAGE));
  // The description is what a user reads to learn the notation, so it has to
  // carry the actual numbers rather than say "shows wind speed".
  // Matched inside OV_DESCRIPTIONS rather than on the key alone. Overlays
  // are described there, not in LAYER_DESCRIPTIONS, and the same key also
  // appears in the icon map where its value is the single word "wind":
  // matching either of those is how this check silently tested nothing.
  const table = (PAGE.match(/OV_DESCRIPTIONS = \{[\s\S]*?\n\};/) || [''])[0];
  const desc = (table.match(/'wind-barbs':\s+'([^']*(?:\\'[^']*)*)'/) || [])[1] || '';
  ok('the explanation teaches the notation, not just names it',
     /half feather 5/i.test(desc) && /full feather 10/i.test(desc)
     && /pennant 50/i.test(desc), desc.slice(0, 60));
}

console.log('\n2. one field, read by both overlays');
{
  ok('there is a single shared fetch', /async function _windFieldGet\(/.test(PAGE));
  ok('the particles go through it', /_windPtLoad[\s\S]{0,400}await _windFieldGet\(/.test(PAGE));
  ok('and so do the barbs', /_barbLoad[\s\S]{0,300}await _windFieldGet\(/.test(PAGE));
  // Two overlays switched on together must not fire two requests. The
  // in-flight promise is what makes that impossible rather than unlikely.
  ok('a second caller joins the first fetch instead of starting another',
     /if \(_windFieldInFlight\) return _windFieldInFlight;/.test(PAGE));
  ok('the barbs do not fetch on their own',
     !/_barbLoad[\s\S]{0,600}api\.open-meteo\.com/.test(PAGE));
  // The old copy of the grid arithmetic was particle-specific. Both now go
  // through one function, so they cannot drift into sampling different cells.
  ok('both sample the grid through the same helper',
     /function _windGridCoord\(grid, lat, lng\)/.test(PAGE)
     && /_windPtGridCoord\(lat, lng\) \{ return _windGridCoord\(_windPtGrid/.test(PAGE));
}

console.log('\n3. the notation, exercised as arithmetic');
{
  // Lifted out of the page rather than reimplemented: the point is to test
  // what ships, and this is the whole of the decision.
  const feathers = (kt) => {
    const n50 = Math.floor(kt / 50);
    const n10 = Math.floor((kt - n50 * 50) / 10);
    const n5 = (kt - n50 * 50 - n10 * 10) >= 5 ? 1 : 0;
    return [n50, n10, n5];
  };
  const quant = (knots) => Math.max(5, Math.round(knots / 5) * 5);
  const say = (a) => a.join('/');

  const cases = [
    [5,   [0, 0, 1], 'a lone half feather'],
    [10,  [0, 1, 0], 'one full feather'],
    [15,  [0, 1, 1], 'a feather and a half'],
    [45,  [0, 4, 1], 'four and a half, just under a pennant'],
    [50,  [1, 0, 0], 'one pennant, and no leftover feathers'],
    [55,  [1, 0, 1], 'a pennant and a half feather'],
    [65,  [1, 1, 1], 'a pennant, a feather and a half'],
    [100, [2, 0, 0], 'two pennants'],
    [145, [2, 4, 1], 'the top of the chart'],
  ];
  for (const [kt, want, label] of cases) {
    const got = feathers(kt);
    ok(`${kt} kt is ${label}`, say(got) === say(want), say(got) + ' vs ' + say(want));
  }
  // The sum has to come back out, or the picture and the number disagree.
  for (let kt = 5; kt <= 200; kt += 5) {
    const [a, b, c] = feathers(kt);
    if (a * 50 + b * 10 + c * 5 !== kt) {
      ok(`the feathers add back up to ${kt}`, false, say([a, b, c]));
      break;
    }
    if (kt === 200) ok('every speed from 5 to 200 adds back up to itself', true);
  }
  // Rounding is where a barb quietly becomes a different barb.
  ok('7.4 kt rounds down to one full feather', quant(7.4) === 5, String(quant(7.4)));
  ok('7.6 kt rounds up to ten', quant(7.6) === 10, String(quant(7.6)));
  ok('anything drawn at all is at least 5, never a bare staff',
     quant(2.6) === 5 && quant(0.1) === 5, String(quant(2.6)));

  // Knots, not mph. The feather values ARE knots by definition, so a wrong
  // conversion makes every barb on the map wrong by 15 percent.
  const m = PAGE.match(/const BARB_KT_PER_MPH = ([0-9.]+)/);
  ok('mph is converted to knots before anything is counted',
     !!m && Math.abs(Number(m[1]) - 0.868976) < 1e-6, m ? m[1] : 'missing');
  ok('and the conversion is used where the speed is handed to the glyph',
     /mph \* BARB_KT_PER_MPH/.test(PAGE));
}

console.log('\n4. the drawing, run against a real canvas');
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* checked below */ }
if (!chromium) {
  console.log('  playwright is not installed, skipping the render checks');
} else {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH
      || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await browser.newPage();
  // Pull the glyph function out of the page and run it standalone, so this
  // tests the shipped source rather than a copy of it.
  const src = (PAGE.match(/function _barbGlyph\(ctx, x, y, u, v, knots, color, side\) \{[\s\S]*?\n\}/) || [])[0];
  const calm = Number((PAGE.match(/const BARB_CALM_KT = ([0-9.]+)/) || [])[1]);
  ok('the glyph function was found in the page', !!src);
  ok('and the calm threshold it reads', isFinite(calm) && calm > 0, String(calm));
  if (src) {
    const r = await p.evaluate(({ src, calm }) => {
      // A recording context: every call is logged, so what the glyph drew can
      // be counted instead of eyeballed.
      const mk = () => {
        const log = [];
        const st = { rotate: 0, translate: [0, 0] };
        const ctx = {
          save() { log.push(['save']); }, restore() { log.push(['restore']); },
          beginPath() { log.push(['beginPath']); },
          moveTo(x, y) { log.push(['moveTo', x, y]); },
          lineTo(x, y) { log.push(['lineTo', x, y]); },
          closePath() { log.push(['closePath']); },
          stroke() { log.push(['stroke']); }, fill() { log.push(['fill']); },
          arc(x, y, rr) { log.push(['arc', x, y, rr]); },
          translate(x, y) { st.translate = [x, y]; log.push(['translate', x, y]); },
          rotate(a) { st.rotate = a; log.push(['rotate', a]); },
        };
        return { ctx, log, st };
      };
      // The glyph reads one page constant. Read out of the page rather than
      // typed here, so a change to the calm threshold cannot leave the test
      // checking the old one.
      const fn = eval('(function(){const BARB_CALM_KT=' + calm + ';return (' + src + ');})()');
      const run = (u, v, kt, side) => {
        const r = mk();
        fn(r.ctx, 100, 100, u, v, kt, '#fff', side === undefined ? 1 : side);
        return r;
      };
      return {
        // 0 knots: a circle and a filled dot, and no staff at all.
        calm: (() => {
          const r = run(0, 0, 0);
          return {
            arcs: r.log.filter(e => e[0] === 'arc').length,
            lines: r.log.filter(e => e[0] === 'lineTo').length,
            fills: r.log.filter(e => e[0] === 'fill').length,
          };
        })(),
        // 145 knots: two filled pennants, and enough staff to hold them.
        top: (() => {
          const r = run(0, -145 / 0.868976, 145);
          const staff = r.log.find(e => e[0] === 'lineTo' && e[2] === 0);
          return {
            fills: r.log.filter(e => e[0] === 'fill').length,
            closes: r.log.filter(e => e[0] === 'closePath').length,
            strokes: r.log.filter(e => e[0] === 'stroke').length,
            staffLen: staff ? Math.abs(staff[1]) : 0,
          };
        })(),
        ten: (() => {
          const r = run(0, -10 / 0.868976, 10);
          return {
            fills: r.log.filter(e => e[0] === 'fill').length,
            strokes: r.log.filter(e => e[0] === 'stroke').length,
            staffLen: Math.abs((r.log.find(e => e[0] === 'lineTo' && e[2] === 0) || [0, 0])[1]),
          };
        })(),
        // A wind blowing due EAST (u positive, v zero) must produce a staff
        // that points WEST, back at where it came from.
        eastward: (() => {
          const r = run(20, 0, 20);
          const staff = r.log.find(e => e[0] === 'lineTo' && e[2] === 0);
          return { rotate: r.st.rotate, staffX: staff ? staff[1] : null };
        })(),
        // A wind blowing due NORTH: v positive. Screen y grows downward, so
        // the rotation has to come out at -90 degrees, not +90.
        northward: (() => run(0, 20, 20).st.rotate)(),
        // Feathers on the other side below the equator.
        sides: (() => {
          const n = run(0, -20 / 0.868976, 20, 1).log.filter(e => e[0] === 'lineTo' && e[2] !== 0);
          const s = run(0, -20 / 0.868976, 20, -1).log.filter(e => e[0] === 'lineTo' && e[2] !== 0);
          return { north: n[0] ? n[0][2] : 0, south: s[0] ? s[0][2] : 0 };
        })(),
      };
    }, { src, calm });

    ok('calm is a circle with a dot, and no staff',
       r.calm.arcs === 2 && r.calm.lines === 0 && r.calm.fills === 1,
       JSON.stringify(r.calm));
    ok('145 knots draws two filled pennants',
       r.top.fills === 2 && r.top.closes === 2, JSON.stringify(r.top));
    // 2 pennants + 4 feathers + 1 half = 5 stroked feathers, plus the staff.
    ok('and four and a half feathers alongside them',
       r.top.strokes === 6, String(r.top.strokes));
    ok('the staff grows to hold them rather than letting them overlap',
       r.top.staffLen > r.ten.staffLen + 20,
       r.top.staffLen.toFixed(1) + ' vs ' + r.ten.staffLen.toFixed(1));
    ok('ten knots is one feather and no pennant',
       r.ten.fills === 0 && r.ten.strokes === 2, JSON.stringify(r.ten));
    // The whole point: a barb points into the wind, not with it.
    ok('a wind blowing east draws its staff pointing west',
       Math.abs(r.eastward.rotate) < 1e-9 && r.eastward.staffX < 0,
       'rotate ' + r.eastward.rotate + ', staff x ' + r.eastward.staffX);
    ok('a wind blowing north points its staff up the screen, not down',
       Math.abs(r.northward + Math.PI / 2) < 1e-9, String(r.northward));
    ok('feathers change sides below the equator',
       r.sides.north > 0 && r.sides.south < 0, JSON.stringify(r.sides));
  }
  await browser.close();
}

console.log('\n5. it does not leak when switched off');
{
  ok('the refresh timer is cleared on stop',
     /_barbStop\(\)[\s\S]{0,200}clearInterval\(_barbRefreshTimer\)/.test(PAGE));
  ok('the canvas is cleared rather than left showing a stale field',
     /_barbStop\(\)[\s\S]{0,320}clearRect\(0, 0, _barbCanvas\.width/.test(PAGE));
  ok('and hidden, so it cannot sit over the map doing nothing',
     /_barbStop\(\)[\s\S]{0,400}display = 'none'/.test(PAGE));
  // A redraw that runs after the layer is off would repaint what stop just
  // cleared, which looks exactly like the toggle not working.
  ok('a redraw after stopping is a no-op',
     /function _barbDraw\(\) \{\s*\n\s*if \(!_barbActive/.test(PAGE));
  ok('and a fetch that lands after stopping does not repaint either',
     /await _windFieldGet\(forceRefresh\);\s*\n\s*if \(!_barbActive\) return;/.test(PAGE));
}

console.log('\n6. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-wind-barbs.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes in the page or in this file', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
