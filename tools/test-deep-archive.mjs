#!/usr/bin/env node
/*
 * The archives: models kept until the disk objects, satellite to ninety
 * days, and the Level 2 tape mirror wired into the radar time machine.
 *
 *     node tools/test-deep-archive.mjs
 *
 * The Level 2 half was designed against the live Google mirror first
 * (listings, CORS, ranged reads, and real volumes through the real worker
 * bundle: 2015 decodes, 2006 and 1991 do not), and this test then holds
 * the mechanics in place offline: a synthetic tar of gzipped volumes is
 * served from the route table with honest 206 ranged reads, and the real
 * walker, chooser and gunzip run against it in a real browser.
 */

import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const GFS = readFileSync(join(ROOT, 'pi/gfs_pipeline.py'), 'utf8');
const SAT = readFileSync(join(ROOT, 'pi/satellite_pipeline.py'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. retention is an archive now, on both pipelines');
{
  ok('models keep every run until the disk objects',
     /GWCFC_MODEL_KEEP_DAYS", "36500"/.test(GFS)
     && /free_mb\(model_dir\) >= DISK_FLOOR_MB \* 2/.test(GFS));
  ok('and a tight disk retires the oldest runs, never a window cliff',
     /disk tight: retiring/.test(GFS));
  ok('satellite keeps ninety days by default',
     /GWCFC_SAT_KEEP_HOURS", "2160"/.test(SAT)
     && /GWCFC_SAT_MAX_FRAMES", "15000"/.test(SAT));
  ok('and trims oldest-first under disk pressure',
     /free_mb\(sector_dir\) < DISK_FLOOR_MB \* 2/.test(SAT)
     && /kept\.pop\(0\)/.test(SAT));
  ok('the radar time machine reaches past the Level 3 floor',
     /const L2ARC_FLOOR = Date\.UTC\(2008, 0, 1\);/.test(PAGE)
     && /if \(at < TM_FLOOR\) await _l2ArcShow\(site, at\);/.test(PAGE));
  ok('the archive reads Google’s mirror through its CORS-open API',
     /storage\.googleapis\.com\/storage\/v1\/b\/gcp-public-data-nexrad-l2\/o/.test(PAGE));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes here, in the page, or in the pipelines',
     !PAGE.includes(EM) && !GFS.includes(EM) && !SAT.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-deep-archive.mjs'), 'utf8').includes(EM));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

// A synthetic hour tar, shaped like the real thing: a pax bookkeeping entry
// (which the walker must step over), a gzipped volume, and a legacy .Z one.
function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(data.length.toString(8).padStart(11, '0') + ' ', 124);
  const padded = Math.ceil(data.length / 512) * 512;
  return Buffer.concat([h, data, Buffer.alloc(padded - data.length)]);
}
// Incompressible middle, on purpose: the walker treats sub-kilobyte entries
// as bookkeeping rather than volumes, so the fixture must gzip to a real
// size the way an actual scan does.
let _seed = 12345;
const noise = Buffer.from(Array.from({ length: 9000 }, () => {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed & 0xff;
}));
const PAYLOAD = Buffer.concat([Buffer.from('AR2V-FAKE '), noise, Buffer.from(' END')]);
const TAR = Buffer.concat([
  tarEntry('./PaxHeaders.1/KTLX20150506_000011_V06.gz', Buffer.from('29 mtime=1\n')),
  tarEntry('KTLX20150506_000011_V06.gz', gzipSync(PAYLOAD)),
  tarEntry('KTLX20150506_003000.Z', Buffer.from([0x1f, 0x9d, 0x90].concat(new Array(2000).fill(7)))),
]);

const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});
let rangeHits = 0;
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('gcp-public-data-nexrad-l2/o?prefix=')) {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      items: [{ name: '2015/05/06/KTLX/NWS_NEXRAD_NXL2DP_KTLX_20150506000000_20150506005959.tar',
                size: String(TAR.length),
                mediaLink: 'https://arcfake.invalid/hour.tar' }] }) });
  }
  if (url.includes('arcfake.invalid/hour.tar')) {
    rangeHits++;
    const m = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range || '');
    const a = m ? +m[1] : 0, z = m ? Math.min(+m[2], TAR.length - 1) : TAR.length - 1;
    return route.fulfill({ status: 206, contentType: 'application/octet-stream',
      body: TAR.subarray(a, z + 1) });
  }
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript',
      body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css',
      body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'),
             { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);

console.log('\n2. the tar walker finds the right scan and decompresses it');
{
  const r = await p.evaluate(async () => {
    const out = {};
    const vol = await _l2ArcVolume('KTLX', Date.UTC(2015, 4, 6, 0, 1));
    out.name = vol.name;
    out.when = new Date(vol.when).toISOString();
    const text = new TextDecoder().decode(new Uint8Array(vol.buffer));
    out.starts = text.startsWith('AR2V-FAKE');
    out.ends = text.endsWith(' END');
    // The legacy .Z era is refused with the reason, not with a blank map.
    out.zError = '';
    try { await _l2ArcVolume('KTLX', Date.UTC(2015, 4, 6, 0, 29)); }
    catch (e) { out.zError = e.message; }
    return out;
  });
  ok('the pax bookkeeping entry is stepped over and the volume found',
     r.name === 'KTLX20150506_000011_V06.gz', r.name);
  ok('its stamp is read from its own name', r.when === '2015-05-06T00:00:11.000Z', r.when);
  ok('the gzip survives the trip byte for byte', r.starts && r.ends);
  ok('a moment nearest the legacy .Z volume says why it cannot show',
     /pre-2009 tape format/.test(r.zError), r.zError);
  ok('every read was a ranged read, never the whole tar', rangeHits >= 3,
     String(rangeHits));
}

console.log('\n3. the archived scan flows through the live pipeline');
{
  const r = await p.evaluate(async () => {
    const out = {};
    const calls = { worker: null, render: null };
    const origW = _workerProcess, origR = _renderMesh;
    window._workerProcess = async (buf, layer) => {
      calls.worker = { bytes: buf.byteLength, layer };
      return { meshData: [], bounds: [-98, 34, -96, 36], metadata: {} };
    };
    window._renderMesh = (result, product, site) => {
      calls.render = { product, site };
      return null;
    };
    _prProduct = 'reflectivity';
    await _l2ArcShow('KTLX', Date.UTC(2015, 4, 6, 0, 1));
    window._workerProcess = origW; window._renderMesh = origR;
    out.worker = calls.worker;
    out.render = calls.render;
    const at = document.getElementById('anim-time');
    out.label = at ? at.textContent : '';
    out.gold = at ? at.style.color : '';
    return out;
  });
  ok('the volume reaches the same worker as the live feed',
     r.worker && r.worker.layer === 'REF' && r.worker.bytes > 4000,
     JSON.stringify(r.worker));
  ok('and the same mesh renderer, as the same product',
     r.render && r.render.product === 'ref' && r.render.site === 'KTLX',
     JSON.stringify(r.render));
  ok('the readout says ARCHIVE with the scan’s own time, in gold',
     /^ARCHIVE · 2015-05-06 00:00Z$/.test(r.label) && r.gold === 'rgb(232, 184, 0)',
     r.label + ' / ' + r.gold);
  ok('the time machine’s date field opens back to 2008',
     await p.evaluate(() => { _tmScope = 'radar'; _prBucketSite = 'KTLX';
       _tmOpen('radar');
       const v = document.querySelector('#tm-date').min;
       _tmClose(); return v; }) === '2008-01-01');
  ok('and nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
