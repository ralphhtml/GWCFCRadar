// Asturio Discord bot - context-aware edition
//
// Answers weather questions in Discord using the same Asturio brain the website
// uses: it POSTs to the existing Cloudflare Worker, so there is no Gemini key on
// this machine. The only secret here is the Discord bot token, and that is read
// from the environment, never from source.
//
// Before answering it pulls live NWS alerts and SPC storm reports, the same
// sources the map uses, plus who is asking, what server they are in and what was
// just said in the channel, so replies are grounded rather than generic.

import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, SlashCommandBuilder, ActivityType, EmbedBuilder,
} from 'discord.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLinkCode, claimLinkCode, getSyncHistory, appendSyncHistory,
         addChatMessage, upsertRosterEntry,
         getEconomy, patchEconomy, queryTopEconomy } from './firestore.mjs';
import {
  CURRENCY_NAME, CURRENCY_EMOJI, PET_TYPES, PET_TYPE_IDS, isPetType,
  petStageLabel, petIsMaxed, feedCost, CHASE_OUTCOMES, canChase,
  msUntilNextChase, formatDuration, computeStreak, rollChase,
  applyStreakBonus, streakBonus,
} from './economy.mjs';

const TOKEN     = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID  = process.env.DISCORD_GUILD_ID || '';       // optional
const AI_WORKER = process.env.ASTURIO_WORKER
               || 'https://asturio-ai.ralphies1005.workers.dev';
const SITE_URL  = 'https://ralphhtml.github.io/GWCFCRadar/';

// Two ways to reach Gemini. The Worker is the default and the better one: the
// key lives in Cloudflare, so there is none in this repo or on the machine
// running the bot, and it is the same brain the website talks to. Setting
// GEMINI_API_KEY calls Gemini directly instead, which is the escape hatch for
// running the bot when the Worker is not deployed.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Google retires model names, and a retired one fails as a confusing 404 rather
// than anything that mentions deprecation. Pinning a current name here and
// allowing an override means the next retirement is an env change, not a patch.
// gemini-flash-latest rather than a pinned version: Google closes old names to
// new projects, so a version pinned today can stop working for a fresh key
// tomorrow even though nothing here changed.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

// Discord user id of the owner. Asturio addresses this person as "god".
// Left blank means nobody gets the treatment, which is the safe default.
const OWNER_ID  = process.env.DISCORD_OWNER_ID || '';

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID.');
  console.error('Copy .env.example to .env, fill it in, then run: npm start');
  process.exit(1);
}

// Discord hard-caps a message at 2000 characters.
const DISCORD_LIMIT = 2000;

// api.weather.gov asks for a contact in the User-Agent and will throttle
// requests that do not send one.
const UA = { 'User-Agent': '(GWCFC Radar Discord bot, github.com/ralphhtml/GWCFCRadar)' };

const withTimeout = (ms) => AbortSignal.timeout(ms);

// -- Who is asking ---------------------------------------------------------
// Every lookup here is best effort. Asturio should still answer if Discord or
// Firestore is having a bad minute, just with less to go on.

async function getUserContext(user, guild) {
  const ctx = {
    name: user.username,
    id: user.id,
    nickname: user.username,
    roles: [],
    // Whoever owns the server is the owner, with DISCORD_OWNER_ID as an
    // override. Deriving it means this works with nothing configured, rather
    // than silently treating the owner as a stranger because an id was never
    // filled in.
    isOwner: (!!OWNER_ID && user.id === OWNER_ID) || (!!guild && user.id === guild.ownerId),
    radarLinked: false,
    radarProfile: null,
  };

  const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
  if (member) {
    ctx.nickname = member.nickname || user.globalName || user.username;
    // @everyone is on every member, so it says nothing about this person.
    ctx.roles = member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name);
  }

  // Linkage and profile both come from the shared conversation document. The
  // account itself is unreadable from here, so asking it directly returned 403
  // and every user looked unlinked however many times they had linked.
  const sync = await getSyncHistory(user.id).catch(() => null);
  if (sync) {
    ctx.radarLinked = true;
    ctx.radarProfile = sync.profile || null;
  }
  return ctx;
}

function serverContextOf(guild) {
  if (!guild) return null;
  return { name: guild.name, members: guild.memberCount };
}

// The last few lines of the channel, so a question like "what about there?"
// has something to resolve against.
async function getRecentMessages(channel, limit = 6) {
  try {
    const fetched = await channel.messages.fetch({ limit });
    return [...fetched.values()]
      .reverse()
      .map(m => `${m.author.username}: ${(m.content || '').slice(0, 160)}`)
      .filter(l => l.split(': ')[1])
      .join('\n') || '(nothing recent)';
  } catch {
    return '(channel history unavailable)';
  }
}

// -- Live context ----------------------------------------------------------
// Everything here is best effort. A source being down should cost that one
// section, never the whole reply, so each returns a placeholder on failure.

async function fetchAlerts() {
  try {
    const r = await fetch(
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert&limit=60',
      { headers: { ...UA, Accept: 'application/geo+json' }, signal: withTimeout(12000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const feats = j.features || [];
    if (!feats.length) return 'No active NWS alerts nationwide.';

    // Group by event so the model sees "14 Flood Warnings", not 14 near-identical
    // paragraphs that would eat the context window for nothing.
    const byEvent = new Map();
    for (const f of feats) {
      const p = f.properties || {};
      const ev = p.event || 'Alert';
      if (!byEvent.has(ev)) byEvent.set(ev, []);
      byEvent.get(ev).push((p.areaDesc || '').split(';')[0].trim());
    }
    const lines = [...byEvent.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 14)
      .map(([ev, areas]) => `${ev} (${areas.length}): ${areas.slice(0, 4).join(' | ')}`);
    return `${feats.length} active alerts.\n` + lines.join('\n');
  } catch (e) {
    return `NWS alerts unavailable (${e.message}).`;
  }
}

async function fetchStormReports() {
  // SPC publishes today's reports as CSV. Counting rows is enough context and
  // avoids shipping hundreds of lines to the model.
  const grab = async (name, url) => {
    try {
      const r = await fetch(url, { signal: withTimeout(12000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = (await r.text()).trim().split('\n')
        .filter(l => l && !l.toLowerCase().startsWith('time'));
      return `${name}: ${rows.length}`;
    } catch { return `${name}: n/a`; }
  };
  const [tor, hail, wind] = await Promise.all([
    grab('Tornado',  'https://www.spc.noaa.gov/climo/reports/today_torn.csv'),
    grab('Hail',     'https://www.spc.noaa.gov/climo/reports/today_hail.csv'),
    grab('Wind',     'https://www.spc.noaa.gov/climo/reports/today_wind.csv'),
  ]);
  return `SPC storm reports today - ${tor}, ${hail}, ${wind}`;
}

function systemPrompt({ alerts, reports, user, server, recent }) {
  const who = [
    `- Discord: @${user.name}${user.nickname !== user.name ? ` (goes by ${user.nickname})` : ''}`,
    user.roles.length ? `- Roles: ${user.roles.join(', ')}` : '- Roles: member',
    user.radarLinked
      ? `- Has a linked GWCFC Radar account${user.radarProfile?.region ? `, home region ${user.radarProfile.region}` : ''}`
      : '- No linked GWCFC Radar account yet, /link connects one',
  ].join('\n');

  const ownerLine = user.isOwner
    ? `\nThis person built you and the site. Address them as "god". Be direct and useful with them, not fawning.\n`
    : '';

  return `You are Asturio AI, the weather assistant for GWCFC Radar (${SITE_URL}), answering in a Discord chat.

TIME: ${new Date().toUTCString()}

=== WHO YOU ARE TALKING TO ===
${who}
${ownerLine}
=== WHERE ===
${server ? `Server: ${server.name}, ${server.members} members` : 'A direct message'}

=== LAST FEW MESSAGES IN THIS CHANNEL ===
${recent}

=== ACTIVE NWS ALERTS ===
${alerts}

=== ${reports} ===

=== ABOUT GWCFC RADAR ===
A live interactive weather map for storm chasers and weather watchers. You know
it in detail and can tell anyone how to do a thing in it, precisely.

RADAR: NEXRAD single site and the MRMS 1km national mosaic. Products are
reflectivity, velocity, hydrometeor classification, storm accumulation and
one hour accumulation. Reached through the RADAR bubble.

SATELLITE: GOES bands ch01 to ch16, including red visible (ch02), shortwave IR
(ch07), the three water vapour bands (ch08 to ch10), clean IR (ch13), cloud top
temperature (ch11) and fire temperature (ch12).

MODELS: GFS, GEM, UKMO, ARPEGE, JMA, ECMWF AIFS, CMA and BoM, plus GFS, ICON
and GEM ensembles, NDFD and ECMWF. Products include 2m temperature, 2m dew
point, relative humidity, precipitation, 10m wind speed and gusts. Frames run
F+000 to F+120 at a six hour step. Soundings are in the models menu.

LAYERS AND OVERLAYS: NWS alert polygons, a WX alert panel and a live EAS feed,
SPC outlooks day 1 to 8 and storm reports, NHC tropical outlook with cones and
past tracks, WPC excessive rainfall, CPC outlooks, mesoscale discussions, fire
weather, Canada alerts, lightning strikes and a thunder tracker, tornado damage
tracks, wildfires, surface analysis fronts, METAR stations, forecast dots, NOAA
Weather Radio transmitters, storm spotters and their reports, live chasers, WFO
offices, traffic cameras, Ambient Weather personal stations, storm centres, wind
and wave particles, and Cloud Capture for user photos. The overlay list is
drag-to-reorder, and the order sets what draws on top.

TOOLS AND ACCOUNTS: radius and storm cone tools, an inspector that reads the
exact value under the crosshair, save layers and save region, a profile with
avatar, and a live chat bridged with this Discord server so messages appear in
both places.

SHARING A VIEW: a link can carry the whole setup, and you can hand someone one:
  ?lat=35.5&lon=-98&z=7&basemap=dark&layers=nexrad&overlays=alerts
plus product=vel for a radar product, satproduct=ch13 for a band, and one
parameter per family such as wind=wind-surface. Anyone asking to be shown
something on the map can be given a link like that, or told to use /map here.

=== WEATHER COMMUNITY CONTEXT ===
You know the weather community that lives on Twitter/X: NWS field offices, SPC
and NHC, broadcast meteorologists, storm chasers posting live streams and chase
logs, model-run arguments, and the tone of severe weather days. Draw on that when
it helps someone understand what they are seeing, but never present a post or a
rumour as an official product.

Rules:
- Answer in plain Discord text. Short paragraphs, no tables, no headers.
- Never use an em dash. Where one might go, use a comma, a colon, or two
  sentences. A plain hyphen is fine only where it truly belongs, as in
  well-known or 50-60 mph.
- Keep it under about 250 words unless asked for detail.
- Ground answers in the live data above. You can also search the web, so look
  things up rather than guessing or saying your knowledge is out of date.
- Say when something came from a search rather than the feeds above, so nobody
  mistakes a news report for an official NWS product.
- People can ask you for a picture of the map with /map, so mention that when
  someone is trying to describe a place or a setup in words.
- Use who you are talking to. Their name, their region and what was just said in the channel are all fair to reference.
- Answer whatever is asked, weather or not. If it is off topic, still answer, then bring it back to something useful.
- You are in Discord, not on the map, so you cannot see the user's screen, toggle layers or move the map. If they want that, point them at the site. You CAN see pictures attached to the message or to the message it replies to.
- Never invent a warning, a watch or a storm report that is not listed above. People may act on this.`;
}

// A key that Google will not let call Gemini is not a temporary failure, and
// nothing about retrying it will help. But there is a second way to ask, the
// same worker the website uses, which needs no key at all. So once a key has
// been refused it is set aside for the rest of the process and everything goes
// through the worker instead.
//
// Before this the bot answered every single mention with the same wall of
// stack trace and told the user nothing, when a working path was sitting
// right there unused.
let _keyRefused = false;

async function _callModel(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Turns Discord image attachments into the inline parts Gemini reads. Discord
// serves attachments over plain HTTPS, so each is fetched and carried as
// base64. Only types Gemini accepts, capped in size and count so one post
// full of screenshots cannot blow the request limit.
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|heic|heif)/i;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_COUNT = 4;

async function imageParts(attachments) {
  const parts = [];
  // Every skip says why. An image silently not looked at reads as the bot
  // being unable to see, and which step dropped it is the whole diagnosis.
  for (const a of attachments) {
    if (parts.length >= IMAGE_MAX_COUNT) break;
    if (!IMAGE_TYPES.test(a.contentType || '')) {
      console.log(`image skipped: type "${a.contentType}" (${a.name})`);
      continue;
    }
    if ((a.size || 0) > IMAGE_MAX_BYTES) {
      console.log(`image skipped: ${Math.round(a.size / 1048576)}MB is over the ${IMAGE_MAX_BYTES / 1048576}MB cap (${a.name})`);
      continue;
    }
    try {
      const r = await fetch(a.url, { signal: withTimeout(20000) });
      if (!r.ok) { console.log(`image skipped: HTTP ${r.status} fetching ${a.name}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      parts.push({ inline_data: {
        mime_type: (a.contentType || 'image/png').split(';')[0],
        data: buf.toString('base64'),
      } });
      console.log(`image attached: ${a.name}, ${Math.round(buf.length / 1024)}KB`);
    } catch (e) {
      console.log(`image skipped: ${e.message} (${a.name})`);
    }
  }
  return parts;
}

async function askAsturio(question, ctx, history = [], images = []) {
  const [alerts, reports] = await Promise.all([fetchAlerts(), fetchStormReports()]);
  const body = {
    system_instruction: { parts: [{ text: systemPrompt({ alerts, reports, ...ctx }) }] },
    // Images go in front of the words, which is the order Gemini reads best.
    contents: [...history, { role: 'user', parts: [...images, { text: question }] }],
    // Google Search grounding. Without it the model answers weather questions
    // from training data that is months stale, which for this subject is worse
    // than useless. With it, anything outside the feeds above is looked up.
    tools: [{ google_search: {} }],
  };

  if (images.length) console.log(`asking with ${images.length} image(s)`);

  const useKey = GEMINI_API_KEY && !_keyRefused;
  const direct = `https://generativelanguage.googleapis.com/v1beta/models/`
               + `${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  let { res, data } = await _callModel(useKey ? direct : AI_WORKER, body);

  // A refused key is a configuration fact, not a blip, so it is only reported
  // once and the worker takes over from then on.
  if (useKey && !res.ok && _isKeyProblem(data?.error?.message, res.status)) {
    _keyRefused = true;
    console.warn('Gemini key refused, switching to the shared worker for the '
               + 'rest of this session. ' + explainApiError(data?.error?.message));
    ({ res, data } = await _callModel(AI_WORKER, body));
  }

  if (!res.ok) throw new Error(explainApiError(data?.error?.message) || `Asturio HTTP ${res.status}`);
  if (!data.candidates?.length) {
    const block = data.promptFeedback?.blockReason;
    throw new Error(block ? `Blocked by safety filter: ${block}` : 'No response from Asturio.');
  }
  const cand = data.candidates[0];
  return cand.content?.parts?.[0]?.text
      || (cand.finishReason && cand.finishReason !== 'STOP' ? `[Stopped: ${cand.finishReason}]` : 'No response.');
}

// Whether this is the key being rejected rather than the request being wrong.
// Those need opposite responses: one is worth falling back from, the other
// would fail exactly the same way through the worker.
function _isKeyProblem(msg, status) {
  if (status === 401 || status === 403) return true;
  return /API_KEY|api key|blocked|PERMISSION_DENIED|not authorized|forbidden/i
    .test(String(msg || ''));
}

// Google answers a disabled API with a wall of text that never says what to do.
// This turns the one error people actually hit into an instruction.
function explainApiError(msg) {
  if (!msg) return '';
  if (/generativelanguage\.googleapis\.com.*blocked|API_KEY_SERVICE_BLOCKED/i.test(msg)) {
    return 'This API key is not allowed to call Gemini. On the key at '
         + 'console.cloud.google.com/apis/credentials, set API restrictions to "Gemini API". '
         + 'Google will not let one key hold Gemini alongside other APIs, so Gemini needs its own key.';
  }
  // A retired model name comes back as a plain 404 that never says "deprecated".
  if (/no longer available to new users/i.test(msg)) {
    return `The model "${GEMINI_MODEL}" is closed to new projects. `
         + 'Set GEMINI_MODEL to gemini-flash-latest.';
  }
  if (/is not found for API version|models\/.*is not found/i.test(msg)) {
    return `The model "${GEMINI_MODEL}" does not exist. Google retired it. `
         + 'Set GEMINI_MODEL to gemini-flash-latest.';
  }
  // Out of budget, which is not a bug and not something restarting will fix.
  if (/prepayment credits are depleted/i.test(msg)) {
    return 'Gemini is out of prepaid credit. Top the project up at ai.studio/projects. '
         + 'Google Cloud trial credit does not cover the Gemini API, it is billed separately.';
  }
  if (/exceeded your current quota/i.test(msg)) {
    return 'Gemini free-tier quota for today is used up. It resets at midnight Pacific, '
         + 'or add billing at ai.studio/projects to lift the cap.';
  }
  return msg;
}

// -- Photographing the map --------------------------------------------------
// The site takes its view from the URL (?lat, ?lon, ?z, ?basemap, ?layers,
// ?overlays, ?shot=1), so a screenshot is a matter of opening the right link
// in a headless browser and waiting for it to say it has settled.
//
// puppeteer-core, not puppeteer: the full package downloads its own ~200 MB
// Chromium, which on a parsing server is a slow download onto an SD card for a browser the
// system already has. This drives the installed one instead.
//
// Imported lazily so a machine without it still runs every other command, and
// /map is the only thing that reports the problem.
// Where Chromium lives differs by distro, and on parsing server OS the package is
// called chromium-browser while the binary is plain chromium. Rather than make
// that a setting people have to discover from an error, look in the usual
// places. CHROME_PATH still wins if it is set.
const CHROME_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return null;
}
// Sized for a parsing server rather than for a desktop. Every extra pixel is more tiles to
// fetch and more canvas to rasterise on a machine with no GPU, and this is still
// comfortably legible in Discord.
const SHOT_W = Number(process.env.SHOT_WIDTH)  || 1000;
const SHOT_H = Number(process.env.SHOT_HEIGHT) || 640;
const SHOT_NAV_MS   = 45000;   // loading the page itself
const SHOT_READY_MS = 20000;   // then waiting for tiles to settle

// A GWCFC-branded title bar stamped across the top of every /map screenshot,
// the way a broadcast graphic sits over a weather feed. The source file is a
// wide banner with a lot of transparent margin around the actual bar (so it
// still looks right at other sizes elsewhere); trimmed once at startup and
// cached, then resized to whatever width a given screenshot needs.
const MAP_OVERLAY_PATH = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'map-overlay-banner.png');
let _overlayBanner; // undefined = not attempted yet, null = sharp or the file is unavailable
async function getMapOverlayBanner() {
  if (_overlayBanner !== undefined) return _overlayBanner;
  try {
    const sharp = (await import('sharp')).default;
    _overlayBanner = await sharp(MAP_OVERLAY_PATH).trim({ threshold: 10 }).toBuffer();
  } catch {
    // No sharp installed, or no banner file on this machine: screenshots
    // still work, they just come back without the title bar.
    _overlayBanner = null;
  }
  return _overlayBanner;
}

// Stamps the banner across the top of a screenshot, full width, scaled to
// keep its own proportions. Falls back to the plain screenshot on any
// failure - a missing overlay is not worth losing the map over.
async function applyMapOverlay(shotBuffer, width) {
  const banner = await getMapOverlayBanner();
  if (!banner) return shotBuffer;
  try {
    const sharp = (await import('sharp')).default;
    const bar = await sharp(banner).resize({ width }).toBuffer();
    return await sharp(shotBuffer)
      .composite([{ input: bar, top: 0, left: 0 }])
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    return shotBuffer;
  }
}

// Named places, so nobody has to know coordinates to ask for a picture.
const PLACES = {
  us:        { lat: 39.5,  lon: -98.4, z: 4 },
  southeast: { lat: 33.5,  lon: -84.4, z: 6 },
  midwest:   { lat: 41.9,  lon: -93.6, z: 6 },
  northeast: { lat: 42.4,  lon: -73.5, z: 6 },
  plains:    { lat: 35.5,  lon: -98.0, z: 6 },
  gulf:      { lat: 27.8,  lon: -90.0, z: 6 },
  west:      { lat: 39.0,  lon: -119.0, z: 5 },
  atlantic:  { lat: 25.0,  lon: -60.0, z: 4 },
};

// Starting a browser is the single most expensive thing here, and on a parsing server it is
// most of the wait. One is kept warm and reused instead, so only the first
// screenshot after a restart pays for the launch.
let _browser = null;
// Puppeteer renamed this: older builds expose isConnected(), newer ones a
// connected getter. Checking both means the warm browser is actually reused
// instead of silently relaunching every time on whichever version is installed.
function browserAlive(b) {
  if (!b) return false;
  if (typeof b.connected === 'boolean') return b.connected;
  if (typeof b.isConnected === 'function') return b.isConnected();
  return false;
}

async function getBrowser() {
  _browserLastUse = Date.now();   // for the idle reaper below
  if (browserAlive(_browser)) return _browser;

  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('Screenshots need puppeteer-core. On the bot machine run: npm install puppeteer-core');
  }

  const chrome = findChrome();
  if (!chrome) {
    throw new Error('No Chromium found. Install one with: sudo apt install -y chromium'
      + ' , or set CHROME_PATH if yours lives somewhere unusual.');
  }

  try {
    _browser = await puppeteer.launch({
      executablePath: chrome,
      // true, not the old 'new' string: recent Puppeteer treats that as an
      // invalid value rather than a deprecated one.
      headless: true,
      args: [
        '--no-sandbox',
        // A parsing server has little shared memory, and Chromium crashes rendering a large
        // map without this.
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // None of this is wanted for a single offscreen page, and all of it
        // costs startup time and memory on a small machine.
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--no-first-run',
        '--mute-audio',
      ],
    });
  } catch (e) {
    throw new Error(`Chromium at ${chrome} would not start: ${String(e.message).split('\n')[0]}`);
  }
  // If it dies (parsing server runs out of memory, say), do not keep handing out a corpse.
  _browser.on('disconnected', () => { _browser = null; });
  return _browser;
}

// One screenshot at a time. Two headless page loads at once on a parsing server is how both
// end up slower than either would have been alone, and how it runs out of memory.
let _shotQueue = Promise.resolve();
function queueShot(fn) {
  const run = _shotQueue.then(fn, fn);
  // Keep the chain alive regardless of this job's outcome.
  _shotQueue = run.then(() => {}, () => {});
  return run;
}

async function screenshotMap(opt) {
  const { place, lat, lon, z } = opt;
  const spot = PLACES[String(place || '').toLowerCase()] || {};
  const q = new URLSearchParams({ shot: '1' });
  const setNum = (k, v) => { if (v !== null && v !== undefined && v !== '') q.set(k, String(v)); };
  setNum('lat', lat ?? spot.lat);
  setNum('lon', lon ?? spot.lon);
  setNum('z',   z   ?? spot.z);
  // Each family option rides under the page's own name for it, taken from
  // the same FAMILY_OPTIONS table the command is built from, so the command
  // and the URL cannot drift apart.
  for (const [name, , param] of FAMILY_OPTIONS) {
    if (opt[name]) q.set(param, String(opt[name]));
  }
  // Radar and satellite are two linked options apiece (a type, then a
  // product scoped to it) rather than one flat family: too many real
  // products to fit in one 25-choice dropdown honestly. The type itself
  // never rides in the URL - each product's own value already says which
  // menu it came from to the page's own ?product=/?satproduct= reader, the
  // same way it does to _prSetLevel/_setGoesProduct on the page itself.
  if (opt['radar-product'])     q.set('product', String(opt['radar-product']));
  if (opt['satellite-product']) q.set('satproduct', String(opt['satellite-product']));
  // Everything else passes through verbatim under the name the page uses.
  for (const k of ['basemap','layers','overlays','model','modelvar',
                   'spcday','spchaz','wpcday','fwday','cpctype']) {
    if (opt[k]) q.set(k, String(opt[k]));
  }
  // Asking for an outlook's dial means asking for the outlook: a day or
  // hazard on its own would otherwise set state nothing draws. The dial
  // implies its overlay, exactly as a radar product implies radar.
  const overlays = new Set(String(q.get('overlays') || '')
    .split(',').map(x => x.trim()).filter(Boolean));
  if (opt.spcday || opt.spchaz) overlays.add('spc-outlook');
  if (opt.wpcday)               overlays.add('wpc-outlook');
  if (opt.fwday)                overlays.add('fire-outlook');
  if (opt.cpctype)              overlays.add('cpc-outlook');
  if (overlays.size) q.set('overlays', [...overlays].join(','));
  // A region without a product would aim the camera with nothing in front
  // of it, so it brings the everyday Clean IR band along.
  if (opt.satregion && !opt['satellite-product']) q.set('satproduct', 'ch13');

  const url = `${SITE_URL}?${q}`;
  return queueShot(async () => {
    const browser = await getBrowser();
    let page;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: SHOT_W, height: SHOT_H, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: SHOT_NAV_MS });
      // The page sets this once its tiles have stopped loading, so this waits on
      // the map actually being drawn rather than on a guessed delay. A stalled
      // layer should still produce a picture, so a timeout here is not fatal.
      await page.waitForFunction(() => document.body.dataset.shotReady === '1',
        { timeout: SHOT_READY_MS }).catch(() => {});
      // jpeg, not png: a map photo is a photograph, and on a slow uplink a
      // 200 KB jpeg reaches Discord far sooner than a 2 MB png of the same thing.
      const shot = await page.screenshot({ type: 'jpeg', quality: 82 });
      // Newer Puppeteer returns a Uint8Array where it used to return a Buffer,
      // and discord.js will not accept the former as an attachment.
      const withBanner = await applyMapOverlay(Buffer.from(shot), SHOT_W);
      return { image: withBanner, url };
    } finally {
      // Close the page but keep the browser, which is the whole point of holding one.
      if (page) await page.close().catch(() => {});
    }
  });
}

// Split on paragraph, then line, then hard-cut, so a long answer never gets
// truncated and never splits mid-word if it can be helped.
function chunk(text, limit = DISCORD_LIMIT) {
  const out = [];
  let buf = '';
  for (const para of text.split('\n\n')) {
    if ((buf + '\n\n' + para).length <= limit) {
      buf = buf ? buf + '\n\n' + para : para;
      continue;
    }
    if (buf) { out.push(buf); buf = ''; }
    if (para.length <= limit) { buf = para; continue; }
    let rest = para;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
      if (cut < limit * 0.5) cut = limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    buf = rest;
  }
  if (buf) out.push(buf);
  return out.length ? out : ['(empty response)'];
}

// -- Asturio's own replies, as embeds -------------------------------------
// Every answer Asturio gives in Discord, whether from /ask or from being
// mentioned, goes out as an embed rather than plain chat text, so it reads
// as Asturio speaking rather than an undecorated wall of text. An embed's
// description holds up to 4096 characters, well past the 2000 a plain
// message allows, so this chunks separately and larger, at ASK_CHUNK_LIMIT
// rather than DISCORD_LIMIT: fewer messages for the same long answer.
const ASTURIO_EMBED_COLOR = 0xe8b800;  // the app's own gold accent
const ASTURIO_ERROR_COLOR = 0xff4d4d;
const ASK_CHUNK_LIMIT = 4000;          // a little headroom under the 4096 cap

// The foot of every embed Asturio sends: the bot's own picture and name, who
// asked, and (Discord adds it from setTimestamp) when. These used to sit at
// the TOP as the embed's author line, a name and picture above the answer,
// which read as the person speaking rather than the bot answering them; the
// footer is where a bot's signature and "requested by" belong.
// The bot is named by its own Discord account (whatever the server knows it
// as, e.g. Snowball), not a hard-coded "Asturio AI", so the footer matches
// the name Discord prints above the message.
const ASTURIO_NAME = 'Asturio AI';   // only if the account is not known yet
function botFooter(user, extra) {
  let botName = ASTURIO_NAME, iconURL;
  try {
    const me = client.user;
    if (me) botName = me.globalName || me.username || ASTURIO_NAME;
    iconURL = me?.displayAvatarURL() || undefined;
  } catch { iconURL = undefined; }
  const who = user ? (user.globalName || user.username) : null;
  const text = [botName, who ? `requested by ${who}` : null, extra].filter(Boolean).join(' \u00b7 ');
  return { text, iconURL };
}
function signEmbed(embed, user, extra) {
  return embed.setFooter(botFooter(user, extra)).setTimestamp();
}

function askEmbed(text, user, part, total) {
  const embed = new EmbedBuilder()
    .setColor(ASTURIO_EMBED_COLOR)
    .setDescription(text);
  return signEmbed(embed, user, total > 1 ? `Part ${part} of ${total}` : null);
}
function askErrorEmbed(text, user) {
  return signEmbed(new EmbedBuilder()
    .setColor(ASTURIO_ERROR_COLOR)
    .setDescription(text), user);
}

// -- Linked-account chat history -------------------------------------------
// A linked user's Discord conversation is written into the same asturioChats
// field the website reads, so a question asked here shows up in the panel and
// vice versa. Same trimming rules as the site, for the same reason: the whole
// user profile shares one 1 MiB document.
async function loadHistory(discordId) {
  // Reads the conversation shared with the site. Returns empty for anyone who
  // has not linked an account, which is the normal case, not an error.
  const sync = await getSyncHistory(discordId).catch(() => null);
  if (!sync) return { linked: false, history: [] };
  return {
    linked: true,
    history: sync.history.map(m => ({
      role: m.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(m.text ?? '') }],
    })),
  };
}

async function saveHistory(discordId, question, answer) {
  await appendSyncHistory(discordId, question, answer)
    .catch(e => console.warn('save history:', e.message));
}

// -- /economy: a weather-themed game, one save file per Discord user --------
// The rules themselves live in economy.mjs, pure and untestable-by-hand no
// more; this just reads and writes the Firestore record and turns the result
// into embeds. A missing record is not an error, it is just a player who has
// never played: everything below treats getEconomy() returning null as a
// fresh CAPE-0, pet-less, streak-0 account rather than a failure.
const TIER_COLORS = {
  bust: 0x808080, small: 0x63b3ed, decent: 0x48bb78,
  great: 0xed8936, legendary: 0xecc94b,
};
const ECONOMY_COLOR = 0xe8b800;
const ECONOMY_ERROR_COLOR = 0xff4d4d;

// The app's own gold, red and blue accents (index.html's --accent,
// --danger and --accent2), so the profile-style embeds don't all wear the
// same gold bar every time. Red appears twice as often as the other two,
// it's the app's current primary accent.
const ECONOMY_SIDEBAR_COLORS = [0xff1a00, 0xff1a00, 0xe8b800, 0x4ea2da];
function economySidebarColor() {
  return ECONOMY_SIDEBAR_COLORS[Math.floor(Math.random() * ECONOMY_SIDEBAR_COLORS.length)];
}

function blankEconomy() {
  return { cape: 0, lastChase: 0, chaseStreak: 0, petType: null,
           petName: null, petStage: 0, chases: 0, busts: 0 };
}

function petLine(eco) {
  if (!eco.petType) return 'No pet yet. Adopt one with `/economy adopt`.';
  const t = PET_TYPES[eco.petType];
  const stage = eco.petStage || 0;
  const name = eco.petName || t.label;
  const maxed = petIsMaxed(eco.petType, stage);
  const growth = maxed
    ? `${t.scaleName} maxed out`
    : `${t.scaleName}, next stage costs ${feedCost(stage)} ${CURRENCY_EMOJI}`;
  return `${t.emoji} **${name}** the ${t.label} - ${petStageLabel(eco.petType, stage)} (${growth})`;
}

async function handleEconomyProfile(i, eco) {
  const embed = new EmbedBuilder()
    .setColor(economySidebarColor())
    .setDescription(`# ${i.user.username}'s storm chasing profile\n${petLine(eco)}`)
    .addFields(
      { name: 'Balance', value: `${eco.cape} ${CURRENCY_EMOJI} ${CURRENCY_NAME}`, inline: true },
      { name: 'Chase streak', value: `${eco.chaseStreak || 0} day${eco.chaseStreak === 1 ? '' : 's'} (+${Math.round(streakBonus(eco.chaseStreak || 0) * 100)}% bonus)`, inline: true },
      { name: 'Chases / busts', value: `${eco.chases || 0} / ${eco.busts || 0}`, inline: true },
    );
  const wait = msUntilNextChase(eco.lastChase, Date.now());
  embed.addFields({ name: 'Next chase', value: wait > 0 ? `Ready in ${formatDuration(wait)}` : 'Ready now, run `/economy chase`' });
  signEmbed(embed, i.user);
  await i.reply({ embeds: [embed] });
}

async function handleEconomyChase(i, eco) {
  const now = Date.now();
  if (!canChase(eco.lastChase, now)) {
    const embed = new EmbedBuilder()
      .setColor(ECONOMY_ERROR_COLOR)
      .setDescription(`Still capped in. You can chase again in ${formatDuration(msUntilNextChase(eco.lastChase, now))}.`);
    signEmbed(embed, i.user);
    await i.reply({ embeds: [embed], ephemeral: true });
    return;
  }
  const roll = rollChase();
  const newStreak = computeStreak(eco.chaseStreak, eco.lastChase, now);
  const payout = applyStreakBonus(roll.baseCape, newStreak);
  const bonusPct = Math.round(streakBonus(newStreak) * 100);
  const update = {
    cape: (eco.cape || 0) + payout,
    lastChase: now,
    chaseStreak: newStreak,
    chases: (eco.chases || 0) + 1,
    busts: (eco.busts || 0) + (roll.tier === 'bust' ? 1 : 0),
  };
  await patchEconomy(i.user.id, update);
  const embed = new EmbedBuilder()
    .setColor(TIER_COLORS[roll.tier] || ECONOMY_COLOR)
    .setDescription(`# ${i.user.username} went storm chasing\n${roll.line}`)
    .addFields(
      { name: 'Result', value: payout > 0 ? `+${payout} ${CURRENCY_EMOJI}` : 'Nothing this time', inline: true },
      { name: 'Streak', value: `${newStreak} day${newStreak === 1 ? '' : 's'}${bonusPct > 0 ? ` (+${bonusPct}%)` : ''}`, inline: true },
      { name: 'Balance', value: `${update.cape} ${CURRENCY_EMOJI}`, inline: true },
    );
  signEmbed(embed, i.user);
  await i.reply({ embeds: [embed] });
}

async function handleEconomyAdopt(i, eco) {
  const type = i.options.getString('type', true);
  if (!isPetType(type)) {
    await i.reply({ content: 'That is not a pet this bot knows how to raise.', ephemeral: true });
    return;
  }
  if (eco.petType) {
    const embed = new EmbedBuilder()
      .setColor(ECONOMY_ERROR_COLOR)
      .setDescription(`You already have ${PET_TYPES[eco.petType].emoji} **${eco.petName || PET_TYPES[eco.petType].label}**. One storm at a time.`);
    signEmbed(embed, i.user);
    await i.reply({ embeds: [embed], ephemeral: true });
    return;
  }
  await patchEconomy(i.user.id, { petType: type, petStage: 0, petName: null });
  const t = PET_TYPES[type];
  const embed = new EmbedBuilder()
    .setColor(economySidebarColor())
    .setDescription(`# ${i.user.username} adopted a pet\n${t.emoji} A **${t.label}** touches down and decides to stick around. `
      + `It starts at **${t.stages[0]}** on the ${t.scaleName}. `
      + 'Name it with `/economy name`, grow it with `/economy feed`.');
  signEmbed(embed, i.user);
  await i.reply({ embeds: [embed] });
}

async function handleEconomyName(i, eco) {
  if (!eco.petType) {
    await i.reply({ content: 'You do not have a pet yet. Adopt one with `/economy adopt`.', ephemeral: true });
    return;
  }
  const nickname = i.options.getString('nickname', true).trim().slice(0, 40);
  if (!nickname) {
    await i.reply({ content: 'That name is empty once trimmed. Try a real one.', ephemeral: true });
    return;
  }
  await patchEconomy(i.user.id, { petName: nickname });
  const t = PET_TYPES[eco.petType];
  const embed = new EmbedBuilder()
    .setColor(economySidebarColor())
    .setDescription(`${t.emoji} Your ${t.label} is now named **${nickname}**.`);
  signEmbed(embed, i.user);
  await i.reply({ embeds: [embed] });
}

async function handleEconomyFeed(i, eco) {
  if (!eco.petType) {
    await i.reply({ content: 'You do not have a pet yet. Adopt one with `/economy adopt`.', ephemeral: true });
    return;
  }
  const stage = eco.petStage || 0;
  if (petIsMaxed(eco.petType, stage)) {
    const t = PET_TYPES[eco.petType];
    await i.reply({ content: `${t.emoji} ${eco.petName || t.label} is already at ${petStageLabel(eco.petType, stage)}, the top of the ${t.scaleName}. Nothing left to feed toward.`, ephemeral: true });
    return;
  }
  const cost = feedCost(stage);
  if ((eco.cape || 0) < cost) {
    await i.reply({ content: `Feeding costs ${cost} ${CURRENCY_EMOJI} and you have ${eco.cape || 0}. Go chase some more CAPE first.`, ephemeral: true });
    return;
  }
  const newStage = stage + 1;
  await patchEconomy(i.user.id, { cape: eco.cape - cost, petStage: newStage });
  const t = PET_TYPES[eco.petType];
  const embed = new EmbedBuilder()
    .setColor(economySidebarColor())
    .setDescription(`# ${eco.petName || t.label} grew\n${t.emoji} Fed for ${cost} ${CURRENCY_EMOJI}. **${eco.petName || t.label}** is now **${petStageLabel(eco.petType, newStage)}** on the ${t.scaleName}.`)
    .addFields({ name: 'Balance', value: `${eco.cape - cost} ${CURRENCY_EMOJI}` });
  signEmbed(embed, i.user);
  await i.reply({ embeds: [embed] });
}

async function handleEconomyLeaderboard(i) {
  const top = await queryTopEconomy(10);
  const medals = ['🥇', '🥈', '🥉'];
  const lines = top.length
    ? top.map((row, n) => `${medals[n] || `${n + 1}.`} <@${row.discordId}> - ${row.cape || 0} ${CURRENCY_EMOJI}`
        + (row.petType ? ` (${PET_TYPES[row.petType].emoji} ${row.petName || PET_TYPES[row.petType].label})` : ''))
    : ['Nobody has chased yet. Be the first with `/economy chase`.'];
  const embed = new EmbedBuilder()
    .setColor(economySidebarColor())
    .setDescription(`# Top storm chasers\n${lines.join('\n')}`);
  signEmbed(embed, i.user);
  await i.reply({ embeds: [embed] });
}

async function handleEconomy(i) {
  const sub = i.options.getSubcommand();
  const eco = { ...blankEconomy(), ...(await getEconomy(i.user.id).catch(() => null)) };
  if (sub === 'profile')     return handleEconomyProfile(i, eco);
  if (sub === 'chase')       return handleEconomyChase(i, eco);
  if (sub === 'adopt')       return handleEconomyAdopt(i, eco);
  if (sub === 'name')        return handleEconomyName(i, eco);
  if (sub === 'feed')        return handleEconomyFeed(i, eco);
  if (sub === 'leaderboard') return handleEconomyLeaderboard(i);
}

// -- Discord ---------------------------------------------------------------
// -- /map, built from what the site actually offers -------------------------
// The lists come from services/bot/map-options.json, which tools/extract-map-options.js
// reads out of index.html. Typed by hand they had already drifted: the command
// offered six radar products where the page shows five, and eight satellite
// bands where the page has sixteen.
//
// The generator takes only what a visitor can really click. The dual polarity
// radar products sit in the page commented out, so they are absent here too:
// a command that offered them would promise a picture nobody can see. That is
// the rule this file follows everywhere, and it is why nothing below is a
// literal list.
const MAP_OPTIONS = JSON.parse(
  readFileSync(new URL('./map-options.json', import.meta.url), 'utf8'));

// Discord allows 25 fixed choices on an option. Anything longer, and anything
// that takes several values at once, is completed as it is typed instead.
const CHOICE_LIMIT = 25;

function choicesFor(list) {
  return list.slice(0, CHOICE_LIMIT).map(p => ({
    name: (p.name || p.value).slice(0, 100), value: p.value,
  }));
}

// One command option per product family. Each row is
// [command option, list in map-options.json, URL parameter, description]:
// the command speaks the word a person would say ('satregion', 'wind') and
// the URL parameter is whatever the page happens to call it, translated in
// exactly one place. A family added to the site appears here on the next
// run of the generator with no edit to this file.
//
// Radar and satellite are NOT in this table. Both have too many real
// products for one 25-choice dropdown to hold honestly (radar alone is 19
// once Level 2, Level 3 and the composite mosaic are counted for real,
// rather than the 6 the command used to offer), so each gets its own pair
// of linked options below instead: a type, then a product scoped to it.
const FAMILY_OPTIONS = [
  ['satregion',  'satregions',  'satregion',  'Satellite view: CONUS, meso box, full disk, world sector'],
  ['wind',       'wind',        'wind',       'Wind product'],
  ['temperature','temperature', 'temperature','Temperature product'],
  ['waves',      'waves',       'waves',      'Wave product'],
  ['air',        'air',         'air',        'Air quality product'],
  ['pressure',   'pressure',    'pressure',   'Pressure product'],
];

// The three radar menus and the three satellite menus, named the way the
// site itself names them (PR_LEVELS, and the chNN/rgb-/glb- id prefixes the
// generator already splits satellite on). Picking one of these alone does
// nothing; it only scopes what radar-product/satellite-product complete to.
const RADAR_TYPES = [
  { value: 'l2',        name: 'Level 2 (single station, full detail)' },
  { value: 'l3',        name: 'Level 3 (single station, lighter)' },
  { value: 'composite', name: 'Composite (national mosaic)' },
];
const SATELLITE_TYPES = [
  { value: 'band',      name: 'ABI Band (ch01-ch16)' },
  { value: 'composite', name: 'RGB Composite' },
  { value: 'global',    name: 'Global Mosaic' },
];

// Every string option the /map handler reads, family and plain alike, so the
// handler and the validator never chase a list of names by hand again.
const MAP_STRING_OPTIONS = [
  'place', 'basemap', 'layers', 'overlays', 'spchaz', 'cpctype',
  'radar-type', 'radar-product', 'satellite-type', 'satellite-product',
  ...FAMILY_OPTIONS.map(f => f[0]),
];
const MAP_INT_OPTIONS = ['zoom', 'spcday', 'wpcday', 'fwday'];

function addFamilyOption(c, name) {
  const row = FAMILY_OPTIONS.find(f => f[0] === name);
  const list = MAP_OPTIONS.families[row[1]] || MAP_OPTIONS[row[1]] || [];
  if (!list.length) return c;
  return c.addStringOption(o => {
    o.setName(row[0]).setDescription(row[3]);
    // Past 25 choices Discord insists it be typed, hence autocomplete.
    if (list.length <= CHOICE_LIMIT) o.addChoices(...choicesFor(list));
    else o.setAutocomplete(true);
    return o;
  });
}

function mapCommand() {
  // Ordered the way someone builds a picture: where, then the main picture
  // (radar or satellite), then what to draw on top, then the fine print.
  let c = new SlashCommandBuilder()
    .setName('map')
    .setDescription('Post a picture of the radar map')
    .addStringOption(o => o.setName('place')
      .setDescription('Where to look')
      .addChoices(...choicesFor(
        Object.keys(PLACES).map(k => ({ value: k, name: k })))));

  // Radar and satellite: a type first (choices, always short), then a
  // product scoped to it (typed and autocompleted, since even one menu -
  // satellite's 16 bands, or radar's 11 Level 3 products - can run past
  // what a plain dropdown holds). Picking a type alone does nothing; it
  // only narrows what the product option completes to.
  c = c
    .addStringOption(o => o.setName('radar-type')
      .setDescription('Which radar menu: Level 2, Level 3, or the composite mosaic')
      .addChoices(...choicesFor(RADAR_TYPES)))
    .addStringOption(o => o.setName('radar-product')
      .setDescription('Radar product within radar-type. Switches radar on by itself')
      .setAutocomplete(true))
    .addStringOption(o => o.setName('satellite-type')
      .setDescription('Which satellite menu: an ABI band, an RGB composite, or the global mosaic')
      .addChoices(...choicesFor(SATELLITE_TYPES)))
    .addStringOption(o => o.setName('satellite-product')
      .setDescription('Satellite product within satellite-type')
      .setAutocomplete(true));

  c = addFamilyOption(c, 'satregion');

  // Several at once, so completed as typed rather than picked from a list.
  c = c
    .addStringOption(o => o.setName('layers')
      .setDescription(`Comma separated. ${MAP_OPTIONS.layers.length} available`)
      .setAutocomplete(true))
    .addStringOption(o => o.setName('overlays')
      .setDescription(`Comma separated. ${MAP_OPTIONS.overlays.length} available`)
      .setAutocomplete(true))
    // The outlook dials. Naming any of these switches its overlay on by
    // itself, the same way naming a radar product switches radar on.
    .addIntegerOption(o => o.setName('spcday')
      .setDescription('SPC outlook day. Switches the SPC outlook on')
      .setMinValue(1).setMaxValue(8))
    .addStringOption(o => o.setName('spchaz')
      .setDescription('SPC hazard view. Switches the SPC outlook on')
      .addChoices(
        { name: 'Categorical',              value: 'cat'  },
        { name: 'Tornado',                  value: 'torn' },
        { name: 'Wind',                     value: 'wind' },
        { name: 'Hail',                     value: 'hail' },
        { name: 'Probabilistic (day 4-8)',  value: 'prob' },
      ))
    .addIntegerOption(o => o.setName('wpcday')
      .setDescription('WPC excessive rain day. Switches the WPC outlook on')
      .setMinValue(1).setMaxValue(3))
    .addIntegerOption(o => o.setName('fwday')
      .setDescription('SPC fire weather day. Switches the fire outlook on')
      .setMinValue(1).setMaxValue(2))
    .addStringOption(o => o.setName('cpctype')
      .setDescription('CPC extended outlook. Switches the CPC outlook on')
      .addChoices(...choicesFor(MAP_OPTIONS.cpctypes || [])));

  for (const [name] of FAMILY_OPTIONS) {
    if (name === 'satregion') continue;
    c = addFamilyOption(c, name);
  }

  return c
    .addStringOption(o => o.setName('basemap')
      .setDescription('Basemap style')
      .addChoices(...choicesFor(
        MAP_OPTIONS.basemaps.map(b => ({ value: b, name: b })))))
    .addNumberOption(o => o.setName('lat')
      .setDescription('Latitude, overrides place'))
    .addNumberOption(o => o.setName('lon')
      .setDescription('Longitude, overrides place'))
    .addIntegerOption(o => o.setName('zoom')
      .setDescription('Zoom, 3 to 12').setMinValue(3).setMaxValue(12));
}

// What each autocompleting option is completing against. radar-product and
// satellite-product take the interaction's own current options so they can
// read the sibling -type value and complete against only that menu; every
// other source ignores the argument, plain functions of no arguments.
const AUTOCOMPLETE_SOURCE = {
  layers:   () => MAP_OPTIONS.layers.map(v => ({ value: v, name: v })),
  overlays: () => MAP_OPTIONS.overlays,
  'radar-product': (opts) => {
    const type = (opts && opts.getString('radar-type')) || 'l2';
    return MAP_OPTIONS.families.radar[type] || [];
  },
  'satellite-product': (opts) => {
    const type = (opts && opts.getString('satellite-type')) || 'band';
    return MAP_OPTIONS.satelliteTypes[type] || [];
  },
  ...Object.fromEntries(FAMILY_OPTIONS.map(([opt, fam]) =>
    [opt, () => MAP_OPTIONS.families[fam] || MAP_OPTIONS[fam] || []])),
};

// Completes the value being typed, not the whole string: these take a comma
// separated list, so what is being finished is whatever follows the last comma
// and everything before it has to be handed back untouched.
function completeList(optName, typed, opts) {
  const list = (AUTOCOMPLETE_SOURCE[optName] || (() => []))(opts);
  const multi = optName === 'layers' || optName === 'overlays';
  const cut = multi ? typed.lastIndexOf(',') : -1;
  const head = cut >= 0 ? typed.slice(0, cut + 1) : '';
  const tail = (cut >= 0 ? typed.slice(cut + 1) : typed).trim().toLowerCase();
  const already = new Set(head.split(',').map(x => x.trim()).filter(Boolean));

  return list
    .filter(p => !already.has(p.value))
    .filter(p => !tail
      || p.value.toLowerCase().includes(tail)
      || (p.name || '').toLowerCase().includes(tail))
    .slice(0, CHOICE_LIMIT)
    .map(p => ({
      name: `${p.name || p.value}`.slice(0, 100),
      // Discord rejects a value over 100 characters, and a long list of
      // overlays reaches that, so the completion is dropped rather than the
      // whole box being refused.
      value: (head + p.value).slice(0, 100),
    }));
}

// Anything the site does not offer is refused here rather than quietly
// producing a picture without it. Silently ignoring a name is how someone ends
// up believing a layer is switched on when it never was.
function validateMapOptions(opt) {
  const bad = [];
  const check = (name, wanted, list) => {
    if (!wanted) return;
    for (const v of String(wanted).split(',').map(x => x.trim()).filter(Boolean)) {
      if (!list.includes(v)) bad.push(`${name}: ${v}`);
    }
  };
  check('layer', opt.layers, MAP_OPTIONS.layers);
  check('overlay', opt.overlays, MAP_OPTIONS.overlays.map(o => o.value));
  check('basemap', opt.basemap, MAP_OPTIONS.basemaps);
  check('spchaz', opt.spchaz, ['cat', 'torn', 'wind', 'hail', 'prob']);
  check('cpctype', opt.cpctype, (MAP_OPTIONS.cpctypes || []).map(c => c.value));
  if (opt.place && !(String(opt.place).toLowerCase() in PLACES)) {
    bad.push(`place: ${opt.place}`);
  }
  for (const [name, family] of FAMILY_OPTIONS) {
    const list = (MAP_OPTIONS.families[family] || MAP_OPTIONS[family] || [])
      .map(p => p.value);
    check(name, opt[name], list);
  }
  // Checked against the union of every menu rather than only the one named
  // in -type: someone can leave -type unset and still type a valid product
  // (the type is just what autocomplete narrows to, not a hard gate), and
  // refusing that would be exactly the "the site has this but the command
  // won't let you ask for it" bug the whole reorganisation set out to fix.
  check('radar-type', opt['radar-type'], RADAR_TYPES.map(t => t.value));
  check('radar-product', opt['radar-product'],
    Object.values(MAP_OPTIONS.families.radar).flat().map(p => p.value));
  check('satellite-type', opt['satellite-type'], SATELLITE_TYPES.map(t => t.value));
  check('satellite-product', opt['satellite-product'],
    Object.values(MAP_OPTIONS.satelliteTypes).flat().map(p => p.value));
  return bad;
}

// -- /economy -------------------------------------------------------------
// The game itself lives in economy.mjs, pure and Discord-free. This just
// shapes it into a slash command, exactly the way mapCommand() above shapes
// map-options.json into /map. Pet type choices are written out by hand
// rather than generated from economy.mjs: there are exactly three, they are
// never going to change without a deliberate edit here anyway, and it keeps
// this function free of any import this file's own test harness would have
// to know how to resolve from a data: URL module.
function economyCommand() {
  return new SlashCommandBuilder()
    .setName('economy')
    .setDescription('Storm chasing economy: earn CAPE, adopt a pet, grow it into a legend')
    .addSubcommand(s => s.setName('profile')
      .setDescription('Your CAPE balance, your pet, and your chase streak'))
    .addSubcommand(s => s.setName('chase')
      .setDescription('Go storm chasing for CAPE. Once every 20 hours'))
    .addSubcommand(s => s.setName('adopt')
      .setDescription('Adopt a pet: a supercell, a tornado, or a hurricane')
      .addStringOption(o => o.setName('type')
        .setDescription('Which one').setRequired(true)
        .addChoices(
          { name: 'Supercell', value: 'supercell' },
          { name: 'Tornado', value: 'tornado' },
          { name: 'Hurricane', value: 'hurricane' },
        )))
    .addSubcommand(s => s.setName('name')
      .setDescription('Give your pet a name')
      .addStringOption(o => o.setName('nickname')
        .setDescription('The new name').setRequired(true)))
    .addSubcommand(s => s.setName('feed')
      .setDescription("Spend CAPE to grow your pet to its next stage"))
    .addSubcommand(s => s.setName('leaderboard')
      .setDescription('Top CAPE balances across the server'));
}

const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Asturio a weather question')
    .addStringOption(o => o.setName('question')
      .setDescription('What do you want to know?').setRequired(true))
    .addAttachmentOption(o => o.setName('image')
      .setDescription('A picture for Asturio to look at').setRequired(false)),
  new SlashCommandBuilder()
    .setName('alerts')
    .setDescription('Current nationwide NWS alert summary'),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link this Discord account to your GWCFC Radar account')
    .addStringOption(o => o.setName('code')
      .setDescription('The code shown in your profile on the site').setRequired(true)),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Disconnect this Discord account from GWCFC Radar'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription("Change Asturio's status (password required)")
    .addStringOption(o => o.setName('text')
      .setDescription('What the status should say').setRequired(true))
    .addStringOption(o => o.setName('password')
      .setDescription('The status password').setRequired(true))
    .addStringOption(o => o.setName('type')
      .setDescription('How it reads. Default: Watching').setRequired(false)
      .addChoices(
        { name: 'Watching',  value: 'watching'  },
        { name: 'Playing',   value: 'playing'   },
        { name: 'Listening to', value: 'listening' },
        { name: 'Competing in', value: 'competing' },
        { name: 'Custom (no prefix)', value: 'custom' },
      ))
    .addStringOption(o => o.setName('presence')
      .setDescription('The dot beside the name. Default: online').setRequired(false)
      .addChoices(
        { name: 'Online',        value: 'online'    },
        { name: 'Idle',          value: 'idle'      },
        { name: 'Do Not Disturb', value: 'dnd'      },
        { name: 'Invisible',     value: 'invisible' },
      )),
  mapCommand(),
  economyCommand(),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  // Guild commands appear instantly; global ones can take an hour to propagate,
  // which is miserable while setting up. Set DISCORD_GUILD_ID for your server.
  //
  // Whichever scope is NOT being used here is cleared too, not just left
  // alone. rest.put replaces the command set within one scope, but does
  // nothing to the other one - so a bot first run without DISCORD_GUILD_ID
  // (registering globally), then run again after it was set (registering to
  // the guild instead), ended up with BOTH still live: Discord shows global
  // and guild commands together in a server, so every single command - map,
  // link, all of them - showed up twice rather than the new registration
  // replacing the old.
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log(`Registered to guild ${GUILD_ID}, and cleared any leftover global commands.`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered globally. Can take up to an hour to show up.');
    console.log('Set DISCORD_GUILD_ID in .env for instant registration while testing.');
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // needs "Message Content Intent" enabled
  ],
  partials: [Partials.Channel],
});

// -- The bot's own status ----------------------------------------------------
// Changed from Discord with /status, behind a password, and remembered here so
// a restart does not quietly put the old one back.
//
// The password comes from the environment and NOWHERE else. This repository
// is public: a fallback value written here would be a password anyone can
// read, which is no password at all - and while one was written here, the
// value was public knowledge. Set STATUS_PASSWORD in services/bot/.env
// (never committed); until then the command answers that it is off.
const STATUS_PASSWORD = process.env.STATUS_PASSWORD || '';
const STATUS_FILE = new URL('./status.json', import.meta.url);

const ACTIVITY_KINDS = {
  playing:   ActivityType.Playing,
  watching:  ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom:    ActivityType.Custom,
};

// Compared byte for byte in constant time, so the answer cannot be found one
// character at a time by timing the replies. No password set means the
// command is OFF, never open: this repository is public, so a fallback
// written here would be a password anyone can read, which is no password
// at all (and exactly how the old fallback worked).
function passwordOk(given) {
  if (!STATUS_PASSWORD) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(STATUS_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function applyStatus(user, s) {
  const type = ACTIVITY_KINDS[s.kind] ?? ActivityType.Watching;
  // A custom status shows its text from state rather than name, which is the
  // one activity type that does not read its own label.
  const activity = type === ActivityType.Custom
    ? { name: 'custom', state: s.text, type }
    : { name: s.text, type };
  user.setPresence({ activities: [activity], status: s.presence || 'online' });
}

function saveStatus(s) {
  try { writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2)); } catch (e) {
    console.warn('status save:', e.message);
  }
}

function loadStatus() {
  try {
    if (existsSync(STATUS_FILE)) return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
  } catch (e) { console.warn('status read:', e.message); }
  return { text: 'the radar', kind: 'watching', presence: 'online' };
}

// -- The face --------------------------------------------------------------
// The bot answered as a default grey circle with a letter in it, which is
// what an unconfigured bot looks like. It shares a brain and a name with the
// assistant in the app, so it should share a face: assets/img/asturio-ai.png,
// the app's own concentric rings lit as an instrument, built by
// tools/make-asturio-avatar.mjs.
//
// Uploaded once, not on every start, and this is not tidiness. Discord rate
// limits avatar changes hard, in the region of twice an hour, and a bot that
// re-uploads on every restart will be refused and then cannot change it when
// it matters. So a marker file records the picture that was sent, and the
// upload only happens when that differs from the file on disk.
//
// Every failure here is swallowed. A weather bot that will not answer because
// it could not change its profile picture is worse than one with the wrong
// picture.
const AVATAR_FILE  = new URL('../../assets/img/asturio-ai-512.png', import.meta.url);
const AVATAR_STAMP = new URL('./.avatar-stamp', import.meta.url);

async function applyAvatar(user) {
  let png;
  try { png = readFileSync(AVATAR_FILE); }
  catch (e) {
    console.warn('avatar: no picture to set (' + e.message + '), leaving it alone.');
    return;
  }
  // The stamp is the picture's own size and a hash of its bytes, so replacing
  // the art is what triggers a re-upload and a restart on its own is not.
  const stamp = png.length + ':' + createHash('sha256').update(png).digest('hex').slice(0, 16);
  let had = null;
  try { if (existsSync(AVATAR_STAMP)) had = readFileSync(AVATAR_STAMP, 'utf8').trim(); }
  catch (e) { /* an unreadable stamp is the same as no stamp */ }
  if (had === stamp) return;
  try {
    await user.setAvatar(png);
    writeFileSync(AVATAR_STAMP, stamp);
    console.log('Avatar set from assets/img/asturio-ai-512.png');
  } catch (e) {
    // The usual cause is Discord's own rate limit, which is temporary and
    // says so, so this is a note rather than a warning about broken config.
    console.log('Avatar not changed this time (' + e.message + '). '
              + 'Discord limits how often a bot may change it; it will try '
              + 'again next start.');
  }
}

client.once(Events.ClientReady, async c => {
  console.log(`Asturio online as ${c.user.tag}`);
  const s = loadStatus();
  applyStatus(c.user, s);
  console.log(`Status: ${s.kind} "${s.text}" (${s.presence || 'online'})`);
  await applyAvatar(c.user);
  if (ROSTER_SWEEP) rosterSweep(c).catch(e => console.error('roster sweep:', e.message || e));
});

// The whole membership at once, for people who have switched the Server
// Members Intent on. Opt-in because without that intent the fetch returns
// almost nothing, and asking for an intent that has not been granted stops
// the bot dead rather than degrading. Repeated hourly so someone who joins
// today does not have to speak before they can be pinged.
async function rosterSweep(c) {
  for (const guild of c.guilds.cache.values()) {
    const members = await guild.members.fetch();
    let n = 0;
    for (const member of members.values()) {
      if (member.user.bot) continue;
      // Sequential rather than a flood of parallel writes: this is a
      // background nicety and has no business competing with the chat bridge
      // for the same Firestore quota.
      await upsertRosterEntry({
        id: member.user.id,
        name: member.displayName || member.user.globalName || member.user.username,
        avatar: member.user.displayAvatarURL({ extension: 'png', size: 64 }),
      }).catch(() => {});
      n++;
    }
    console.log(`Roster: ${n} people from ${guild.name}`);
  }
  setTimeout(() => rosterSweep(c).catch(() => {}), 60 * 60 * 1000);
}

client.on(Events.InteractionCreate, async (i) => {
  // Completion runs on every keystroke and Discord gives it three seconds, so
  // it answers from the list in memory and never touches the network.
  if (i.isAutocomplete()) {
    try {
      const focused = i.options.getFocused(true);
      await i.respond(completeList(focused.name, String(focused.value || ''), i.options));
    } catch (e) {
      // A failed completion must not look like a failed command.
      console.warn('autocomplete:', e.message);
    }
    return;
  }
  if (!i.isChatInputCommand()) return;
  // Running any command is being seen, which is how somebody who reads more
  // than they type still ends up pingable from the map.
  rememberPerson(i.user, i.member);
  try {
    if (i.commandName === 'alerts') {
      await i.deferReply();
      const summary = await fetchAlerts();
      for (const [n, part] of chunk(summary).entries()) {
        n === 0 ? await i.editReply(part) : await i.followUp(part);
      }
      return;
    }
    if (i.commandName === 'status') {
      // Ephemeral, and that is not decoration: an ephemeral reply keeps the
      // whole interaction, the typed password included, visible only to the
      // person who ran it. A public reply would print the password in chat.
      await i.deferReply({ ephemeral: true });
      if (!STATUS_PASSWORD) {
        return i.editReply('This command is switched off: no STATUS_PASSWORD '
          + 'is set in services/bot/.env on the parsing server. Set one and restart the bot.');
      }
      if (!passwordOk(i.options.getString('password', true))) {
        console.warn(`status refused for ${i.user.tag}`);
        return i.editReply('Wrong password, so nothing changed.');
      }
      const s = {
        text: i.options.getString('text', true).slice(0, 128),
        kind: i.options.getString('type') || 'watching',
        presence: i.options.getString('presence') || 'online',
      };
      try {
        applyStatus(client.user, s);
      } catch (e) {
        return i.editReply(`Discord refused that status: ${e.message}`);
      }
      saveStatus(s);            // so a restart keeps it
      const shown = s.kind === 'custom' ? s.text
        : `${s.kind === 'listening' ? 'Listening to'
           : s.kind === 'competing' ? 'Competing in'
           : s.kind[0].toUpperCase() + s.kind.slice(1)} ${s.text}`;
      console.log(`status set by ${i.user.tag}: ${s.kind} "${s.text}" (${s.presence})`);
      return i.editReply(`Status set: **${shown}** · ${s.presence}\n`
        + 'It sticks through restarts, and only you can see this reply.');
    }
    if (i.commandName === 'map') {
      const asked = Object.fromEntries([
        ...MAP_STRING_OPTIONS.map(k => [k, i.options.getString(k)]),
        ...MAP_INT_OPTIONS.map(k => [k, i.options.getInteger(k)]),
      ]);
      // Refused rather than quietly dropped: silently ignoring a name is how
      // someone ends up believing a layer is on when it never was.
      const bad = validateMapOptions(asked);
      if (bad.length) {
        await i.reply({
          content: `The site does not have ${bad.join(', ')}. `
                 + 'Start typing and it will offer what does exist.',
          ephemeral: true,
        });
        return;
      }
      // Launching a browser and waiting for tiles runs well past Discord's
      // three second reply window.
      await i.deferReply();
      const { image, url } = await screenshotMap({
        ...asked,
        z:   asked.zoom,
        lat: i.options.getNumber('lat'),
        lon: i.options.getNumber('lon'),
      });
      return i.editReply({
        content: `<${url}>`,
        files: [{ attachment: image, name: 'radar.jpg' }],
      });
    }

    if (i.commandName === 'link') {
      const code = i.options.getString('code', true).trim().toUpperCase();
      await i.deferReply({ ephemeral: true });   // the code is a credential, keep it out of the channel
      const found = await getLinkCode(code);
      if (!found)        return i.editReply('No account is waiting on that code. Generate a fresh one in your profile on the site.');
      if (found.expired) return i.editReply('That code has expired. Codes last 10 minutes, so generate a new one.');
      if (found.claimed) return i.editReply('That code has already been used. Generate a fresh one.');
      await claimLinkCode(code, i.user.id, i.user.username);
      // The browser finishes the job, because only it can write to the account.
      return i.editReply('Claimed. The site finishes linking within a second or two, so leave that page open. '
        + 'If nothing happens there, the page was closed and the code needs generating again.');
    }

    if (i.commandName === 'unlink') {
      // Unlinking means clearing a field on the account, and the bot has no
      // access to accounts: it signs in anonymously and the rules let only the
      // owner write their own document. Attempting it produced a bare 403.
      // Saying where to go is honest and takes the same one click.
      await i.deferReply({ ephemeral: true });
      return i.editReply('Unlink from your profile on the site, under the Discord section: '
        + `${SITE_URL}\nOnly you can change your own account, which is why this cannot do it for you.`);
    }

    if (i.commandName === 'ask') {
      const q = i.options.getString('question', true);
      const shot = i.options.getAttachment('image');
      // Answers take several seconds, well past Discord's 3 second window.
      await i.deferReply();
      const [user, recent, prior, images] = await Promise.all([
        getUserContext(i.user, i.guild),
        getRecentMessages(i.channel),
        loadHistory(i.user.id).catch(() => ({ linked: false, history: [] })),
        imageParts(shot ? [shot] : []),
      ]);
      const answer = await askAsturio(q, { user, server: serverContextOf(i.guild), recent }, prior.history, images);
      saveHistory(i.user.id, q, answer).catch(() => {});
      const parts = chunk(answer, ASK_CHUNK_LIMIT);
      for (const [n, part] of parts.entries()) {
        const embed = askEmbed(part, i.user, n + 1, parts.length);
        n === 0 ? await i.editReply({ embeds: [embed] }) : await i.followUp({ embeds: [embed] });
      }
    }

    if (i.commandName === 'economy') {
      await handleEconomy(i);
    }
  } catch (e) {
    console.error('interaction:', e);
    const msg = `Could not answer that: ${e.message}`;
    try { i.deferred ? await i.editReply(msg) : await i.reply({ content: msg, ephemeral: true }); }
    catch {}
  }
});

// -- CHAT BRIDGE: Discord -> radar -------------------------------------------
// Set CHAT_CHANNEL_ID to the channel that should be mirrored onto the map.
// Everything said there (by people, not bots) is copied into Firestore, which
// the website is listening to live.
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID || '';

// -- Who the website is allowed to ping --------------------------------------
//
// The site has no Discord token and a webhook can only post, so it cannot ask
// the server who is in it. The bot writes the list instead.
//
// By default this is "everyone the bot has actually seen": whoever speaks in
// the bridged channel, whoever runs a command, whoever links their account.
// That needs no privileged intent, which matters, because the alternative
// (asking Discord for the whole member list) requires the Server Members
// Intent, and a bot asking for an intent it has not been granted does not
// degrade, it refuses to start. Growing the list from real activity cannot
// break anything, and after a day of chat it is most of the active server.
//
// Set ROSTER_SWEEP=1 only if you have switched the Server Members Intent on
// in the Discord developer portal AND added GuildMembers to the intents
// below; then the whole membership is listed from the first minute.
const ROSTER_SWEEP = process.env.ROSTER_SWEEP === '1';

// Not awaited by anything that matters. Remembering a name is a convenience;
// failing to remember one must never cost the message that triggered it.
function rememberPerson(user, member) {
  if (!user || user.bot) return;
  upsertRosterEntry({
    id: user.id,
    name: member?.displayName || user.globalName || user.username,
    avatar: user.displayAvatarURL({ extension: 'png', size: 64 }),
  }).catch(e => console.error('roster:', e.message || e));
}

// Discord sends mentions down the wire as <@123>, not as a name. Written
// straight into Firestore that is what the website would show: a row reading
// "<@844029301...>" where a name belongs. So every mention is resolved to the
// name that person actually goes by here, and the ids are kept alongside so
// the site can tell whether the ping was aimed at the reader.
function resolveMentions(m) {
  let text = m.content || '';
  const found = [];
  for (const [id, user] of m.mentions.users) {
    const member = m.mentions.members?.get(id) || null;
    const name = member?.displayName || user.globalName || user.username;
    // Both spellings: <@id> and the older <@!id> nickname form, which older
    // clients still send and which would otherwise be left as raw text.
    text = text.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
    found.push({ id, name });
  }
  // Roles and @everyone are turned into plain readable words rather than
  // resolved: the site has no role list, and leaving the raw token would
  // print an id at somebody.
  for (const [id, role] of (m.mentions.roles || [])) {
    text = text.replace(new RegExp(`<@&${id}>`, 'g'), `@${role.name}`);
  }
  return { text: text.trim(), mentions: found };
}

client.on(Events.MessageCreate, async (m) => {
  if (!CHAT_CHANNEL_ID || m.channelId !== CHAT_CHANNEL_ID) return;
  // Messages the website sent arrive here as webhook posts. Relaying those back
  // would copy every website message into Firestore a second time, so the
  // webhookId check is what stops the bridge feeding itself in a loop.
  if (m.webhookId) return;
  if (m.author.bot) return;
  // Seeing somebody speak is how they become pingable from the map. This runs
  // before the empty-text check on purpose: a person who only ever posts
  // pictures is still a person somebody may want to ping.
  rememberPerson(m.author, m.member);
  const { text, mentions } = resolveMentions(m);
  if (!text) return;   // attachment-only posts have nothing to show on the map
  try {
    await addChatMessage({
      text: text.slice(0, 500),
      name: m.member?.displayName || m.author.globalName || m.author.username,
      discordId: m.author.id,
      avatar: m.author.displayAvatarURL({ extension: 'png', size: 64 }),
      mentions,
    });
  } catch (e) {
    console.error('chat bridge (Discord -> radar):', e.message || e);
  }
});

// Mentioning the bot works too, so people do not have to learn the commands.
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !client.user) return;
  if (!m.mentions.has(client.user)) return;
  let q = m.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

  // Pictures come from the message itself, and failing that from the message
  // being replied to: "@Asturio what is this?" said over someone's screenshot
  // is about that screenshot.
  const sources = [...m.attachments.values()];
  if (!sources.some(a => IMAGE_TYPES.test(a.contentType || '')) && m.reference?.messageId) {
    try {
      const ref = await m.channel.messages.fetch(m.reference.messageId);
      sources.push(...ref.attachments.values());
    } catch {}
  }

  const promptEmbed = () => askEmbed(`Ask me something, or use /ask. Live map: ${SITE_URL}`, m.author, 1, 1);
  if (!q && !sources.length) { await m.reply({ embeds: [promptEmbed()] }); return; }
  try {
    await m.channel.sendTyping();
    const [user, recent, prior, images] = await Promise.all([
      getUserContext(m.author, m.guild),
      getRecentMessages(m.channel),
      loadHistory(m.author.id).catch(() => ({ linked: false, history: [] })),
      imageParts(sources),
    ]);
    if (!q && !images.length) { await m.reply({ embeds: [promptEmbed()] }); return; }
    // A bare picture is a question in itself.
    if (!q) q = 'What does this image show? If it is weather, say what is happening and where.';
    const answer = await askAsturio(q, { user, server: serverContextOf(m.guild), recent }, prior.history, images);
    saveHistory(m.author.id, q, answer).catch(() => {});
    const parts = chunk(answer, ASK_CHUNK_LIMIT);
    for (const [n, part] of parts.entries()) await m.reply({ embeds: [askEmbed(part, m.author, n + 1, parts.length)] });
  } catch (e) {
    // One line. A stack trace per mention buries everything else in the log
    // and tells nobody anything the message does not already say.
    console.error('mention:', e.message || e);
    await m.reply({ embeds: [askErrorEmbed(`Could not answer that: ${e.message}`, m.author)] }).catch(() => {});
  }
});

process.on('unhandledRejection', e => console.error('unhandled:', e));

// A clean way out. systemd stops a service with SIGTERM and waits; with no
// handler, the warm Chromium and the Discord gateway connection kept the
// process alive until systemd gave up and SIGKILLed it, so every restart
// ended "Failed with result 'timeout'". Close what is open and leave.
let _stopping = false;
async function shutdown(signal) {
  if (_stopping) return;
  _stopping = true;
  console.log(`${signal}: shutting down`);
  const jobs = [];
  if (_browser) jobs.push(_browser.close().catch(() => {}));
  try { jobs.push(Promise.resolve(client.destroy()).catch(() => {})); } catch {}
  // Whatever refuses to close in five seconds is abandoned; exiting IS the
  // point, and systemd's own kill would be no gentler.
  await Promise.race([Promise.allSettled(jobs),
                      new Promise(res => setTimeout(res, 5000))]);
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });

// The warm browser earns its memory while screenshots are flowing and is
// pure cost the rest of the day: a dozen Chromium processes sitting on
// about:blank for hours. Reused within ten minutes, closed after.
const BROWSER_IDLE_MS = 10 * 60 * 1000;
let _browserLastUse = 0;
setInterval(() => {
  if (_browser && _browserLastUse
      && Date.now() - _browserLastUse > BROWSER_IDLE_MS) {
    const b = _browser;
    _browser = null;
    b.close().catch(() => {});
    console.log('screenshot browser closed after idling');
  }
}, 60 * 1000).unref();

// Discord answers a bad token with "No Description", which explains nothing, so
// both failure paths get a message that actually says what to check.
await registerCommands().catch(e => {
  console.error('Command registration failed:', e.message || e);
  console.error('Usually means the token is wrong, or DISCORD_CLIENT_ID belongs to a different application.');
});

try {
  await client.login(TOKEN);
} catch (e) {
  console.error('\nCould not log in:', e.message || e);
  console.error('Check that DISCORD_TOKEN in .env is the CURRENT token.');
  console.error('Resetting the token in the Developer Portal invalidates the old one immediately.');
  process.exit(1);
}
