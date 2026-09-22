#!/usr/bin/env node
/*
 * The economy embeds' look: a rotating sidebar color instead of one flat
 * gold, and a big markdown header on every one of them.
 *
 *     node services/bot/test-economy-embeds.mjs
 *
 * economySidebarColor() is pure (just Math.random() over a fixed array),
 * pulled out of asturio-bot.mjs and run directly rather than through the
 * data:-URL module slice test-map-command.mjs uses, that slice's range
 * starts after MAP_OPTIONS, well past where the economy embeds live. The
 * embed text itself (the "# " headers, which handler got recolored and
 * which didn't) is checked with plain string matching against the source,
 * the same way the rest of this file's sibling tests check index.html.
 */

import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./asturio-bot.mjs', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the rotating palette itself');
{
  const from = SRC.indexOf('const ECONOMY_SIDEBAR_COLORS');
  const to = SRC.indexOf('\n\n', SRC.indexOf('function economySidebarColor'));
  const block = SRC.slice(from, to);
  const mod = await import('data:text/javascript,' + encodeURIComponent(
    `${block}\nexport { ECONOMY_SIDEBAR_COLORS, economySidebarColor };`));

  const GOLD = 0xe8b800, RED = 0xff1a00, BLUE = 0x4ea2da;
  ok('the three colors are the app\'s own gold, red and blue (index.html\'s --accent/--danger/--accent2)',
     mod.ECONOMY_SIDEBAR_COLORS.includes(GOLD)
     && mod.ECONOMY_SIDEBAR_COLORS.includes(RED)
     && mod.ECONOMY_SIDEBAR_COLORS.includes(BLUE),
     mod.ECONOMY_SIDEBAR_COLORS.map(c => c.toString(16)).join(','));
  ok('red is weighted heavier than the other two, not an even three-way split',
     mod.ECONOMY_SIDEBAR_COLORS.filter(c => c === RED).length
       > mod.ECONOMY_SIDEBAR_COLORS.filter(c => c === GOLD).length,
     mod.ECONOMY_SIDEBAR_COLORS.join(','));

  const N = 4000;
  const counts = { [GOLD]: 0, [RED]: 0, [BLUE]: 0 };
  for (let i = 0; i < N; i++) counts[mod.economySidebarColor()]++;
  ok('over many calls, every color actually shows up (it does rotate, not stuck on one)',
     counts[GOLD] > 0 && counts[RED] > 0 && counts[BLUE] > 0, JSON.stringify(counts));
  ok('red\'s real share lands close to its 50% weight in the array, not 33%',
     counts[RED] / N > 0.4 && counts[RED] / N < 0.6, (counts[RED] / N).toFixed(2));
  ok('never returns anything outside the three app colors',
     Array.from({ length: 200 }, () => mod.economySidebarColor())
       .every(c => [GOLD, RED, BLUE].includes(c)));
}

console.log('\n2. every economy embed carries a big markdown header');
{
  ok('profile: "# <user>\'s storm chasing profile"',
     /setDescription\(`# \$\{i\.user\.username\}'s storm chasing profile\\n\$\{petLine\(eco\)\}`\)/.test(SRC));
  ok('chase result: "# <user> went storm chasing"',
     /setDescription\(`# \$\{i\.user\.username\} went storm chasing\\n\$\{roll\.line\}`\)/.test(SRC));
  ok('adopt: "# <user> adopted a pet"',
     /setDescription\(`# \$\{i\.user\.username\} adopted a pet\\n/.test(SRC));
  ok('feed: "# <pet> grew"',
     /setDescription\(`# \$\{eco\.petName \|\| t\.label\} grew\\n/.test(SRC));
  ok('leaderboard: "# Top storm chasers"',
     /setDescription\(`# Top storm chasers\\n/.test(SRC));
  ok('the cooldown and cap-reached error embeds were left alone, no header added to those',
     /setDescription\(`Still capped in\. You can chase again/.test(SRC)
     && /setDescription\(`You already have \$\{PET_TYPES/.test(SRC));
}

console.log('\n3. the right embeds got the rotating color, the right ones did not');
{
  ok('all five plain success embeds (profile, adopt, name, feed, leaderboard) now rotate',
     (SRC.match(/\.setColor\(economySidebarColor\(\)\)/g) || []).length === 5);
  ok('the chase result keeps its meaningful tier color, gold only as a fallback',
     /\.setColor\(TIER_COLORS\[roll\.tier\] \|\| ECONOMY_COLOR\)/.test(SRC));
  ok('error embeds are untouched, still the fixed error red',
     (SRC.match(/\.setColor\(ECONOMY_ERROR_COLOR\)/g) || []).length === 2);
}

const EM = String.fromCharCode(0x2014);
console.log('\n4. no em dashes');
{
  ok('none in the bot source or this test file',
     !SRC.includes(EM)
     && !readFileSync(new URL('./test-economy-embeds.mjs', import.meta.url), 'utf8').includes(EM));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
