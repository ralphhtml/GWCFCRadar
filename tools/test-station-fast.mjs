// A station click, made fast: the newest Level 2 volume found by a few
// rounds of probes fired together (not a directory listing and a dozen in
// a row), remembered between visits; the first sweep decoded before the
// rest of the volume arrives; and the newest Level 3 scan read from this
// hour's keys rather than three whole days of them.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEAFLET = process.env.LEAFLET_DIST || '/tmp/node_modules/leaflet/dist';
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e).slice(0, 180)));
await p.addInitScript(() => { try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {} });

// ── A fake chunk bucket for station KTST ──────────────────────────────────
// 999 volume directories. The newest is 300: times climb 301..999, then
// 1..300, so the rollover sits between 300 and 301, the way the real feed
// numbers volumes. Each volume is 20 chunks of 200 KB.
const NEWEST = 300, STEP_MIN = 5;
const now = Date.now();
const volTime = (v) => {
  const back = v <= NEWEST ? NEWEST - v : NEWEST + (999 - v) + 1;
  return new Date(now - back * STEP_MIN * 60000);
};
const stamp = (v) => {
  const d = volTime(v);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
};
const CHUNKS = 20, CHUNK_BYTES = 200000;
const hits = { probe: 0, dirList: 0, chunkList: 0, chunk: 0, l3hour: 0, l3day: 0, l3file: 0 };
let l3Hours = {};    // prefix -> keys
let l3Days = {};
await p.route('**://**', route => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('leaflet') && url.endsWith('.js'))
    return route.fulfill({ contentType: 'application/javascript', body: readFileSync(join(LEAFLET, 'leaflet.js'), 'utf8') });
  if (url.includes('leaflet') && url.endsWith('.css'))
    return route.fulfill({ contentType: 'text/css', body: readFileSync(join(LEAFLET, 'leaflet.css'), 'utf8') });
  if (url.includes('unidata-nexrad-level2-chunks')) {
    const u = new URL(url);
    const prefix = u.searchParams.get('prefix') || '';
    const maxKeys = u.searchParams.get('max-keys');
    const xml = (keys) => `<?xml version="1.0"?><ListBucketResult>${keys.map(k => `<Contents><Key>${k.key}</Key><Size>${k.size}</Size></Contents>`).join('')}</ListBucketResult>`;
    if (u.searchParams.get('list-type') === '2') {
      const m = /^KTST\/(\d+)\/$/.exec(prefix);
      if (u.searchParams.get('delimiter')) { hits.dirList++; return route.fulfill({ contentType: 'application/xml', body: '<ListBucketResult></ListBucketResult>' }); }
      if (!m) return route.fulfill({ contentType: 'application/xml', body: xml([]) });
      const v = +m[1];
      if (v < 1 || v > 999) return route.fulfill({ contentType: 'application/xml', body: xml([]) });
      const keys = [];
      for (let i = 1; i <= CHUNKS; i++) {
        keys.push({ key: `KTST/${v}/${stamp(v)}-${String(i).padStart(3, '0')}-${i === 1 ? 'S' : i === CHUNKS ? 'E' : 'I'}`, size: i === 1 ? 2400 : CHUNK_BYTES });
      }
      if (maxKeys === '1') { hits.probe++; return route.fulfill({ contentType: 'application/xml', body: xml(keys.slice(0, 1)) }); }
      hits.chunkList++;
      return route.fulfill({ contentType: 'application/xml', body: xml(keys) });
    }
    const m = /KTST\/(\d+)\/\d{8}-\d{6}-(\d{3})-[SIE]$/.exec(u.pathname);
    if (m) { hits.chunk++; return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(m[2] === '001' ? 2400 : CHUNK_BYTES, 1) }); }
    return route.fulfill({ status: 404, body: '' });
  }
  if (url.includes('unidata-nexrad-level3')) {
    const u = new URL(url);
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') || '';
      const hour = /^TST_N0B_\d{4}_\d{2}_\d{2}_\d{2}_$/.test(prefix), day = /^TST_N0B_\d{4}_\d{2}_\d{2}_$/.test(prefix);
      if (hour) hits.l3hour++; else if (day) hits.l3day++;
      const keys = hour ? (l3Hours[prefix] || []) : day ? (l3Days[prefix] || []) : [];
      return route.fulfill({ contentType: 'application/xml', body: `<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>` });
    }
    hits.l3file++;
    return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.alloc(100, 1) });
  }
  return route.abort();
});
await p.goto('file://' + join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(4200);
const snap = () => JSON.parse(JSON.stringify(hits));

console.log('\n1. the newest volume is found by rounds of probes fired together, no listing');
{
  const before = snap();
  const r = await p.evaluate(async () => {
    localStorage.removeItem('gwcfc_l2_newest');
    const t0 = performance.now();
    const v = await _s3NewestVol('KTST');
    const mem = JSON.parse(localStorage.getItem('gwcfc_l2_newest') || '{}');
    return { vol: v.vol, time: v.time, ms: performance.now() - t0, remembered: mem.KTST && mem.KTST.vol };
  });
  const d = snap();
  ok('the volume past the rollover is the newest', r.vol === NEWEST, String(r.vol));
  ok('its start time is read from its first chunk', /^\d{14}$/.test(r.time), r.time);
  ok('no directory listing of a thousand prefixes', d.dirList - before.dirList === 0, String(d.dirList - before.dirList));
  ok('under forty small probes, in three rounds', d.probe - before.probe <= 40 && d.probe - before.probe >= 20, String(d.probe - before.probe));
  ok('the answer is remembered for next time', r.remembered === NEWEST, String(r.remembered));
}

console.log('\n2. the same station again is the same answer, not a second search');
{
  const before = snap();
  const r = await p.evaluate(async () => {
    const a = await _s3NewestVol('KTST');
    const bb = await _s3NewestVol('ktst');
    return { same: a.vol === bb.vol && a.vol === 300 };
  });
  const d = snap();
  ok('two more asks inside the minute cost nothing', r.same && d.probe - before.probe === 0, String(d.probe - before.probe));
}

console.log('\n3. a later visit starts from the remembered guess and settles in one round');
{
  const before = snap();
  const r = await p.evaluate(async () => {
    _s3NewestCache.clear();
    const v = await _s3FindNewest('KTST');
    return { vol: v.vol };
  });
  const d = snap();
  ok('still the right volume', r.vol === NEWEST, String(r.vol));
  ok('with a window of a dozen probes plus one to confirm', d.probe - before.probe <= 15, String(d.probe - before.probe));
}

console.log('\n4. a wrong memory (the guess lands far from the answer) falls back to the full search');
{
  const before = snap();
  const r = await p.evaluate(async () => {
    const mem = JSON.parse(localStorage.getItem('gwcfc_l2_newest'));
    mem.KTST.vol = 700;                       // nowhere near 300
    localStorage.setItem('gwcfc_l2_newest', JSON.stringify(mem));
    _s3NewestCache.clear();
    const v = await _s3FindNewest('KTST');
    return { vol: v.vol };
  });
  const d = snap();
  ok('the answer is still right', r.vol === NEWEST, String(r.vol));
  ok('at the cost of the full search', d.probe - before.probe > 15 && d.probe - before.probe <= 55, String(d.probe - before.probe));
}

console.log('\n5. the first sweep comes back alone, the rest follows');
{
  const before = snap();
  const r = await p.evaluate(async () => {
    const two = { first: 500000, split: false, onRest: null };
    const restP = new Promise(res => { two.onRest = (full) => res(full ? full.byteLength : null); });
    const t0 = performance.now();
    const buf = await _assembleVolume('KTST', 300, 5 * 1024 * 1024, false, two);
    const firstMs = performance.now() - t0;
    const full = await restP;
    return { first: buf.byteLength, split: two.split, full, firstMs };
  });
  const d = snap();
  ok('the first bite is the chunks up to the first that reaches 500 KB: four of them', r.first === 2400 + 3 * 200000, String(r.first));
  ok('and it says the rest is coming', r.split === true);
  ok('the rest is the whole capped volume, all twenty chunks', r.full === 2400 + 19 * 200000, String(r.full));
  ok('one chunk listing, twenty chunk reads', d.chunkList - before.chunkList === 1 && d.chunk - before.chunk === 20, JSON.stringify([d.chunkList - before.chunkList, d.chunk - before.chunk]));
}

console.log('\n6. no split asked for means the old one-piece behaviour');
{
  const r = await p.evaluate(async () => {
    const buf = await _assembleVolume('KTST', 300, 1000000, false);
    return { bytes: buf.byteLength };
  });
  ok('the capped volume comes back whole', r.bytes === 2400 + 5 * 200000, String(r.bytes));
}

console.log('\n7. the live load and the loop build share the one answer');
{
  const before = snap();
  const r = await p.evaluate(async () => {
    _s3NewestCache.clear();
    const live = await _fetchVolumeDirect('ktst');
    const hist = await _fetchRecentVolumes('ktst', 2, undefined, 1);
    return { live: live.byteLength, hist: hist.length };
  });
  const d = snap();
  ok('the live volume arrives', r.live > 0);
  ok('and two history volumes behind it', r.hist === 2, String(r.hist));
  ok('with one search between them, not two', d.probe - before.probe <= 15, String(d.probe - before.probe));
}

console.log('\n8. an abort signal reaches the chunk reads, and a loop reset pulls it');
{
  const r = await p.evaluate(async () => {
    const ac = new AbortController();
    ac.abort();
    let threw = false;
    try { await _assembleVolume('KTST', 300, 1000000, false, { signal: ac.signal }); } catch (e) { threw = true; }
    _l2LoopReset();
    let pulled = false;
    _l2Loop.abort = { abort: () => { pulled = true; } };
    _l2LoopReset();
    return { threw, pulled, fresh: _l2Loop.abort === null };
  });
  ok('an aborted signal stops the download', r.threw);
  ok('resetting the loop aborts the build in flight and starts clean', r.pulled && r.fresh);
}

console.log('\n9. the newest Level 3 scan comes from this hour, not three days');
{
  const d0 = new Date();
  const hp = (dt) => `TST_N0B_${dt.getUTCFullYear()}_${String(dt.getUTCMonth() + 1).padStart(2, '0')}_${String(dt.getUTCDate()).padStart(2, '0')}_${String(dt.getUTCHours()).padStart(2, '0')}_`;
  const cur = hp(d0), prev = hp(new Date(d0.getTime() - 3600e3));
  l3Hours = { [cur]: [cur + '01_00', cur + '05_00', cur + '09_00'], [prev]: [prev + '50_00', prev + '55_00'] };
  const before = snap();
  const r = await p.evaluate(async () => {
    _arcHourMem.clear();
    const url = await _l3BucketNewest('KTST', 'N0B');
    const again = await _l3BucketNewest('KTST', 'N0B');
    return { url, again };
  });
  const d = snap();
  ok('the last key of this hour', r.url && r.url.endsWith(cur + '09_00'), r.url);
  ok('two hour listings, no day listing', d.l3hour - before.l3hour === 2 && d.l3day - before.l3day === 0, JSON.stringify([d.l3hour - before.l3hour, d.l3day - before.l3day]));
  ok('asked again, the hour is remembered', d.l3hour === snap().l3hour && r.again === r.url);
}

console.log('\n9b. just past the top of the hour, last hour answers');
{
  const d0 = new Date();
  const hp = (dt) => `TST_N0B_${dt.getUTCFullYear()}_${String(dt.getUTCMonth() + 1).padStart(2, '0')}_${String(dt.getUTCDate()).padStart(2, '0')}_${String(dt.getUTCHours()).padStart(2, '0')}_`;
  const prev = hp(new Date(d0.getTime() - 3600e3));
  l3Hours = { [prev]: [prev + '50_00', prev + '58_00'] };
  const r = await p.evaluate(async () => { _arcHourMem.clear(); return await _l3BucketNewest('KTST', 'N0B'); });
  ok('the last key of the previous hour', r && r.endsWith(prev + '58_00'), r);
}

console.log('\n9c. a radar quiet for hours falls back to the day-wide look');
{
  l3Hours = {};
  const dp = (ms) => { const dt = new Date(ms); return `TST_N0B_${dt.getUTCFullYear()}_${String(dt.getUTCMonth() + 1).padStart(2, '0')}_${String(dt.getUTCDate()).padStart(2, '0')}_`; };
  const today = dp(Date.now());
  l3Days = { [today]: [today + '03_10_00'] };
  const before = snap();
  const r = await p.evaluate(async () => { _arcHourMem.clear(); _arcMem.clear(); return await _l3BucketNewest('KTST', 'N0B'); });
  const d = snap();
  ok('found by the day listing', r && r.endsWith(today + '03_10_00'), r);
  ok('which was only read because both hours were empty', d.l3day - before.l3day >= 1);
}

console.log('\n10. the hover warm reads the hour, and the product probe waits for the picture');
{
  ok('the warm asks for this hour and the last', /_arcHourKeys\(site, cd, Date\.now\(\)\);\s*_arcHourKeys\(site, cd, Date\.now\(\) - 3600e3\);/.test(PAGE));
  const show = PAGE.slice(PAGE.indexOf('async function _l3BucketShow('), PAGE.indexOf('// ── ROTATION TRACKS'));
  const probeAt = show.indexOf('_l3ProbeSite(SITE)'), renderAt = show.indexOf('_renderMesh(result');
  ok('inside _l3BucketShow the probe comes after the render', probeAt > renderAt && renderAt > 0, JSON.stringify([renderAt, probeAt]));
  ok('the Level 2 click decodes the first sweep first', /_l2FirstBytes\(product\)/.test(PAGE) && /two\.split\) rest = restP/.test(PAGE));
  ok('a velocity click takes a bigger first bite than reflectivity', await p.evaluate(() => _l2FirstBytes('vel') > _l2FirstBytes('ref') && _l2FirstBytes('ref') > 0));
}

console.log('\n11. nothing above threw');
{
  const real = errs.filter(e => !/Failed to fetch|NetworkError|ERR_FAILED|net::|AbortError/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
}

await b.close();
console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
