#!/usr/bin/env node
/*
 * Reads index.html and writes services/bot/map-options.json: every layer, overlay and
 * product the site actually offers.
 *
 *     node tools/extract-map-options.js
 *
 * The bot builds its /map command from that file, so the two cannot drift.
 * Typed by hand they had already drifted: the command offered six radar
 * products where the page shows five, and knew nothing about half the overlays.
 *
 * More importantly it takes only what the page really shows. The dual polarity
 * radar products sit in the source commented out, and a command that offered
 * them would promise a picture nobody can see, on the site or in Discord. Lines
 * that are commented out are dropped here for exactly that reason, so "what the
 * bot can ask for" and "what a visitor can click" stay the same list.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// A commented out entry is one nobody can reach. Dropping those lines is the
// whole point, so it happens before anything is matched.
const live = (text) =>
  text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

function block(name) {
  const re = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\n\\s*\\];`);
  const m = html.match(re);
  return m ? live(m[1]) : null;
}

// { id: 'x', ..., label: 'Y' } in either order, quoted either way.
function entries(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const id = line.match(/\bid\s*:\s*'([^']+)'/);
    const label = line.match(/\blabel\s*:\s*'([^']+)'/);
    if (id) out.push({ value: id[1], name: label ? label[1] : id[1] });
  }
  return out;
}

// ── Layers, from the object that tracks which are on ───────────────────────
const layersRaw = html.match(/(?:let|const|var)\s+activeLayers\s*=\s*\{([\s\S]*?)\n\s*\}/);
const layers = layersRaw
  ? [...live(layersRaw[1]).matchAll(/(\w+)\s*:/g)].map(m => m[1])
  : [];

// ── Overlays, from the pills themselves ────────────────────────────────────
// Read off the markup rather than a list, because the markup is what a visitor
// actually clicks. The title attribute is the description the site shows on
// hover, which makes a good Discord description too.
const overlays = [];
for (const m of html.matchAll(
  /class="ov-pill[^"]*"[^>]*data-ovid="([^"]+)"[^>]*title="([^"]*)"/g)) {
  if (m[1].includes('$')) continue;             // a template, not a pill
  overlays.push({ value: m[1], name: m[2].split(/\s+-\s+/)[0].trim() || m[1] });
}
for (const m of html.matchAll(/data-ovid="([^"]+)"/g)) {
  if (m[1].includes('$')) continue;
  if (!overlays.some(o => o.value === m[1])) {
    overlays.push({ value: m[1], name: m[1] });
  }
}

// ── Products, one family at a time ─────────────────────────────────────────
const families = {
  wind:        entries(block('const WIND_SUB_BUBBLES')),
  temperature: entries(block('const TEMPERATURE_SUB_BUBBLES')),
  waves:       entries(block('const WAVES_SUB_BUBBLES')),
  air:         entries(block('const AIR_SUB_BUBBLES')),
  pressure:    entries(block('const PRESSURE_SUB_BUBBLES')),
};

// ── Radar, the real menu structure rather than one flat list ───────────────
// Level 2 comes straight from RADAR_L2_BUBBLES, the site's own single-station
// dual-pol row. Level 3 / Pi comes from PR_PRODUCTS, an object rather than an
// array (a different shape needs its own reader, not the entries() helper).
// A key already offered at Level 2 (kdp, phi share the exact same short code
// as their Level 2 entry) is left out of Level 3: the URL reader tries the
// Level 2 list first, so that string could never actually reach Level 3
// regardless of which menu the command says it came from. Composite is its
// own thing again, the national MRMS mosaic, loaded by its own path rather
// than through either menu, so it is added by hand the same way it always
// was.
const l2Block = html.match(/const RADAR_L2_BUBBLES = \[([\s\S]*?)\n\];/);
const l2Text = l2Block ? live(l2Block[1]) : '';
const radarL2 = [];
for (const m of l2Text.matchAll(/product:\s*'([^']+)',\s*label:\s*'([^']+)'/g)) {
  radarL2.push({ value: m[1], name: m[2] });
}
const l2Values = new Set(radarL2.map(p => p.value));

const prBlock = html.match(/const PR_PRODUCTS = \{([\s\S]*?)\n\};/);
const prText = prBlock ? live(prBlock[1]) : '';
const radarL3 = [];
for (const m of prText.matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
  const [, key, body] = m;
  if (key === 'hydrohybrid') continue;    // no l2 or l3 file at all
  if (!/\bl3\s*:/.test(body)) continue;   // Level 3 only offers what has an l3 file
  if (l2Values.has(key)) continue;        // string collision with a Level 2 code
  const label = body.match(/\blabel\s*:\s*'([^']+)'/);
  if (!label) continue;
  // PR_PRODUCTS' own "composite" (one station's own vertical column max) and
  // the outer Composite category's national MRMS mosaic share the plain
  // word "Composite" - distinct things reached through entirely different
  // code, so the label says which is which rather than repeating itself.
  const name = key === 'composite' ? `${label[1]} (this station)` : label[1];
  radarL3.push({ value: key, name });
}

families.radar = {
  l2: radarL2,
  l3: radarL3,
  composite: [{ value: 'mrms', name: 'Composite Reflectivity (national mosaic)' }],
};

// ── Satellite products, all of them ────────────────────────────────────────
// Used to keep only the 16 ABI bands (id 'chNN'); the page has since grown
// the Pi-built RGB composites and the global mosaic, all reachable through
// the same satproduct URL id, so every entry goes to the bot now. Bands keep
// their channel number in the name; the composites' labels stand alone.
const satellite = [];
{
  const m = html.match(/GOES_PRODUCTS\s*=\s*\[([\s\S]*?)\n\s*\];/);
  const text = m ? live(m[1]) : '';
  for (const line of text.split('\n')) {
    const id = line.match(/\bid\s*:\s*'([^']+)'/);
    const label = line.match(/\blabel\s*:\s*'([^']+)'/);
    if (!id) continue;
    const band = /^ch\d+$/.test(id[1]);
    const name = label ? label[1] : id[1];
    satellite.push({ value: id[1], name: band ? `${name} (${id[1]})` : name });
  }
}
// The id itself already says which of the three menus a product belongs to
// (chNN a band, rgb- a Pi composite, glb- a global mosaic product), so the
// split costs nothing beyond reading the prefix back off the list above.
const satelliteTypes = {
  band:      satellite.filter(p => /^ch\d+$/.test(p.value)),
  composite: satellite.filter(p => p.value.startsWith('rgb-')),
  global:    satellite.filter(p => p.value.startsWith('glb-')),
};

// ── Satellite regions ──────────────────────────────────────────────────────
// The view the satellite is drawn over: CONUS east/west, Alaska, the meso
// boxes, full disk, and the global mosaic's own sectors. Same shape as the
// row on the page; the satregion URL parameter takes the id.
const satregions = [];
{
  const m = html.match(/GOES_REGIONS\s*=\s*\[([\s\S]*?)\n\s*\];/);
  const text = m ? live(m[1]) : '';
  for (const line of text.split('\n')) {
    const id = line.match(/\bid\s*:\s*'([^']+)'/);
    const label = line.match(/\blabel\s*:\s*'([^']+)'/);
    if (id) satregions.push({ value: id[1], name: label ? label[1] : id[1] });
  }
}

// ── CPC outlook types ──────────────────────────────────────────────────────
// The four extended-range outlooks the CPC overlay can show. Their ids are
// terse ('6_10_temp'), so the names spell them out for the Discord picker.
const cpctypes = [];
{
  const m = html.match(/CPC_TYPES\s*=\s*\[([^\]]*)\]/);
  const pretty = (id) => {
    const [a, b, kind] = id.split('_');
    const what = kind === 'temp' ? 'Temperature' : 'Precipitation';
    return `${a}-${b} Day ${what}`;
  };
  if (m) for (const t of m[1].match(/'([^']+)'/g) || []) {
    const id = t.slice(1, -1);
    cpctypes.push({ value: id, name: pretty(id) });
  }
}

// ── Basemaps ─────────────────────────────────────────────────────────────
// Used to be one onclick="setMapType('x')" button per style; that became a
// single <select id="lqm-set-maptype"> at some point and this regex, still
// hunting for the old buttons, quietly stopped finding anything - a bot
// offering only the default basemap and nothing else would have gone
// unnoticed since "dark" is a real, working value.
const basemapSelect = html.match(
  /<select id="lqm-set-maptype"[^>]*>([\s\S]*?)<\/select>/);
const basemaps = basemapSelect
  ? [...live(basemapSelect[1]).matchAll(/<option value="([a-z]+)"/g)].map(m => m[1])
  : ['dark'];                           // the fallback if the select ever moves again

const out = {
  generated: 'by tools/extract-map-options.js from index.html, do not edit',
  layers, overlays, basemaps, satellite, satelliteTypes, satregions, cpctypes, families,
};

const dest = path.join(root, 'services', 'bot', 'map-options.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');

console.log(`layers      ${layers.length}`);
console.log(`overlays    ${overlays.length}`);
console.log(`basemaps    ${basemaps.length}   ${basemaps.join(', ')}`);
console.log(`satellite   ${satellite.length}`);
for (const [sub, list] of Object.entries(satelliteTypes)) {
  console.log(`satellite.${sub.padEnd(9)} ${list.length}   ${list.map(p => p.value).join(', ')}`);
}
console.log(`satregions  ${satregions.length}   ${satregions.map(r => r.value).join(', ')}`);
console.log(`cpctypes    ${cpctypes.length}   ${cpctypes.map(c => c.value).join(', ')}`);
for (const [k, v] of Object.entries(families)) {
  if (k === 'radar') {
    for (const [sub, list] of Object.entries(v)) {
      console.log(`radar.${sub.padEnd(9)} ${list.length}   ${list.map(p => p.value).join(', ')}`);
    }
    continue;
  }
  console.log(`${k.padEnd(11)} ${v.length}   ${v.map(p => p.value).join(', ')}`);
}
console.log(`\nwrote ${path.relative(root, dest)}`);
