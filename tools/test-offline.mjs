#!/usr/bin/env node
/*
 * Everything works without internet, to the extent physics allows: the app
 * opens, every layer replays the last answer it saw, a banner says since
 * when, and the moment a connection returns every live layer refreshes
 * itself.
 *
 *     node tools/test-offline.mjs
 *
 * Two halves. The static half reads the mechanisms out of sw.js and
 * index.html. The live half serves the repo over local http (a service
 * worker will not register from file://), lets the worker claim the page,
 * primes its data cache with one real fetch, then cuts the network with
 * the browser's own offline switch and checks that the fetch replays, the
 * shell reloads, and the banner comes and goes with the connection.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');
const SW = readFileSync(join(ROOT, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the worker keeps a last-good copy of every data answer');
{
  ok('a data cache exists and survives activation',
     /const DATA_CACHE\s*=\s*'gwcfc-data-v1'/.test(SW)
     && /k !== DATA_CACHE/.test(SW));
  ok('every unclaimed GET goes network-first with the copy as fallback',
     /dataNetworkFirst\(e\)/.test(SW)
     && /const hit = await cache\.match\(req, \{ ignoreVary: true \}\);/.test(SW)
     && /return hit \|\| new Response\('', \{ status: 503 \}\);/.test(SW));
  ok('the live response streams through; the copy buffers in the background',
     /const copy = res\.clone\(\);/.test(SW) && /e\.waitUntil\(\(async \(\) => \{/.test(SW));
  ok('a range request passes through uncached, so a 206 never replays as a whole file',
     /if \(req\.headers\.get\('range'\)\)/.test(SW));
  ok('bodies past the cap are not cached, so one volume cannot evict a day of data',
     /DATA_BODY_CAP = 8 \* 1024 \* 1024/.test(SW)
     && /buf\.byteLength > DATA_BODY_CAP\) return;/.test(SW));
  ok('the cache is pruned oldest-first at its cap',
     /DATA_MAX\s*=\s*1600/.test(SW) && /_pruneData\(cache\)/.test(SW));
  ok('the Firebase SDK is cached, so accounts code parses offline',
     /'www\.gstatic\.com',/.test(SW));
  const EM = String.fromCharCode(0x2014);
  ok('no em dashes in the new work',
     !SW.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-offline.mjs'), 'utf8').includes(EM));
}

console.log('\n2. the page says it is offline, and catches up when it is not');
{
  ok('the banner exists', /id="offline-bar"/.test(PAGE));
  ok('it shows on the offline event with the time the connection went',
     /window\.addEventListener\('offline', show\);/.test(PAGE)
     && /Offline since \$\{(h|_clockHM\([^}]*\))\}/.test(PAGE));   // the time follows the 12/24 hour setting now
  ok('the online event hides it and refreshes every live layer',
     /window\.addEventListener\('online', hide\);/.test(PAGE)
     && /_offlineRecover\(\);/.test(PAGE)
     && /go\('loadNEXRAD'\);/.test(PAGE)
     && /go\('loadAlerts', true\);/.test(PAGE));
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* below */ }
if (!chromium) {
  console.log('\nplaywright is not installed, skipping the live half');
  console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
  process.exit(fail ? 1 : 0);
}

const PORT = 8931;
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const ctx = await b.newContext({ viewport: { width: 900, height: 700 } });
const p = await ctx.newPage();
await p.addInitScript(() => {
  try { localStorage.setItem('gwcfc_tutorial_seen', '1'); } catch (e) {}
});

console.log('\n3. live: the worker claims the page and keeps its copies');
try {
  await p.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  const claimed = await p.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-sw';
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) {
      await new Promise(r => setTimeout(r, 250));
    }
    return navigator.serviceWorker.controller ? 'claimed' : 'unclaimed';
  });
  ok('the worker installs and claims the open page', claimed === 'claimed', claimed);

  const prime = await p.evaluate(async () => {
    const r = await fetch('OVERVIEW.txt?offline-test=1');
    const text = await r.text();
    // The background copy needs a beat to land in the cache.
    await new Promise(res => setTimeout(res, 800));
    return { ok: r.ok, len: text.length };
  });
  ok('a data fetch answers live while a copy is saved', prime.ok && prime.len > 500,
     JSON.stringify(prime));

  await ctx.setOffline(true);
  const replay = await p.evaluate(async () => {
    const out = {};
    try {
      const r = await fetch('OVERVIEW.txt?offline-test=1');
      out.status = r.status;
      out.len = (await r.text()).length;
    } catch (e) { out.status = 'threw'; }
    try {
      const miss = await fetch('never-seen-' + Math.random());
      out.missStatus = miss.status;
    } catch (e) { out.missStatus = 'threw'; }
    return out;
  });
  ok('offline, the same fetch replays the saved copy',
     replay.status === 200 && replay.len > 500, JSON.stringify(replay));
  ok('and a never-seen request fails honestly with a 503, not a hang',
     replay.missStatus === 503, String(replay.missStatus));

  console.log('\n4. live: the shell reloads offline, and the banner tracks the connection');
  await p.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const offlineBoot = await p.evaluate(() => ({
    booted: !!document.getElementById('animbar'),
    banner: (() => { const el = document.getElementById('offline-bar');
      return el ? getComputedStyle(el).display : 'missing'; })(),
    bannerText: (document.getElementById('offline-bar') || {}).textContent || '',
  }));
  ok('the whole app shell boots with no network at all', offlineBoot.booted,
     JSON.stringify(offlineBoot));
  ok('the banner is up and says since when',
     offlineBoot.banner === 'block' && /Offline since \d{1,2}:\d{2} (AM|PM)/.test(offlineBoot.bannerText),
     JSON.stringify(offlineBoot));

  await ctx.setOffline(false);
  await p.waitForTimeout(600);
  const back = await p.evaluate(() => {
    const el = document.getElementById('offline-bar');
    return el ? getComputedStyle(el).display : 'missing';
  });
  ok('the banner leaves the moment the connection returns', back === 'none', back);
} finally {
  await b.close();
  server.kill();
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
