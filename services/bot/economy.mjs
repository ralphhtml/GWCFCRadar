// Asturio's economy: a weather-themed game layered over the Discord bot.
//
// Every Discord user gets their own CAPE balance (Convective Available
// Potential Energy, the number every storm chaser actually watches: it is
// literally the atmosphere's fuel for storms, which is exactly what a
// currency here should be named after) and, if they want one, a pet that
// grows through a REAL meteorological intensity scale: the EF Scale for a
// tornado, Saffir-Simpson for a hurricane, hail size for a supercell.
//
// Everything in this file is pure. No Discord client, no Firestore, no
// network, and randomness is always passed in rather than reached for, so
// every rule here - the odds, the payouts, the cooldown, the streak bonus,
// the feed cost curve - is something a plain Node test can drive directly
// against the exact numbers that ship, not a paraphrase of them.

// ── The currency ─────────────────────────────────────────────────────────
export const CURRENCY_NAME = 'CAPE';
export const CURRENCY_EMOJI = '⚡';

// ── Pets ──────────────────────────────────────────────────────────────────
// Three options, as asked, and each one grows through the scale chasers
// actually use for that exact phenomenon rather than a made-up level number.
// Supercells have no official public intensity scale of their own (EF and
// Saffir-Simpson are for what they PRODUCE), so a supercell pet grows by the
// hail it drops, the other scale every chaser radios in when nothing else
// fits: pea, to marble, to quarter, all the way to softball.
export const PET_TYPES = {
  tornado: {
    label: 'Tornado', emoji: '🌪️',
    scaleName: 'EF Scale',
    stages: ['EF0', 'EF1', 'EF2', 'EF3', 'EF4', 'EF5'],
  },
  hurricane: {
    label: 'Hurricane', emoji: '🌀',
    scaleName: 'Saffir-Simpson Scale',
    stages: ['Tropical Depression', 'Tropical Storm', 'Category 1',
             'Category 2', 'Category 3', 'Category 4', 'Category 5'],
  },
  supercell: {
    label: 'Supercell', emoji: '⛈️',
    scaleName: 'Hail Size',
    stages: ['Pea Hail', 'Marble Hail', 'Quarter Hail', 'Golf Ball Hail',
             'Baseball Hail', 'Softball Hail'],
  },
};
export const PET_TYPE_IDS = Object.keys(PET_TYPES);

export function isPetType(id) { return PET_TYPE_IDS.includes(id); }
export function petMaxStage(type) { return PET_TYPES[type].stages.length - 1; }
export function petStageLabel(type, stage) {
  const t = PET_TYPES[type];
  const s = Math.max(0, Math.min(stage, t.stages.length - 1));
  return t.stages[s];
}
export function petIsMaxed(type, stage) { return stage >= petMaxStage(type); }

// Feeding costs more the further along the pet already is, the same shape
// every economy-bot upgrade curve uses: cheap to get started, expensive to
// finish, so late stages actually mean something. 50, 100, 150, 200...
export function feedCost(stage) { return 50 + Math.max(0, stage) * 50; }

// ── The daily chase ───────────────────────────────────────────────────────
// Once per cooldown, a person "goes chasing" and the day's outcome is rolled
// from a weighted table. More busts than anything else, because that is
// true to the actual hobby: most chase days ARE a bust, and a bot where
// every day pays out big would not feel like storm chasing, it would just
// feel like a slot machine wearing a radar icon.
export const CHASE_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours
// A streak survives a gap up to this long, generous enough that a missed
// morning does not erase a real multi-day stretch, tight enough that
// skipping a whole day still costs you the bonus.
const STREAK_GRACE_MS = 40 * 60 * 60 * 1000; // 40 hours

export const CHASE_OUTCOMES = [
  {
    tier: 'bust', weight: 35, min: 0, max: 0,
    lines: [
      'Total bust. The cap never broke, and all you got for the tank of gas was a sunburn.',
      'Capped all day. The whole target area looked loaded on paper and produced a stout inversion, nothing else.',
      'Chased a bust. You called an audible on the dryline and it never even bulged.',
      'Nothing but slop. The convective mode was pure garbage, linear junk with no discrete cells anywhere.',
      'The road network beat you. You watched the cell go tornado warned on radar from forty minutes away, on a gravel maze with no way through.',
      'You core punched for nothing. Heavy rain, some wind, and a whole lot of nothing to show for it.',
      'Wrong side of the dryline all day. The storms that mattered were a county over the whole time.',
    ],
  },
  {
    tier: 'small', weight: 25, min: 10, max: 30,
    lines: [
      'Caught a marginal cell. Nothing violent, but decent structure shots and a rumble of thunder.',
      'A weak, disorganized cluster of storms. Pea sized hail rattled the windshield and that was about it.',
      'A pulse storm put on a short show before it collapsed under its own rain. Worth the drive, barely.',
      'You got a nice shelf cloud and some gusty outflow winds out of an otherwise unremarkable line.',
    ],
  },
  {
    tier: 'decent', weight: 20, min: 40, max: 80,
    lines: [
      'Discrete supercell. Beautiful structure, a slow rotating wall cloud, and a clean RFD cut.',
      'Core punched a strong cell and paid for it in quarter sized hail, but the video was worth every dent.',
      'A tail-end Charlie storm stayed isolated the whole chase and gave you a textbook meso to watch.',
      'The dryline finally mixed out and fired a beautiful line of discrete cells right in your lap.',
    ],
  },
  {
    tier: 'great', weight: 12, min: 90, max: 150,
    lines: [
      'A Tornado Warning went up, and it verified. Brief tornado on the ground in open country, no damage, pure spectacle.',
      'Textbook LP supercell with a gorgeous barrel meso and a clear slot punched right through the bear\'s cage. Chaser convergence was insane, but worth it.',
      'You threaded the bear\'s cage and came out with a funnel that never quite closed the gap to the ground. Heart pounding footage either way.',
      'A green sky, a wall cloud that would not quit, and a warning that verified within minutes of issuance.',
    ],
  },
  {
    tier: 'legendary', weight: 8, min: 180, max: 300,
    lines: [
      'A PDS Tornado Warning, and it delivered: a violent, long track tornado on a day you will talk about for years.',
      'High risk day, and it earned it. A significant tornado, incredible structure, and you were in the bear\'s cage and lived to tell it.',
      'You caught a multi-vortex wedge under a bowling green sky. Nothing in this hobby tops today.',
      'The whole outbreak set up exactly as advanced, and you were parked on the one road that mattered when it happened.',
    ],
  },
];
const CHASE_TOTAL_WEIGHT = CHASE_OUTCOMES.reduce((s, o) => s + o.weight, 0);

// Streak bonus, 5% per consecutive day, capped at 50% so a long streak stays
// meaningful without a payout that runs away from the base numbers above.
export function streakBonus(streak) {
  return Math.min(0.5, Math.max(0, (streak - 1)) * 0.05);
}

export function canChase(lastChaseMs, now = Date.now()) {
  return !lastChaseMs || (now - lastChaseMs) >= CHASE_COOLDOWN_MS;
}
export function msUntilNextChase(lastChaseMs, now = Date.now()) {
  if (!lastChaseMs) return 0;
  return Math.max(0, CHASE_COOLDOWN_MS - (now - lastChaseMs));
}
// A short, human "3h 42m" rather than a raw millisecond count.
export function formatDuration(ms) {
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// A missed day and a half resets the streak; landing inside it continues it.
export function computeStreak(prevStreak, lastChaseMs, now = Date.now()) {
  if (!lastChaseMs) return 1;
  if (now - lastChaseMs > STREAK_GRACE_MS) return 1;
  return Math.max(0, prevStreak || 0) + 1;
}

// One roll of the chase table. rng is injectable so this is exercised at
// exact boundary values in tests rather than trusted on faith; it defaults
// to Math.random for real play.
export function rollChase(rng = Math.random) {
  let r = rng() * CHASE_TOTAL_WEIGHT;
  let picked = CHASE_OUTCOMES[CHASE_OUTCOMES.length - 1];
  for (const o of CHASE_OUTCOMES) {
    if (r < o.weight) { picked = o; break; }
    r -= o.weight;
  }
  const cape = picked.max > picked.min
    ? picked.min + Math.floor(rng() * (picked.max - picked.min + 1))
    : picked.min;
  const line = picked.lines[Math.floor(rng() * picked.lines.length)];
  return { tier: picked.tier, baseCape: cape, line };
}

// Applies the streak bonus to a rolled base amount, rounded to a whole CAPE.
export function applyStreakBonus(baseCape, streak) {
  return Math.round(baseCape * (1 + streakBonus(streak)));
}
