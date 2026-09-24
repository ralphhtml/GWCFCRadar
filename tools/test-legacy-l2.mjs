#!/usr/bin/env node
/*
 * The radar time machine reaching back to 1991: the Level 2 archive's legacy
 * volumes (message 1, Unix .Z compression, no radar position in the file).
 *
 *     node tools/test-legacy-l2.mjs
 *
 * Checked: the .Z decoder matches real Unix compress output byte for byte
 * (text, random bytes, and a big input that walks the code width up to 16 bits
 * and through table resets), and a cut stream decodes as far as it goes; then
 * a synthetic 1995 volume (tools/make-legacy-l2.py: ARCHIVE2 header, message 1
 * records, .Z compressed) goes through the real radar worker and comes out a
 * picture, reflectivity and velocity, placed at the radar the page names, and
 * the time machine offers 1991 onward.
 */

import { readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + String(extra).slice(0, 300) + '>' : '')); }
};

console.log('\n1. the source');
ok('the time machine offers 1991 onward', /const L2ARC_FLOOR = Date\.UTC\(1991, 5, 1\);/.test(PAGE));
ok('a .Z volume is no longer refused', !/still in the pre-2009 tape format/.test(PAGE));
ok('the built worker carries the .Z decoder', readFileSync(join(ROOT, 'assets/radar_worker.bundle.js'), 'utf8').includes('.Z (compress) stream'));
ok('no em dashes in the new code or this test',
   ![readFileSync(join(ROOT, 'src/parse/level2/src/lzwdecompress.js'), 'utf8'), readFileSync(fileURLToPath(import.meta.url), 'utf8'),
     readFileSync(join(ROOT, 'tools/make-legacy-l2.py'), 'utf8')].some(t => t.includes(String.fromCharCode(0x2014))));

console.log('\n2. the .Z decoder against real compress');
const py = spawnSync('python3', ['-c', 'import ncompress'], { encoding: 'utf8' });
if (py.status !== 0) {
  console.log('  (ncompress is not installed: pip install ncompress; skipping this part)');
} else {
  const { default: lzw } = await import(pathToFileURL(join(ROOT, 'src/parse/level2/src/lzwdecompress.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'lzw-'));
  const cases = {
    text: 'import sys; sys.stdout.buffer.write(("the quick brown fox " * 5000).encode())',
    random: 'import os, sys; sys.stdout.buffer.write(os.urandom(300000))',
    // Mixed: enough distinct strings to fill a 16 bit table and force resets.
    big: 'import random, sys; random.seed(7); sys.stdout.buffer.write(bytes(random.choice(b"abcdefgh") if i % 97 else random.randrange(256) for i in range(2000000)))',
  };
  for (const [name, gen] of Object.entries(cases)) {
    const raw = spawnSync('python3', ['-c', gen], { maxBuffer: 1 << 26 }).stdout;
    const z = spawnSync('python3', ['-c', 'import sys, ncompress; sys.stdout.buffer.write(ncompress.compress(sys.stdin.buffer.read()))'],
      { input: raw, maxBuffer: 1 << 26 }).stdout;
    const out = lzw(new Uint8Array(z));
    ok(`${name}: ${raw.length.toLocaleString()} bytes back exactly`, out.length === raw.length && Buffer.compare(Buffer.from(out), raw) === 0,
       `${out.length} vs ${raw.length}`);
    if (name === 'big') {
      const cut = lzw(new Uint8Array(z).subarray(0, Math.floor(z.length / 2)));
      ok('a stream cut in half decodes its first part, correctly', cut.length > raw.length / 4 && Buffer.compare(Buffer.from(cut), raw.subarray(0, cut.length)) === 0, cut.length);
    }
  }
  let threw = false; try { lzw(new Uint8Array([1, 2, 3, 4])); } catch (e) { threw = true; }
  ok('something that is not .Z is refused', threw);
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium || py.status !== 0) {
  console.log('\nplaywright or ncompress missing, skipping the browser half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

console.log('\n3. a 1995 volume through the real radar worker');
const vdir = mkdtempSync(join(tmpdir(), 'l2-'));
spawnSync('python3', [join(ROOT, 'tools/make-legacy-l2.py'), join(vdir, 'KTLX19950605_220000.Z')]);
const VOL = readFileSync(join(vdir, 'KTLX19950605_220000.Z'));
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--allow-file-access-from-files'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });
await p.route('**://**', r => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('leaflet') && u.endsWith('.js')) return r.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (u.includes('leaflet') && u.endsWith('.css')) return r.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  return r.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3500);
const r = await p.evaluate(async (b64) => {
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const out = {};
  for (const layer of ['REF', 'VEL']) {
    try {
      const res = await _workerProcess(u8.slice().buffer, layer, { station: 'ktlx' });
      const md = res.meshData || {};
      const pos = md.positions || md.vertices || (md.buffer ? null : md);
      const b = res.bounds || (res.geojson && res.geojson.bbox) || null;
      out[layer] = { ok: true, bytes: md.byteLength || (md.positions && md.positions.length) || 0, bounds: b,
                     keys: Object.keys(res).join(','), time: res.metadata && res.metadata.timeIso };
    } catch (e) { out[layer] = { ok: false, err: String(e && e.message || e) }; }
  }
  return out;
}, VOL.toString('base64'));
ok('the worker decodes the 1995 reflectivity', r.REF.ok && r.REF.bytes > 0, JSON.stringify(r.REF));
ok('and its velocity', r.VEL.ok && r.VEL.bytes > 0, JSON.stringify(r.VEL));
ok('stamped with the volume\'s own time (1995-06-05 22:00 UTC)', /^1995-06-05T22:00/.test(r.REF.time || ''), r.REF.time);
const bb = r.REF.bounds;
const flat = Array.isArray(bb) ? bb.flat(2).filter(Number.isFinite) : bb ? Object.values(bb).flat(2).filter(Number.isFinite) : [];
ok('placed at KTLX, the radar the page named (the old format has no position)',
   flat.length >= 4 && flat.some(v => Math.abs(v - 35.33) < 1.5) && flat.some(v => Math.abs(v + 97.28) < 1.5), JSON.stringify(bb));
ok('nothing threw on the page', errs.length === 0, errs[0]);
await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
