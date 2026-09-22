#!/usr/bin/env node
/*
 * firebase/FIRESTORE_RULES.txt is what actually gets pasted into the
 * Firebase console, and firebase/firestore.rules is the source of truth.
 * The two drifted: discordEconomy was added to firestore.rules and never
 * to the paste copy, so a console updated from the txt still refused the
 * bot's economy writes. Drift is now a failing test instead of a
 * production 403.
 *
 *     node tools/test-firestore-rules-sync.mjs
 *
 * The dms, dmDirectory and their nested messages blocks are the one
 * DOCUMENTED exception: the txt carries them below the paste block as an
 * optional appendix, by design.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = readFileSync(join(ROOT, 'firebase/firestore.rules'), 'utf8');
const TXT = readFileSync(join(ROOT, 'firebase/FIRESTORE_RULES.txt'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

const DOCUMENTED_EXCEPTIONS = new Set(['dms', 'dmDirectory', 'messages']);

console.log('\n1. every collection in firestore.rules is in the paste copy');
{
  const names = s => new Set([...s.matchAll(/match \/(\w+)\//g)].map(m => m[1]));
  const inRules = names(RULES), inTxt = names(TXT);
  const missing = [...inRules].filter(n => !inTxt.has(n) && !DOCUMENTED_EXCEPTIONS.has(n));
  ok('no collection is missing from the txt (dms/dmDirectory excepted, by design)',
     missing.length === 0, missing.join(','));
  const extra = [...inTxt].filter(n => !inRules.has(n));
  ok('the txt names no collection the rules no longer have', extra.length === 0,
     extra.join(','));
}

console.log('\n2. the paste block itself is a well-formed ruleset');
{
  const start = TXT.indexOf('COPY FROM HERE');
  const end = TXT.indexOf('TO HERE');
  ok('the copy markers exist, in order', start !== -1 && end > start);
  const block = TXT.slice(TXT.indexOf('\n', start) + 1, TXT.lastIndexOf('\n', end));
  ok("it starts with rules_version and closes every brace it opens",
     /rules_version = '2';/.test(block)
     && (block.match(/\{/g) || []).length === (block.match(/\}/g) || []).length,
     `${(block.match(/\{/g) || []).length} open vs ${(block.match(/\}/g) || []).length} close`);
  ok('the bot collections the report named are genuinely in the paste block',
     block.includes('match /chatRoster/') && block.includes('match /discordEconomy/')
     && block.includes('match /asturioSync/'));
}

const EM = String.fromCharCode(0x2014);
console.log('\n3. no em dashes');
{
  ok('none in either rules file or this test',
     !RULES.includes(EM) && !TXT.includes(EM)
     && !readFileSync(join(ROOT, 'tools/test-firestore-rules-sync.mjs'), 'utf8').includes(EM));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
