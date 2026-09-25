#!/usr/bin/env node
/*
 * Every radar site marker sits where its radar really is.
 *
 *     node tools/test-radar-site-coords.mjs
 *
 * A tester's screenshot: the KIWX pill 58 km east of the hole in the middle
 * of its own picture. The picture is placed from the decoder's station list
 * (src/parse/atticradar/nexrad_locations.js, NOAA's coordinates); the pill,
 * nearest-radar, the sweep and Radar 3D use the map's own table in
 * index.html, and five of its entries were wrong (KHDC by 208 km). This
 * holds the two lists to within a kilometre of each other for every site.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const LOCS = readFileSync(join(ROOT, 'src/parse/atticradar/nexrad_locations.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 400) + '>' : '')); }
};
ok('no em dashes', ![PAGE, readFileSync(fileURLToPath(import.meta.url), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

const truth = {};
for (const m of LOCS.matchAll(/'([A-Z0-9]{4})':\s*\{([^}]*)\}/g)) {
  const la = /lat\w*['"]?\s*:\s*(-?[\d.]+)/.exec(m[2]), lo = /(?:lon|lng)\w*['"]?\s*:\s*(-?[\d.]+)/.exec(m[2]);
  if (la && lo) truth[m[1]] = [+la[1], +lo[1]];
}
// TPBI's data is filed as TDJT now; the decoder's list may know either.
if (!truth.TPBI && truth.TDJT) truth.TPBI = truth.TDJT;

const table = [...PAGE.matchAll(/\{id:'([a-z0-9]{4})',lat:(-?[\d.]+),lon:(-?[\d.]+)/g)]
  .map(m => ({ id: m[1].toUpperCase(), lat: +m[2], lon: +m[3] }));
ok(`the map's table lists the radars (${table.length})`, table.length >= 200);

const off = [], unknown = [];
for (const s of table) {
  const t = truth[s.id];
  if (!t) { unknown.push(s.id); continue; }
  const km = Math.hypot((s.lat - t[0]) * 111, (s.lon - t[1]) * 111 * Math.cos(t[0] * Math.PI / 180));
  if (km > 1) off.push(`${s.id} ${km.toFixed(1)} km`);
}
ok('every site is within a kilometre of its real location', off.length === 0, off.join(', '));
ok('KIWX is at North Webster, Indiana, where its picture is centred',
   (() => { const k = table.find(s => s.id === 'KIWX'); return k && Math.abs(k.lat - 41.3586) < 0.01 && Math.abs(k.lon + 85.7) < 0.01; })());
ok('every site in the table is known to the decoder', unknown.length === 0, unknown.join(', '));
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
