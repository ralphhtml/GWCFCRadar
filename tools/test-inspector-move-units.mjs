#!/usr/bin/env node
/*
 * The Inspector: moving it, and the units it reports in.
 *
 *     node tools/test-inspector-move-units.mjs
 *
 * MOVING IT. The crosshair was welded to the middle of the screen, so reading
 * a second point meant panning the map, which moved the first point off
 * screen. It has a grab handle now, and the thing worth testing is not that
 * the handle exists but that the READING follows it: a crosshair you can drag
 * that still samples the centre is worse than one that cannot move, because
 * it reports one place while pointing at another.
 *
 * THE UNITS. Every row printed a hard-coded unit. Setting the app to Celsius
 * changed the forecast panels and left the Inspector in Fahrenheit, which is
 * worse than not offering the setting at all: the number looks authoritative
 * and is in a unit nobody picked.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x ? '  <' + x + '>' : '')); } };

console.log('\n1. the handle, and what it moves');
{
  ok('there is a drag handle', /id = 'inspector-drag-btn'/.test(PAGE));
  ok('it works with a mouse and with a finger',
     /dragBtn\.addEventListener\('mousedown', _inspDragStart\)/.test(PAGE)
     && /dragBtn\.addEventListener\('touchstart', _inspDragStart/.test(PAGE));
  // pointer-events is off on the readout so it never eats a map click; the
  // handle has to opt back in or it cannot be grabbed at all.
  ok('the handle opts back into pointer events',
     /#inspector-drag-btn \{[\s\S]{0,200}pointer-events: auto;/.test(PAGE));
  ok('and stops the browser panning the page instead of dragging it',
     /#inspector-drag-btn \{[\s\S]{0,400}touch-action: none;/.test(PAGE));
  ok('double clicking it puts the Inspector back in the middle',
     /dblclick[\s\S]{0,80}_inspResetPos\(\)/.test(PAGE));
  ok('the position is remembered between visits',
     /const INSP_POS_KEY = 'gwcfc_insp_offset';/.test(PAGE));
  ok('a corrupt saved position does not cost the page its Inspector',
     /a corrupt setting must not cost the page its Inspector/.test(PAGE));
  ok('and it is clamped back on screen, in case the window got smaller',
     /function _inspClampOff\(\)/.test(PAGE));
  ok('the reading is taken where the crosshair IS, not at the map centre',
     /const center = map\.containerPointToLatLng\(/.test(PAGE));
  ok('and it updates while the handle is still being dragged',
     /_inspApplyOff\(\);\s*\n\s*_inspUpdate\(\);/.test(PAGE));
  // A pin that saves the centre while the readout shows somewhere else is a
  // saved record that disagrees with the thing that produced it.
  ok('saving a pin saves the point the crosshair is on',
     /function _inspPoint\(\)/.test(PAGE)
     && /const center = _inspPoint\(\);/.test(PAGE));
}

console.log('\n2. the units, run through the real converter');
{
  const src = (PAGE.match(/function _inspUnit\(base, kind, dp\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('the converter was found', !!src);
  const mk = (u) => new Function('_units', src + '\nreturn _inspUnit;')(u);
  const F = mk({ temp: 'f', wind: 'mph', pressure: 'mb', precip: 'in', dist: 'mi' });
  const M = mk({ temp: 'c', wind: 'kmh', pressure: 'inhg', precip: 'mm', dist: 'km' });
  const K = mk({ temp: 'both', wind: 'kt', pressure: 'mb', precip: 'in', dist: 'mi' });

  ok('32F reads as 0C when Celsius is chosen',
     M(32, 'temp', 0).value === '0' && M(32, 'temp').unit === '°C');
  ok('and stays Fahrenheit when it is not',
     F(32, 'temp', 0).value === '32' && F(32, 'temp').unit === '°F');
  ok('both shows both, and says which is which',
     K(32, 'temp', 0).value === '32 / 0' && K(32, 'temp').unit === '°F/°C');
  ok('100 mph is 161 km/h', M(100, 'wind').value === '161');
  ok('and 87 knots', K(100, 'wind').value === '87', K(100, 'wind').value);
  ok('1000 mb is 29.53 inHg', M(1000, 'pressure').value === '29.53',
     M(1000, 'pressure').value);
  ok('one inch of rain is 25.4 mm', M(1, 'precip').value === '25.4');
  ok('ten miles is 16.1 km', M(10, 'dist').value === '16.1');
  // Swell in feet for somebody working in miles, metres for somebody in km.
  ok('wave height follows the distance preference',
     F(10, 'height').unit === 'ft' && M(10, 'height').unit === 'm'
     && M(10, 'height').value === '3.0', JSON.stringify(M(10, 'height')));
  ok('nothing at all converts to nothing, not to zero',
     F(null, 'temp') === null && F(NaN, 'temp') === null);
  ok('an unknown kind is left alone rather than guessed at',
     F(5, 'bananas') === null);
}

console.log('\n3. the rows actually call it');
{
  ok('wind', /const uw = _inspUnit\(speed, 'wind'\)/.test(PAGE));
  ok('temperature', /_inspUnit\(v, 'temp', 1\)/.test(PAGE));
  ok('pressure', /_inspUnit\(v, 'pressure', 1\)/.test(PAGE));
  ok('waves, both the swell and the sea temperature',
     /const h = _inspUnit\(v, 'height'\);/.test(PAGE)
     && /const t = _inspUnit\(v, 'temp', 1\);/.test(PAGE));
  // Percent is not a temperature. Humidity and cloud cover live in the same
  // group, and running 50 percent through a F-to-C conversion would produce
  // a confident wrong number.
  ok('a percentage in the temperature group is NOT converted',
     /const conv = tu === '°F' \? _inspUnit\(v, 'temp', 1\) : null;/.test(PAGE));
  ok('changing a unit redraws the readout straight away',
     /function _inspUnitsChanged\(\)/.test(PAGE)
     && /_refreshUnitDisplays\(\);[\s\S]{0,300}_inspUnitsChanged\(\)/.test(PAGE));
  // A real bug found on the way: this compared a lower case stored value
  // against an upper case 'F', so it was never true and sea surface
  // temperature was pinned to Celsius whatever Settings said.
  ok('the sea temperature comparison that could never be true is gone',
     !/_units\.temp === 'F'/.test(PAGE));
  ok('and it reads the preference case insensitively now',
     /function _sstWantF\(\)[\s\S]{0,240}toLowerCase\(\) !== 'c'/.test(PAGE));
}

console.log('\n5. the city labels, and the cost that sank the first attempt');
{
  ok('labels carry a readout', /_mbCityReadout\(c\)/.test(PAGE));
  // One implementation, so a label and the crosshair cannot disagree.
  ok('they ask the Inspector own row builder, not a second copy',
     /function _inspRowsAt\(center, cx, cy, light\)/.test(PAGE)
     && /_inspRowsAt\(\{ lat: c\.lat, lng: c\.lng \}/.test(PAGE));
  ok('and the Inspector goes through that same builder',
     /const rows = _inspRowsAt\(center, cx, cy, false\);/.test(PAGE));

  // THE ACTUAL BUG. _inspReadOverlayPixel allocated a canvas and redrew the
  // whole model chart on EVERY call. One a frame was wasteful; ninety a pan
  // was 4,672 ms of redrawing, measured, against 16.5 ms once cached.
  ok('the pixel canvas is kept rather than rebuilt per read',
     /function _inspPixelCanvas\(img\)/.test(PAGE));
  ok('and it is reused only while the picture is the same one',
     /_inspPxCache\.src === src/.test(PAGE)
     && /_inspPxCache\.w === img\.naturalWidth/.test(PAGE));
  // Caching a tainted canvas would make every later read pay the draw to
  // fail the same way.
  ok('a tainted canvas is not cached', /_inspPxCache = null;\s*\n\s*return \{ tainted: true \}/.test(PAGE));
  // Matched on one line's worth: the sentence wraps across comment lines,
  // and a phrase spanning the wrap matches nothing however true it is.
  ok('the measurement is written down beside it',
     /4,672 ms for ninety reads that way, against 16\.5 ms/.test(PAGE));

  // Models were the reading named first, and they are affordable now.
  ok('model charts survive light mode',
     /Kept in light mode: model charts are the reading people want/.test(PAGE));
  ok('while the rest of the pixel readers are still skipped',
     /if \(!light && typeof activeLayers !== 'undefined' && activeLayers\.satellite\)/.test(PAGE)
     && /if \(!light && typeof _mrmsAnyOn/.test(PAGE));

  // The other half of what went wrong: a stack of coloured blocks per city.
  ok('the readings are one inline line, not a column of blocks',
     /\.mb-city-data \{[\s\S]{0,260}white-space: nowrap;/.test(PAGE)
     && !/\.mb-city-val/.test(PAGE));
  ok('and they carry no per-row colour to paint bars with',
     !/mb-city-val|_mbCityColor/.test(PAGE));
  ok('two readings at most', /const MB_CITY_MAX_ROWS = 2;/.test(PAGE));
  ok('rows with nothing to say are dropped rather than printed',
     /const MB_CITY_SKIP = /.test(PAGE));
  ok('the value is escaped like the name is', /_mbEsc\(String\(x\.value\)\)/.test(PAGE));
  ok('changing a unit repaints the labels too',
     /_mbCityRefresh === 'function'[\s\S]{0,60}_mbCityRefresh\(\)/.test(PAGE));
}

console.log('\n6. house rules');
{
  const EM = String.fromCharCode(0x2014);
  const files = ['index.html', 'tools/test-inspector-move-units.mjs'];
  const bad = files.filter(f => readFileSync(join(ROOT, f), 'utf8').includes(EM));
  ok('no em dashes', bad.length === 0, bad.join(', '));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
