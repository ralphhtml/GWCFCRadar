#!/usr/bin/env node
/*
 * Storm Tracks: the NEXRAD storm tracking overlay.
 *
 *     node tools/test-storm-tracks.mjs
 *
 * Three things, each of which has been wrong once:
 *   1. the decoder can read the text block of a Level 3 file at all (the ES
 *      export of the tabular parser pointed at the wrong function, so every
 *      alphanumeric product came back empty with no error),
 *   2. azimuth and range from the radar land on the right spot on the map,
 *      and the product's "movement" column is read as the direction the
 *      cell comes FROM, which the fixture's own forecast spots prove,
 *   3. the overlay is wired like every other overlay: a pill in the launcher
 *      with an info button entry, a legend panel with a drag grip, a toggle
 *      branch, and a changelog line.
 *
 * The fixture is a real file: Miami (KAMX) at 01:34Z on 14 Sep 2026, twelve
 * cells. No network.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the worker reads the storm table out of a real file');
let storms = null, site = null;
{
  const bundle = readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8');
  const raw = readFileSync(join(ROOT, 'tools/fixtures/AMX_NST_2026_09_14_01_34_34'));
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  let out = null;
  const self = { postMessage: (m) => { out = m; }, onmessage: null };
  const ctx = { self, console, performance, TextDecoder, Uint8Array, DataView, ArrayBuffer, setTimeout };
  ctx.globalThis = ctx;
  vm.runInNewContext(bundle, ctx);
  self.onmessage({ data: { type: 'process', arrayBuffer: ab, layer: 'NST',
                           options: { tabular: true, station: 'KAMX' } } });
  ok('the worker answers', !!out && out.type === 'result', out && out.type + ' ' + out.message);
  storms = out && out.tabular && out.tabular.storms;
  site = out && out.site;
  ok('with the radar’s own position', Array.isArray(site)
     && Math.abs(site[0] - 25.611) < 0.01 && Math.abs(site[1] + 80.413) < 0.01, JSON.stringify(site));
  ok('and twelve tracked cells', storms && Object.keys(storms).length === 12,
     storms && Object.keys(storms).length);
  ok('each with a current position', storms && Object.values(storms)
     .every(s => s.current && isFinite(s.current.deg) && isFinite(s.current.nm)));
  ok('a new cell is marked as new rather than given a fake motion',
     storms && storms.T9 && storms.T9.movement === 'new');
  ok('a NO DATA forecast spot is null, not a number',
     storms && storms.M1 && Array.isArray(storms.M1.forecast) && storms.M1.forecast.every(f => f === null));
  ok('the fast cell reports 44 kt', storms && storms.W1 && storms.W1.movement && storms.W1.movement.kts === 44);
}

console.log('\n2. cells land where the radar says they are');
{
  // Lift the geometry helpers out of the page and run them here, so the code
  // under test is the code that ships.
  const grab = (name) => {
    const m = PAGE.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    if (!m) throw new Error('cannot find ' + name);
    return m[0];
  };
  const src = 'const STK_NM_KM = 1.852;\n' + grab('_stkDest') + '\n' + grab('_stkHeading') + '\n'
            + grab('_stkCompass') + '\n' + grab('_stkClass') + '\n'
            + PAGE.match(/const STK_CLASSES = \[[\s\S]*?\];/)[0] + '\n'
            + 'return { _stkDest, _stkHeading, _stkCompass, _stkClass };';
  const G = new Function(src)();
  const [lat0, lon0] = [25.611, -80.413];
  const same = G._stkDest(lat0, lon0, 0, 0);
  ok('zero range is the radar itself', Math.abs(same[0] - lat0) < 1e-9 && Math.abs(same[1] - lon0) < 1e-9);
  const north = G._stkDest(lat0, lon0, 0, 60);
  ok('60 nm due north is one degree of latitude, to a hundredth',
     Math.abs(north[0] - lat0 - 1) < 0.01 && Math.abs(north[1] - lon0) < 1e-6, north.join(','));
  const east = G._stkDest(lat0, lon0, 90, 60);
  ok('60 nm due east moves longitude by more than a degree this far from the equator',
     east[1] - lon0 > 1.0 && east[1] - lon0 < 1.2 && Math.abs(east[0] - lat0) < 0.01, east.join(','));
  // The fixture's cell U6 sits at 207/150 and its forecast spots run 154,
  // 159, 163, 168 nm along 207: it is moving AWAY from the radar to the
  // south-south-west. Its movement column says 28. So 28 is where it comes
  // from, and the heading is 208.
  const u6 = storms && storms.U6;
  ok('the fixture cell moving outward along 207 reports movement 28',
     u6 && u6.current.deg === 207 && u6.movement.deg === 28 && u6.forecast[3].nm > u6.current.nm);
  ok('so heading is the reverse of the movement column', G._stkHeading(28) === 208 && G._stkHeading(350) === 170);
  ok('and it reads as SSW', G._stkCompass(208) === 'SSW' && G._stkCompass(0) === 'N' && G._stkCompass(359) === 'N');
  ok('speed classes split at 20 and 40 kt',
     G._stkClass(3).label === 'Under 20 kt' && G._stkClass(20).label === '20 to 40 kt'
     && G._stkClass(44).label === 'Over 40 kt' && G._stkClass('x') === null);
}

console.log('\n3. it is wired like every other overlay');
{
  ok('a pill in the launcher, with the drag grip every pill has',
     /<div class="ov-pill" id="op-storm-tracks" data-ovid="storm-tracks"[\s\S]{0,400}?<span class="ov-drag"/.test(PAGE));
  ok('the pill’s words for the info button', /'storm-tracks':\s+"Storm cells/.test(PAGE));
  ok('the toggle branch turns it on and off', /id === 'storm-tracks'\) \{\s*if \(_stkActive\) _stkStop\(\); else _stkStart\(\);/.test(PAGE));
  ok('a legend panel in the overlay stack', /<div id="storm-tracks-panel">/.test(PAGE));
  ok('with a drag grip the page makes draggable',
     /id="storm-tracks-drag"/.test(PAGE) && /_makeDraggable\(document\.getElementById\('storm-tracks-panel'\),\s*document\.getElementById\('storm-tracks-drag'\)\)/.test(PAGE));
  ok('the panel shares the overlay panel shell', /#storm-reports-panel, #tornado-tracks-panel, #storm-tracks-panel \{/.test(PAGE));
  ok('a search icon', /'storm-tracks': 'storm'/.test(PAGE));
  ok('switching off drops the layer, the timer and the map listener',
     /function _stkStop\(\) \{[\s\S]*?clearInterval\(_stkTimer\)[\s\S]*?map\.off\('moveend', _stkMoved\)[\s\S]*?map\.removeLayer\(_stkLayer\)/.test(PAGE));
  ok('a fetch that lands after a switch off or a newer request is dropped',
     (PAGE.match(/if \(gen !== _stkGen \|\| !_stkActive\) return;/g) || []).length >= 3);
  ok('the worker is asked for the table, not a picture', /_pbDecode\(buf, 'NST', \{ tabular: true/.test(PAGE));
  ok('a changelog entry', /id: '2026-09-14-a'/.test(PAGE));
  ok('no em dashes', !PAGE.includes('—'));
  const worker = readFileSync(join(ROOT, 'src/parse/radar_worker.js'), 'utf8');
  ok('the worker source has the tabular branch', /if \(isLevel3 && options\?\.tabular\)/.test(worker));
  const tab = readFileSync(join(ROOT, 'src/parse/level3/src/headers/tabular.js'), 'utf8');
  ok('the tabular parser exports itself, not the product description', /export default parse;/.test(tab));
}

console.log(`\n${fail ? fail + ' FAILED, ' : ''}${pass} passed`);
process.exit(fail ? 1 : 0);
