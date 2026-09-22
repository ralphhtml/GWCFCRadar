#!/usr/bin/env node
/*
 * The ?product= URL param (what /map drives) used to accept only ref, vel,
 * hc, accum and boha - a stale list that predated the real Level 2 dual-pol
 * menu (RADAR_L2_BUBBLES: ref, vel, cc, zdr, kdp, sw, phi) and the Level 3 /
 * Pi menu (RADAR_PI_BUBBLES, built from PR_PRODUCTS). Anything outside that
 * stale list was silently ignored, console-warned, and left the map showing
 * whatever it already had - which is why a bot screenshot asking for a
 * product the URL reader did not know about came back wrong with no legend
 * and no explanation.
 *
 *     node tools/test-radar-url-products.mjs
 *
 * Three things are worth checking rather than trusting.
 *
 * THE DUAL-POL SET MATCHES WHAT THE SITE'S OWN LEVEL 2 MENU OFFERS, NOT A
 * GUESS. RADAR_L2_BUBBLES is the real, current source of which short codes
 * decode successfully (loadDualPolData/loadL3Data actually have data for
 * them, confirmed against DP_LAYER_MAP and _l2ArcShow's own shortOk list) -
 * echo tops, VIL, 1-hr and storm total are real decoded products elsewhere
 * in the app but have no entry in DP_LAYER_MAP, so accepting them here would
 * reproduce the exact bug this fixes.
 *
 * A STATION IS NEVER REQUIRED. Both the Level 2 branch (via
 * loadDualPolData/loadL3Data's own _nearestStation(map.getCenter())
 * fallback) and the new Level 3/Pi branch (via _nearestStation directly)
 * decode whichever station is nearest wherever ?lat/?lon or ?place put the
 * camera, so a place name alone is always enough - a good thing, since
 * /map has no station option.
 *
 * HYDROHYBRID IS DELIBERATELY LEFT OUT. PR_PRODUCTS lists it with neither
 * an l2 nor an l3 file, so it is not a real code path for a URL to reach.
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

console.log('\n1. the Level 2 dual-pol set, matched against the site\'s own menu');
{
  ok('the URL reader accepts the real Level 2 short codes',
     /const RADAR_PRODUCTS_URL = \['ref','vel','hc','accum','boha',\s*\n\s*'sw','cc','zdr','kdp','phi'\];/.test(PAGE));
  ok('every one of those codes is also what RADAR_L2_BUBBLES itself offers',
     ['ref', 'vel', 'cc', 'zdr', 'kdp', 'sw', 'phi'].every(code =>
       new RegExp(`product:'${code}'`).test(PAGE)));
  ok('the stale comment about dual-pol being commented out is gone',
     !/dual-pol[\s\S]{0,80}commented out of that row/.test(PAGE));
}

console.log('\n2. the Level 3 / Pi branch, station-free by design');
{
  ok('an unrecognised radar product still falls through to the PR_PRODUCTS branch',
     /PR_PRODUCTS\[product\] && product !== 'hydrohybrid'/.test(PAGE));
  ok('hydrohybrid is explicitly refused, matching that it has no l2 or no l3 file',
     /hydrohybrid:\s*\{\s*label: 'Hydro\. Class \(sfc\)' \}/.test(PAGE));
  ok('an explicit ?prsite is honoured when it looks like a real station id',
     /const site = \(p\.get\('prsite'\) \|\| ''\)\.trim\(\)\.toLowerCase\(\);/.test(PAGE)
     && /\/\^\[a-z0-9\]\{3,4\}\$\/\.test\(site\)/.test(PAGE));
  ok('without one, the nearest station to the current view is used instead',
     /_nearestStation\(map\.getCenter\(\)\.lat, map\.getCenter\(\)\.lng\)/.test(PAGE));
  ok('the level is forced to l3, not left on whatever auto last resolved to',
     /_prLevel = 'l3';/.test(PAGE));
  ok('the choice is enabled through the same _prEnable the real menu uses',
     /_prOn = true;\s*\n\s*if \(typeof _prEnable === 'function'\) _prEnable\(\);/.test(PAGE));
}

const EM = String.fromCharCode(0x2014);
ok('no em dashes here or in the page',
   !PAGE.includes(EM)
   && !readFileSync(join(ROOT, 'tools/test-radar-url-products.mjs'), 'utf8').includes(EM));

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
