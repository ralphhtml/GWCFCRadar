#!/usr/bin/env node
/*
 * The loading screen no longer plays music.
 *
 *     node tools/test-loading-music-removed.mjs
 *
 * Static checks only: every other test file already boots the real page
 * and asserts it comes up with no console errors (see "the page boots
 * clean" in tools/test-radar-compare.mjs and others), which is the live
 * proof this removal did not break the dismiss sequence itself. This file
 * just makes sure the music machinery, and the three audio files it alone
 * used, are actually gone rather than merely disconnected.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = readFileSync(join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the music itself is gone: markup, playback code, and state');
{
  ok('no Play Music button, and no <audio> element on the loading screen',
     !PAGE.includes('id="load-music-btn"') && !PAGE.includes('id="load-audio"'));
  ok('no track list, no autoplay/fallback wiring, no per-tap timing state',
     !PAGE.includes('_LOAD_TRACKS') && !PAGE.includes('_loadMusicBtn')
     && !PAGE.includes('_loadTapTime') && !PAGE.includes('_MUSIC_MIN_MS'));
  ok('_actuallyDismiss no longer touches an <audio> element',
     !/const audio = document\.getElementById\('load-audio'\)/.test(PAGE));
}

console.log('\n2. the dismiss timing is a single, simple rule again');
{
  ok('one minimum hold time, not a longer one that used to kick in once music started',
     /function dismissLoading\(\) \{\s*\n\s*const elapsed = Date\.now\(\) - _loadStart;\s*\n\s*if \(elapsed < _LOAD_MIN_MS\) \{/.test(PAGE));
}

console.log('\n3. the three tracks are not just disconnected, the files are gone');
{
  ['sleeping_city.mp3', 'oobe.mp3', 'goat_attitude.mp3'].forEach(f => {
    ok(`assets/audio/${f} no longer ships`, !existsSync(join(ROOT, 'assets/audio', f)));
  });
}

const EM = String.fromCharCode(0x2014);
console.log('\n4. no em dashes');
{
  ok('none in the page or this test file',
     !PAGE.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-loading-music-removed.mjs'), 'utf8').includes(EM));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
