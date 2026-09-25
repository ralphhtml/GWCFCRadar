#!/usr/bin/env node
/*
 * Builds the real /map command and checks it against Discord's own limits.
 *
 *     node services/bot/test-map-command.mjs
 *
 * Those limits are otherwise discovered at startup, when registration fails
 * and the bot is already down. /map takes four options (place, layer,
 * overlay, zoom); a layer is a path through the site's own menu, and this
 * checks the paths complete and resolve the way someone would type them.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./asturio-bot.mjs', import.meta.url), 'utf8');
const from = src.indexOf('const MAP_OPTIONS = JSON.parse(');
const to   = src.indexOf('const commands = [');
const PLACES = { us: { lat: 38, lon: -96, z: 4 }, southeast: { lat: 32, lon: -85, z: 6 }, plains: { lat: 36, lon: -98, z: 6 } };
const block = src.slice(from, to)
  .replace("new URL('./map-options.json', import.meta.url)", JSON.stringify(new URL('./map-options.json', import.meta.url).pathname))
  .replace("new URL('./map-menu.json', import.meta.url)", JSON.stringify(new URL('./map-menu.json', import.meta.url).pathname));

const mod = await import('data:text/javascript,' + encodeURIComponent(
  `import { readFileSync } from 'node:fs';
   import { SlashCommandBuilder } from ${JSON.stringify(
     new URL('./node_modules/discord.js/src/index.js', import.meta.url).href)};
   const PLACES = ${JSON.stringify(PLACES)};
   ${block}
   export { mapCommand, completeList, validateMapOptions, mapUrlParams, LAYER_PATHS, OVERLAY_PATHS, MAP_MENU };`));

let fail = 0;
const ok = (n, c, x) => { if (c) console.log('  ok   ' + n);
  else { fail++; console.log('  FAIL ' + n + (x ? '  <' + x + '>' : '')); } };

console.log('\n/map schema');
const cmd = mod.mapCommand().toJSON();
ok('the options are place, layer, overlay and zoom, in that order',
   cmd.options.map(o => o.name).join(',') === 'place,layer,overlay,zoom', cmd.options.map(o => o.name).join(','));
for (const o of cmd.options) {
  ok(`${o.name}: description <=100`, o.description.length <= 100, o.description.length);
  if (o.choices) ok(`${o.name}: <=25 choices`, o.choices.length <= 25, o.choices.length);
}
ok('layer and overlay are typed with suggestions', cmd.options.filter(o => o.autocomplete).map(o => o.name).join() === 'layer,overlay');
ok('no em dashes in this test', !readFileSync(new URL(import.meta.url)).toString().includes(String.fromCharCode(0x2014)));

console.log('\nthe menu paths');
const L = mod.LAYER_PATHS;
console.log(`       ${L.length} layer paths, ${mod.OVERLAY_PATHS.size} overlay paths`);
const tops = new Set(L.map(x => x.split(' > ')[0]));
ok('every main bubble of the left menu has paths', ['Radar', 'Satellite', 'Waves', 'Air', 'Wind', 'Temperature', 'Pressure'].every(t => tops.has(t)), [...tops].join(','));
ok('the Coral Reef Watch path is there, as the menu walks it', L.includes('Waves > Sea Surf. Temp > Coral Reef Watch > Actual'), L.filter(x => /Coral/.test(x)).join(' | '));
ok('paths go more than one level deep', L.some(x => x.split(' > ').length >= 4));
ok('every path fits in a Discord value', L.every(x => x.length <= 100));

console.log('\nautocomplete');
const crw = mod.completeList('layer', 'coral actual');
ok('any words in any order find the path', crw.some(x => x.value === 'Waves > Sea Surf. Temp > Coral Reef Watch > Actual'), crw.map(x => x.value).join(' | '));
const two = mod.completeList('layer', 'Waves > Sea Surf. Temp > Coral Reef Watch > Actual | velo');
ok('a second layer after | keeps the first', two.length > 0 && two.every(x => x.value.startsWith('Waves > Sea Surf. Temp > Coral Reef Watch > Actual | ')), two.slice(0, 2).map(x => x.value).join(' || '));
ok('at most 25 suggestions, each <=100', mod.completeList('layer', '').length <= 25 && mod.completeList('layer', '').every(x => x.value.length <= 100 && x.name.length <= 100));
const spc = mod.completeList('overlay', 'spc day 2 tornado');
ok('overlay paths carry the outlook day and hazard', spc.some(x => /SPC.*> Day 2 > Tornado$/.test(x.value)), spc.map(x => x.value).join(' | '));

console.log('\nresolving and the link');
ok('a real path is accepted, in any case and spacing', mod.validateMapOptions({ layer: 'waves>sea surf. temp>coral reef watch>ACTUAL' }).length === 0);
ok('a made up path is refused by name', mod.validateMapOptions({ layer: 'Waves > Unicorns' }).join() === 'layer: Waves > Unicorns');
ok('a made up place is refused', mod.validateMapOptions({ place: 'narnia' }).length === 1);
const spcPath = [...mod.OVERLAY_PATHS.keys()].find(k => /> Day 2 > Tornado$/.test(k));
const q = mod.mapUrlParams({ place: 'plains', zoom: 7, layer: 'Waves > Sea Surf. Temp > Coral Reef Watch > Actual', overlay: spcPath });
ok('the link taps the menu path', q.get('menu') === 'Waves>Sea Surf. Temp>Coral Reef Watch>Actual', q.toString());
ok('the overlay switches on with its day and hazard', q.get('overlays') === 'spc-outlook' && q.get('spcday') === '2' && q.get('spchaz') === 'torn', q.toString());
ok('the place and zoom set the view', q.get('lat') === '36' && q.get('lon') === '-98' && q.get('z') === '7' && q.get('shot') === '1', q.toString());

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
