#!/usr/bin/env node
/*
 * Who asked, and which bot answered, sit at the FOOT of every embed Asturio
 * sends, not at the top as an author line.
 *
 *     node services/bot/test-embed-footer.mjs
 *
 * The footer helpers are cut out of asturio-bot.mjs and run against the
 * real discord.js EmbedBuilder, with a stand-in client, so the embeds
 * checked are the ones Discord would receive. The rest is checked against
 * the source: no author line is left, and every economy reply is signed.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const SRC = readFileSync(new URL('./asturio-bot.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

let discordUrl = null;
try { discordUrl = pathToFileURL(createRequire(import.meta.url).resolve('discord.js')).href; } catch {}

console.log('\n1. the footer, on real embeds');
if (!discordUrl) {
  console.log('  discord.js is not installed here, skipping the built-embed checks');
} else {
  const from = SRC.indexOf('const ASTURIO_EMBED_COLOR');
  const to = SRC.indexOf('\n\n', SRC.indexOf('function askErrorEmbed'));
  const block = SRC.slice(from, to);
  const mod = await import('data:text/javascript,' + encodeURIComponent(
    `import { EmbedBuilder } from ${JSON.stringify(discordUrl)};\n`
    + `const client = { user: { displayAvatarURL: () => 'https://cdn.test/asturio.png' } };\n`
    + `${block}\nexport { askEmbed, askErrorEmbed, botFooter, signEmbed, EmbedBuilder };`));
  const snowball = { username: 'snowball_wx', globalName: 'Snowball' };

  const one = mod.askEmbed('Storms by 4 PM.', snowball, 1, 1).toJSON();
  ok('an answer has no author line at the top', !one.author, JSON.stringify(one.author));
  ok('its footer names the bot and who asked', one.footer && one.footer.text === 'Asturio AI · requested by Snowball',
     JSON.stringify(one.footer));
  ok('with the bot\'s own picture beside it', one.footer && one.footer.icon_url === 'https://cdn.test/asturio.png');
  ok('and the time it was answered', typeof one.timestamp === 'string' && !isNaN(Date.parse(one.timestamp)), one.timestamp);

  const part = mod.askEmbed('...', snowball, 2, 3).toJSON();
  ok('a long answer keeps its "Part 2 of 3" in the same footer',
     part.footer.text === 'Asturio AI · requested by Snowball · Part 2 of 3', part.footer.text);

  const err = mod.askErrorEmbed('Could not answer that.', snowball).toJSON();
  ok('errors are signed the same way', !err.author && /requested by Snowball/.test(err.footer.text), JSON.stringify(err.footer));

  const noGlobal = mod.botFooter({ username: 'plainuser' });
  ok('someone with no display name is named by their username', noGlobal.text === 'Asturio AI · requested by plainuser', noGlobal.text);
  const signed = mod.signEmbed(new mod.EmbedBuilder().setDescription('x'), snowball).toJSON();
  ok('signEmbed adds the same footer to any embed', signed.footer.text === 'Asturio AI · requested by Snowball' && !!signed.timestamp);
}

console.log('\n2. every embed the bot sends is signed at the foot');
{
  ok('no author line is left anywhere in the bot', !/\.setAuthor\(/.test(SRC));
  const handlers = ['handleEconomyProfile', 'handleEconomyChase', 'handleEconomyAdopt', 'handleEconomyName',
                    'handleEconomyFeed', 'handleEconomyLeaderboard'];
  for (const h of handlers) {
    const start = SRC.indexOf('async function ' + h + '(');
    const end = SRC.indexOf('\nasync function ', start + 10);
    const body = SRC.slice(start, end < 0 ? undefined : end);
    const built = (body.match(/new EmbedBuilder\(\)/g) || []).length;
    const signed = (body.match(/signEmbed\(embed, i\.user\)/g) || []).length;
    ok(`${h}: every embed it builds is signed (${signed} of ${built})`, built > 0 && signed === built, `${signed}/${built}`);
  }
  ok('/ask answers are signed with the person who asked', /askEmbed\(part, i\.user, n \+ 1, parts\.length\)/.test(SRC));
  ok('@mention answers too', /askEmbed\(part, m\.author, n \+ 1, parts\.length\)/.test(SRC)
     && /askErrorEmbed\(`Could not answer that: \$\{e\.message\}`, m\.author\)/.test(SRC));
  ok('no em dashes here or in the bot',
     !SRC.includes(String.fromCharCode(0x2014))
     && !readFileSync(new URL('./test-embed-footer.mjs', import.meta.url), 'utf8').includes(String.fromCharCode(0x2014)));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
