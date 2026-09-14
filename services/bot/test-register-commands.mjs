#!/usr/bin/env node
/*
 * Registering commands never leaves a duplicate behind.
 *
 *     node services/bot/test-register-commands.mjs
 *
 * rest.put replaces the command set within ONE Discord scope (global, or one
 * guild) - it does nothing to the other scope. A bot first run without
 * DISCORD_GUILD_ID (registering globally), then run again after it was set
 * (registering to the guild instead), used to end up with both still live:
 * Discord shows global and guild commands together in a server, so every
 * command - /map, /link, all of them - showed up twice. Fixed by having
 * registerCommands() clear whichever scope it is NOT using, every time.
 *
 * This drives the real registerCommands() against a fake REST client that
 * records what it was asked to do rather than a real Discord app, so it
 * proves the actual shipped logic, not a paraphrase of it.
 */

import { readFileSync } from 'node:fs';
import { SlashCommandBuilder } from 'discord.js';

const src = readFileSync(new URL('./asturio-bot.mjs', import.meta.url), 'utf8');
const from = src.indexOf('const MAP_OPTIONS = JSON.parse(');
const to = src.indexOf('const client = new Client({');
const PLACES = { us: 1, southeast: 1, midwest: 1, northeast: 1, plains: 1, gulf: 1, west: 1, atlantic: 1 };
const block = src.slice(from, to)
  .replace("new URL('./map-options.json', import.meta.url)", JSON.stringify(new URL('./map-options.json', import.meta.url).pathname));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); } };

// Builds one fresh module instance per call - registerCommands() is only
// meant to run once per process in real life, but each scenario here needs
// its own untouched `calls` log and its own GUILD_ID.
async function loadWith(guildId) {
  return import('data:text/javascript,' + encodeURIComponent(
    `import { readFileSync } from 'node:fs';
     import { SlashCommandBuilder } from ${JSON.stringify(
       new URL('./node_modules/discord.js/src/index.js', import.meta.url).href)};
     const PLACES = ${JSON.stringify(PLACES)};
     const TOKEN = 'test-token';
     const CLIENT_ID = 'test-app-id';
     const GUILD_ID = ${JSON.stringify(guildId)};
     const calls = [];
     class REST {
       constructor() {}
       setToken() { return this; }
       async put(route, opts) { calls.push({ route, body: opts.body }); return opts.body; }
     }
     const Routes = {
       applicationCommands: (id) => \`global:\${id}\`,
       applicationGuildCommands: (id, gid) => \`guild:\${id}:\${gid}\`,
     };
     ${block}
     export { commands, registerCommands, calls };`));
}

console.log('\n1. the command list itself has no duplicate names');
{
  const mod = await loadWith('');
  const names = mod.commands.map(c => c.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  ok('every command name appears exactly once', dupes.length === 0, JSON.stringify(dupes));
  ok('map and link are both actually in the list',
     names.includes('map') && names.includes('link'), names.join(', '));
}

console.log('\n2. with DISCORD_GUILD_ID set: registers to the guild, clears global');
{
  const mod = await loadWith('998877');
  await mod.registerCommands();
  const guildCall = mod.calls.find(c => c.route === 'guild:test-app-id:998877');
  const globalCall = mod.calls.find(c => c.route === 'global:test-app-id');
  ok('exactly two API calls were made, not more', mod.calls.length === 2, JSON.stringify(mod.calls.map(c => c.route)));
  ok('the guild gets the real command list', !!guildCall && guildCall.body.length === mod.commands.length,
     JSON.stringify(guildCall && guildCall.body.map(c => c.name)));
  ok('map and link both reached the guild list',
     guildCall && guildCall.body.some(c => c.name === 'map') && guildCall.body.some(c => c.name === 'link'));
  ok('the global scope is explicitly cleared, not left alone',
     !!globalCall && Array.isArray(globalCall.body) && globalCall.body.length === 0,
     JSON.stringify(globalCall));
}

console.log('\n3. with no DISCORD_GUILD_ID: registers globally, never touches a guild');
{
  const mod = await loadWith('');
  await mod.registerCommands();
  ok('exactly one API call was made', mod.calls.length === 1, JSON.stringify(mod.calls.map(c => c.route)));
  ok('it went to the global scope with the real command list',
     mod.calls[0].route === 'global:test-app-id' && mod.calls[0].body.length === mod.commands.length,
     JSON.stringify(mod.calls[0]));
  ok('no guild route was ever called (nothing to clear without knowing which guild)',
     !mod.calls.some(c => c.route.startsWith('guild:')));
}

console.log('\n4. the fix really would have caught the reported bug');
{
  // Simulate the exact history that produced the report: run once with no
  // guild (registers globally), then run again with a guild now configured.
  // Both runs share nothing, so this checks each scope's END state directly
  // rather than the calls made in a single run.
  const first = await loadWith('');
  await first.registerCommands();
  const second = await loadWith('998877');
  await second.registerCommands();
  // What the OLD code (no explicit clear) would have left behind: nothing
  // ever told Discord's global scope to go back to empty, so the command
  // that was there from run 1 would still show up beside the guild's copy
  // from run 2. The new code's run 2 explicitly empties it - checked here
  // by confirming a body: [] call reached the global route.
  const clearedGlobal = second.calls.some(c => c.route === 'global:test-app-id'
    && Array.isArray(c.body) && c.body.length === 0);
  ok('the second run (now with a guild) explicitly empties the global scope '
     + 'the first run had populated, so nothing doubles up', clearedGlobal,
     JSON.stringify(second.calls.map(c => c.route)));
}

const EM = String.fromCharCode(0x2014);
ok('no em dashes in this file',
   !readFileSync(new URL(import.meta.url), 'utf8').includes(EM));

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
