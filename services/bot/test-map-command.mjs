#!/usr/bin/env node
/*
 * Builds the real /map command and checks it against Discord's own limits.
 *
 *     node services/bot/test-map-command.mjs
 *
 * Those limits are otherwise discovered at startup, when registration fails
 * and the bot is already down. This also checks the command against what the
 * site offers: that every product family reached an option, that nothing the
 * page keeps hidden is on the menu, and that completion never suggests a value
 * Discord would refuse.
 */
// which are only otherwise discovered when registration fails at startup.
import { readFileSync } from 'node:fs';
import { SlashCommandBuilder } from 'discord.js';

const src = readFileSync(new URL('./asturio-bot.mjs', import.meta.url), 'utf8');
const from = src.indexOf('const MAP_OPTIONS = JSON.parse(');
const to   = src.indexOf('const commands = [');
const PLACES = { us:1, southeast:1, midwest:1, northeast:1, plains:1, gulf:1, west:1, atlantic:1 };
const block = src.slice(from, to)
  .replace("new URL('./map-options.json', import.meta.url)", JSON.stringify(new URL('./map-options.json', import.meta.url).pathname));

const mod = await import('data:text/javascript,' + encodeURIComponent(
  `import { readFileSync } from 'node:fs';
   import { SlashCommandBuilder } from ${JSON.stringify(
     new URL('./node_modules/discord.js/src/index.js', import.meta.url).href)};
   const PLACES = ${JSON.stringify(PLACES)};
   ${block}
   export { mapCommand, completeList, validateMapOptions, MAP_OPTIONS, FAMILY_OPTIONS };`));

const cmd = mod.mapCommand().toJSON();
let fail = 0;
const ok = (n, c, x) => { if (c) console.log('  ok   ' + n);
  else { fail++; console.log('  FAIL ' + n + (x ? '  <' + x + '>' : '')); } };

console.log('\n/map schema');
ok('at most 25 options', cmd.options.length <= 25, cmd.options.length);
console.log(`       ${cmd.options.length} options: ${cmd.options.map(o => o.name).join(', ')}`);
for (const o of cmd.options) {
  if (o.choices) ok(`${o.name}: <=25 choices (${o.choices.length})`, o.choices.length <= 25, o.choices.length);
  for (const c of (o.choices || [])) {
    ok(`${o.name}/${c.value}: name <=100`, c.name.length <= 100, c.name.length);
  }
}

console.log('\ncoverage against the site');
const M = mod.MAP_OPTIONS;
console.log(`       ${M.layers.length} layers, ${M.overlays.length} overlays, ` +
            `${M.satellite.length} satellite bands`);
ok('every product family reached an option',
   mod.FAMILY_OPTIONS.every(([n]) => cmd.options.some(o => o.name === n)),
   mod.FAMILY_OPTIONS.map(f => f[0]).join(','));
ok('dual polarity products are not offered',
   !M.families.radar.some(p => ['cc','zdr','kdp','sw'].includes(p.value)),
   M.families.radar.map(p => p.value).join(','));
ok('the whole satellite catalog is offered: bands, composites, global mosaic',
   M.satellite.length > 16
   && M.satellite.some(p => p.value === 'ch13')
   && M.satellite.some(p => p.value.startsWith('rgb-'))
   && M.satellite.some(p => p.value.startsWith('glb-')),
   M.satellite.length);
ok('the satellite regions are offered, meso boxes and world sectors included',
   Array.isArray(M.satregions)
   && ['auto','west','emeso1','wfulldisk','global'].every(
        r => M.satregions.some(x => x.value === r)),
   (M.satregions || []).map(r => r.value).join(','));
ok('the outlook dials are on the command',
   ['spcday','spchaz','wpcday','fwday','cpctype']
     .every(n => cmd.options.some(o => o.name === n)),
   cmd.options.map(o => o.name).join(','));
ok('cpctype offers all four extended outlooks with readable names',
   (M.cpctypes || []).length === 4
   && M.cpctypes.every(c => /Day (Temperature|Precipitation)$/.test(c.name)),
   JSON.stringify(M.cpctypes));

console.log('\nautocomplete');
const r1 = mod.completeList('overlays', 'sp');
ok('filters as you type', r1.length > 0 && r1.every(x => /sp/i.test(x.value) || /sp/i.test(x.name)),
   r1.map(x => x.value).join(','));
const r2 = mod.completeList('overlays', 'alerts,wind');
ok('keeps what is already typed', r2.every(x => x.value.startsWith('alerts,')),
   r2.map(x => x.value).slice(0,3).join(' '));
ok('does not offer a duplicate', !mod.completeList('overlays', 'alerts,').some(x => x.value === 'alerts,alerts'));
ok('every completion value <=100 chars', mod.completeList('overlays','').every(x => x.value.length <= 100));
ok('at most 25 suggestions', mod.completeList('layers','').length <= 25, mod.completeList('layers','').length);

console.log('\nvalidation');
ok('accepts a real layer', mod.validateMapOptions({ layers:'nexrad,tornado' }).length === 0);
ok('refuses one that does not exist',
   mod.validateMapOptions({ layers:'nexrad,unicorn' }).join() === 'layer: unicorn',
   mod.validateMapOptions({ layers:'nexrad,unicorn' }).join());
ok('refuses a dual polarity product nobody can see',
   mod.validateMapOptions({ radar:'zdr' }).length === 1,
   mod.validateMapOptions({ radar:'zdr' }).join());
ok('accepts a real satellite band', mod.validateMapOptions({ satellite:'ch13' }).length === 0);
ok('accepts a composite and a region',
   mod.validateMapOptions({ satellite:'rgb-airmass', satregion:'wmeso2' }).length === 0);
ok('refuses a made up region', mod.validateMapOptions({ satregion:'moon' }).length === 1);
ok('accepts a real CPC outlook', mod.validateMapOptions({ cpctype:'6_10_temp' }).length === 0);
ok('refuses a made up hazard', mod.validateMapOptions({ spchaz:'lava' }).length === 1);
ok('refuses a made up place', mod.validateMapOptions({ place:'narnia' }).length === 1);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
