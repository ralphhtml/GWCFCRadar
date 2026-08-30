#!/usr/bin/env node
/*
 * The Warm Low preset for Precipitation Total.
 *
 *     node tools/test-precip-preset.mjs
 *
 * Two things make this preset different from the five that were already
 * there, and both are worth holding down.
 *
 * IT IS ANCHORED BY VALUE. The existing presets are lists of colours spread
 * evenly across whatever range the field happens to have, so the same preset
 * paints different numbers on a 0 to 25 chart and a 0 to 50 one. This one
 * names the value each colour sits at, so 6 is magenta wherever it appears
 * and switching models does not mean relearning the map.
 *
 * IT IS SCOPED TO RAIN. A preset built around inches of rain, offered for 500
 * mb heights, is a preset that means nothing, and a picker full of those
 * stops being read at all. The same table feeds the Radar Colors editor, so
 * the filter has to hold there too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? '  <' + x + '>' : '')); } };

const block = (PAGE.match(/const GRAD_PRESETS = \{[\s\S]*?\n\};/) || [''])[0];
const forFn = (PAGE.match(/function _gradPresetsFor\(fieldId\) \{[\s\S]*?\n\}/) || [''])[0];
const PRESETS = new Function(block + '\nreturn GRAD_PRESETS;')();
const presetsFor = new Function(block + '\n' + forFn + '\nreturn _gradPresetsFor;')();

console.log('\n1. the preset itself');
{
  ok('it exists', !!PRESETS.warmlow);
  ok('and says what it is for', PRESETS.warmlow.label === 'Warm Low (Precip)',
     PRESETS.warmlow.label);
  const st = PRESETS.warmlow.stops;
  ok('every stop names a value and a colour',
     st.every(s => typeof s === 'object' && Number.isFinite(s.v)
                && /^#[0-9a-f]{6}$/.test(s.c)), JSON.stringify(st[0]));
  ok('they are in order, low to high',
     st.every((s, i) => i === 0 || s.v > st[i - 1].v));
  ok('starting at zero, so there is no unpainted gap at the bottom',
     st[0].v === 0, String(st[0].v));
  // The colours off the scale this was taken from, at the values they sat at.
  const at = v => (st.find(s => s.v === v) || {}).c;
  ok('2 is the red-orange', at(2) === '#e8442a', at(2));
  ok('6 is the magenta', at(6) === '#c23a9e', at(6));
  ok('10 is the periwinkle', at(10) === '#a8b8ee', at(10));
  ok('14 is the cyan', at(14) === '#35d2e0', at(14));
  ok('18 is the olive', at(18) === '#6b7a5a', at(18));
  // Warm at the light end, cool at the heavy end, which is the whole idea
  // and the opposite of the usual rain ramp.
  const lum = h => 0.2126 * parseInt(h.slice(1, 3), 16)
                 + 0.7152 * parseInt(h.slice(3, 5), 16)
                 + 0.0722 * parseInt(h.slice(5, 7), 16);
  const red = h => parseInt(h.slice(1, 3), 16), blu = h => parseInt(h.slice(5, 7), 16);
  ok('the light end is warm', red(at(2)) > blu(at(2)));
  ok('and the heavy end is cool', blu(at(12)) > red(at(12)));
  ok('and it ends darker than it starts', lum(st[st.length - 1].c) < lum(st[0].c));
}

console.log('\n2. it is offered where it means something, and nowhere else');
{
  ok('offered for Precipitation Total', presetsFor('apcp').includes('warmlow'));
  ok('and for its variants, without listing every one',
     presetsFor('apcp06').includes('warmlow')
     && presetsFor('apcp24').includes('warmlow'));
  for (const f of ['t2m', 'hgt500', 'snowacc', 'pwat', 'gust', 'ref', 'vel']) {
    ok('not offered for ' + f, !presetsFor(f).includes('warmlow'));
  }
  ok('the general presets are still offered everywhere',
     ['classic', 'grayscale', 'contrast', 'colorblind', 'sunset']
       .every(k => presetsFor('t2m').includes(k) && presetsFor('apcp').includes(k)));
  ok('an unknown field still gets the general ones',
     presetsFor('').includes('classic') && !presetsFor('').includes('warmlow'));
}

console.log('\n3. the wiring');
{
  // Built once, the list would be stuck on whichever field was open first.
  ok('the model picker is rebuilt when the field changes',
     /const want = _gradPresetsFor\(_hdUiField\);/.test(PAGE));
  ok('and the radar picker uses the same filter',
     /var want = _gradPresetsFor\(_fxUiFam\);/.test(PAGE));
  ok('neither rebuilds when nothing changed',
     (PAGE.match(/have\.join\(','\) !== want\.join\(','\)/g) || []).length === 2);
  // slice() copies the array but shares the {v, c} objects, so editing a
  // stop afterwards would edit the preset for the rest of the session.
  ok('applying a preset deep copies its stops, in both editors',
     /_hdColors\[_hdUiField\]\.stops = preset\.stops\.map\(/.test(PAGE)
     && /_fxColors\[_fxUiFam\]\.stops = preset\.stops\.map\(function/.test(PAGE));
  ok('and the deep copy keeps legacy plain-string stops working',
     (PAGE.match(/typeof st === 'string'/g) || []).length === 2);
}

console.log('\n4. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-precip-preset.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
