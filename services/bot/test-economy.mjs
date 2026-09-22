#!/usr/bin/env node
/*
 * The economy's game rules, exercised directly and deterministically.
 *
 *     node services/bot/test-economy.mjs
 *
 * Everything in economy.mjs is pure on purpose: no Discord client, no
 * Firestore, and randomness is always passed in rather than reached for.
 * That means the odds, the payouts, the cooldown, the streak bonus and the
 * feed cost curve can all be driven at exact values here, rather than
 * trusted because the code reads plausibly.
 */

import { readFileSync } from 'node:fs';
import {
  CURRENCY_NAME, CURRENCY_EMOJI, PET_TYPES, PET_TYPE_IDS,
  isPetType, petMaxStage, petStageLabel, petIsMaxed, feedCost,
  CHASE_COOLDOWN_MS, CHASE_OUTCOMES, streakBonus, canChase,
  msUntilNextChase, formatDuration, computeStreak, rollChase,
  applyStreakBonus,
} from './economy.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. the currency and the three pets');
{
  ok('the currency has a name and an emoji', CURRENCY_NAME === 'CAPE' && !!CURRENCY_EMOJI);
  ok('exactly three pet types, as asked: supercell, tornado, hurricane',
     PET_TYPE_IDS.length === 3
     && ['supercell', 'tornado', 'hurricane'].every(t => PET_TYPE_IDS.includes(t)),
     PET_TYPE_IDS.join(', '));
  ok('isPetType accepts the three and refuses anything else',
     isPetType('tornado') && isPetType('hurricane') && isPetType('supercell')
     && !isPetType('dog') && !isPetType(''));
  ok('the tornado pet grows through the real EF Scale, EF0 to EF5',
     PET_TYPES.tornado.stages.join(',') === 'EF0,EF1,EF2,EF3,EF4,EF5');
  ok('the hurricane pet grows through the real Saffir-Simpson scale',
     PET_TYPES.hurricane.stages[0] === 'Tropical Depression'
     && PET_TYPES.hurricane.stages.at(-1) === 'Category 5'
     && PET_TYPES.hurricane.stages.includes('Category 1')
     && PET_TYPES.hurricane.stages.includes('Category 5'));
  ok('the supercell pet grows by hail size, pea to softball',
     PET_TYPES.supercell.stages[0] === 'Pea Hail'
     && PET_TYPES.supercell.stages.at(-1) === 'Softball Hail');
  ok('every pet type has an emoji of its own, none sharing one',
     new Set(PET_TYPE_IDS.map(id => PET_TYPES[id].emoji)).size === 3);
}

console.log('\n2. stages, labels, and when a pet is maxed out');
{
  ok('stage 0 reads as the first label of its scale',
     petStageLabel('tornado', 0) === 'EF0');
  ok('the max stage is the last index of the scale',
     petMaxStage('tornado') === 5 && petMaxStage('supercell') === 5
     && petMaxStage('hurricane') === 6);
  ok('a pet below its max stage is not maxed', !petIsMaxed('tornado', 4));
  ok('a pet at its max stage is maxed', petIsMaxed('tornado', 5));
  ok('an out-of-range stage clamps rather than throwing or reading undefined',
     petStageLabel('tornado', 99) === 'EF5' && petStageLabel('tornado', -3) === 'EF0');
}

console.log('\n3. feeding costs more the further a pet has already grown');
{
  ok('stage 0 costs the base amount', feedCost(0) === 50);
  ok('each stage after that costs 50 more than the last',
     feedCost(1) === 100 && feedCost(2) === 150 && feedCost(3) === 200);
  ok('costs only ever climb, never come back down',
     feedCost(0) < feedCost(1) && feedCost(1) < feedCost(2) && feedCost(2) < feedCost(3));
}

console.log('\n4. the cooldown: once every 20 hours, not more');
{
  ok('the cooldown really is 20 hours', CHASE_COOLDOWN_MS === 20 * 60 * 60 * 1000);
  ok('nobody has chased yet, so chasing now is allowed',
     canChase(null) && canChase(undefined) && canChase(0));
  const now = 1_000_000_000_000;
  ok('a chase 19 hours and 59 minutes ago is still on cooldown',
     !canChase(now - (19 * 3600000 + 59 * 60000), now));
  ok('a chase exactly 20 hours ago is allowed again',
     canChase(now - CHASE_COOLDOWN_MS, now));
  ok('a chase 21 hours ago is allowed', canChase(now - 21 * 3600000, now));
  ok('the remaining wait is reported honestly, not rounded to zero early',
     msUntilNextChase(now - 3600000, now) === CHASE_COOLDOWN_MS - 3600000);
  ok('no wait remaining once the cooldown has actually passed',
     msUntilNextChase(now - CHASE_COOLDOWN_MS, now) === 0);
  ok('the duration formatter reads like a person wrote it',
     formatDuration(3 * 3600000 + 42 * 60000) === '3h 42m'
     && formatDuration(5 * 60000) === '5m');
}

console.log('\n5. the streak: continues inside the grace window, resets outside it');
{
  const now = 1_000_000_000_000;
  ok('a first-ever chase starts the streak at 1', computeStreak(0, null, now) === 1);
  ok('chasing again a day later continues the streak',
     computeStreak(3, now - 24 * 3600000, now) === 4);
  ok('chasing again right at the 40 hour grace edge still continues it',
     computeStreak(1, now - 40 * 3600000, now) === 2);
  ok('missing past the grace window resets the streak to 1',
     computeStreak(9, now - 41 * 3600000, now) === 1);
  ok('a negative or missing previous streak never goes negative',
     computeStreak(-5, now - 3600000, now) === 1);
}

console.log('\n6. the streak bonus: 5% a day, capped at 50%');
{
  ok('day one (streak 1) carries no bonus yet', streakBonus(1) === 0);
  ok('day two is a flat 5%', Math.abs(streakBonus(2) - 0.05) < 1e-9);
  ok('day six is 25%', Math.abs(streakBonus(6) - 0.25) < 1e-9);
  ok('the bonus caps at 50% and does not keep climbing past it',
     streakBonus(30) === 0.5 && streakBonus(100) === 0.5);
  ok('a bonus never goes negative even for a bad streak value',
     streakBonus(0) === 0 && streakBonus(-4) === 0);
  ok('applyStreakBonus actually raises the payout and rounds to a whole number',
     applyStreakBonus(100, 6) === 125 && Number.isInteger(applyStreakBonus(101, 3)));
}

console.log('\n7. the chase table: odds, payout ranges, and real chaser language');
{
  const totalWeight = CHASE_OUTCOMES.reduce((s, o) => s + o.weight, 0);
  ok('the weights add up to 100, so they read as plain percentages',
     totalWeight === 100, String(totalWeight));
  ok('bust is the single most likely outcome, true to the actual hobby',
     CHASE_OUTCOMES.find(o => o.tier === 'bust').weight
       === Math.max(...CHASE_OUTCOMES.map(o => o.weight)));
  ok('every tier is strictly worth more than the one before it',
     CHASE_OUTCOMES.every((o, i) => i === 0 || o.min >= CHASE_OUTCOMES[i - 1].max));
  ok('a bust really does pay zero, not a token amount',
     CHASE_OUTCOMES.find(o => o.tier === 'bust').max === 0);
  ok('legendary pays the most of any tier',
     CHASE_OUTCOMES.find(o => o.tier === 'legendary').max
       === Math.max(...CHASE_OUTCOMES.map(o => o.max)));
  ok('every tier has more than one line, so the same day never reads twice',
     CHASE_OUTCOMES.every(o => o.lines.length > 1));
  const allLines = CHASE_OUTCOMES.flatMap(o => o.lines).join(' ').toLowerCase();
  ok('the flavor text actually uses real chaser slang: bust and slop, as asked',
     /\bbust\b/.test(allLines) && /\bslop\b/.test(allLines));
  ok('and more of the real vocabulary: cap, dryline, discrete, meso, RFD, tornado warning',
     /\bcap\b/.test(allLines) && /dryline/.test(allLines) && /discrete/.test(allLines)
     && /\bmeso\b/i.test(allLines) && /\brfd\b/i.test(allLines)
     && /tornado warning/i.test(allLines));
}

console.log('\n8. rolling a chase: deterministic under an injected rng');
{
  // rng() returning 0 always lands on the very first tier at its floor
  // payout and its first flavor line - the table's own edge case.
  const zero = rollChase(() => 0);
  ok('rng() = 0 lands on the first tier (bust) at its minimum payout',
     zero.tier === CHASE_OUTCOMES[0].tier && zero.baseCape === CHASE_OUTCOMES[0].min,
     JSON.stringify(zero));
  // rng() returning just under 1 always lands on the very last tier at its
  // ceiling payout and its last flavor line.
  const almostOne = rollChase(() => 0.999999999);
  const lastTier = CHASE_OUTCOMES.at(-1);
  ok('rng() just under 1 lands on the last tier (legendary) at its maximum payout',
     almostOne.tier === lastTier.tier && almostOne.baseCape === lastTier.max,
     JSON.stringify(almostOne));
  // A fixed sequence of rng() calls should always produce the exact same
  // roll, which is what makes this whole file possible to test at all.
  const seq = [0.5, 0.5, 0.5];
  let n = 0;
  const scripted = () => seq[n++ % seq.length];
  const a = rollChase(scripted);
  n = 0;
  const b = rollChase(scripted);
  ok('the same rng sequence always produces the same roll',
     JSON.stringify(a) === JSON.stringify(b), JSON.stringify([a, b]));
  ok('every roll comes back with a tier that is really on the table',
     CHASE_OUTCOMES.some(o => o.tier === a.tier));

  // A real distribution check: over many rolls with real Math.random, busts
  // should land noticeably more often than legendaries, matching the table.
  let busts = 0, legendaries = 0;
  for (let i = 0; i < 4000; i++) {
    const r = rollChase();
    if (r.tier === 'bust') busts++;
    if (r.tier === 'legendary') legendaries++;
  }
  ok('over many rolls, busts genuinely outnumber legendaries by a wide margin',
     busts > legendaries * 2, `busts=${busts} legendaries=${legendaries}`);
}

const EM = String.fromCharCode(0x2014);
ok('no em dashes in the game logic or in this test file',
   ![new URL('./economy.mjs', import.meta.url), new URL(import.meta.url)]
     .some(u => { try { return readFileSync(u, 'utf8').includes(EM); }
                  catch { return false; } }));

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
