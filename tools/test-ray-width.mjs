#!/usr/bin/env node
/*
 * Every radar beam is drawn as wide as it really is.
 *
 *     node tools/test-ray-width.mjs
 *
 * A tester's screenshot: a terminal radar (TBOS) solid close in and striped
 * further out, a dark gap beside every beam. The decoder drew each radial as
 * wide as the gap to the next one in its list, and when a tilt holds two
 * scans' radials mixed together (the long and short range passes at the same
 * angle), the next one is from the other scan, half a beam over. The radial's
 * own declared width (the ars code in its header) now wins whenever the gap
 * cannot be its width.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};
const SRC = readFileSync(join(ROOT, 'src/parse/raywidth.js'), 'utf8');
const WORKER = readFileSync(join(ROOT, 'src/parse/radar_worker.js'), 'utf8');
const BUNDLE = readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8');
ok('no em dashes', ![SRC, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));
ok('the decoder uses it for every radial', /delta = rayWidth\(delta, current\.ars, thinK\);/.test(WORKER));
ok('the built decoder carries it', BUNDLE.includes('delta > 0.7 * declared'));

const { rayWidth } = await import(pathToFileURL(join(ROOT, 'src/parse/raywidth.js')).href);
ok('a one degree beam next to a radial half a degree over is still one degree (the stripes)', rayWidth(0.5, 2) === 1);
ok('super resolution: half a degree to the next half degree radial stays half a degree', rayWidth(0.5, 1) === 0.5);
ok('an ordinary one degree sweep keeps its measured gap', Math.abs(rayWidth(1.02, 2) - 1.02) < 1e-9);
ok('a repeated radial (gap wrapped round to 360) is one beam, not the whole circle', rayWidth(360, 2) === 1 && rayWidth(359.9, 1) === 0.5);
ok('a real few degree hole in the data is not smeared over', rayWidth(12, 2) === 1);
ok('no declared width: the measured gap, as before', rayWidth(0.7, 0) === 0.7 && rayWidth(NaN, undefined) === 1);
ok('a thinned sweep (an oversampled MRRL radar) keeps its measured gap', Math.abs(rayWidth(0.48, 1, 2) - 0.48) < 1e-9);

// A whole sweep: two one-degree scans interleaved half a degree apart, the
// long range one with echo all the way out and the short range one only close
// in. Far out, the beams that have data must cover the whole circle.
const radials = [];
for (let i = 0; i < 360; i++) { radials.push({ az: i, far: true }); radials.push({ az: i + 0.5, far: false }); }
let covered = 0;
radials.forEach((r, i) => {
  const next = radials[(i + 1) % radials.length];
  let d = next.az - r.az; while (d <= 0) d += 360;
  if (r.far) covered += Math.min(rayWidth(d, 2), 1);
});
ok(`far out, the long range beams cover the whole circle (${covered.toFixed(0)} of 360 degrees)`, Math.abs(covered - 360) < 1e-6);
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
