# Asturio Discord Bot

Runs Asturio AI in Discord from your laptop. It uses the **same Cloudflare Worker
the website uses**, so there's no Gemini API key on your machine, the only
secret you need is a Discord bot token.

Before answering, it pulls live **NWS alerts** and **SPC storm reports** (the same
sources the map uses) so replies are grounded in what's actually happening rather
than the model's recall.

---

## One-time setup

### 1. Install Node

Needs **Node 20.6 or newer** (for built-in `.env` support). Check:

```bash
node -v
```

If it's older or missing, get it from https://nodejs.org (take the LTS build).

### 2. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**
2. Name it *Asturio*, hit Create
3. **General Information** → copy the **Application ID**, that's your `DISCORD_CLIENT_ID`
4. **Bot** (left sidebar) → **Reset Token** → copy it, that's your `DISCORD_TOKEN`
   - This is shown **once**. If you lose it, reset again.
5. Still on **Bot**, scroll to **Privileged Gateway Intents** and turn on
   **MESSAGE CONTENT INTENT**. Without it, @mentioning the bot won't work
   (slash commands still will).

### 3. Invite it to your server

**Installation** (left sidebar) → under *Install Link* pick **Discord Provided Link**,
set scopes `bot` and `applications.commands`, and permissions:
**Send Messages**, **Read Message History**, **Use Slash Commands**.
Open the generated link and pick your server.

### 4. Configure

```bash
cd bot
cp .env.example .env
```

Open `.env` and paste in your token and application ID.

Also set `DISCORD_GUILD_ID` to your server's ID, with it, slash commands appear
**instantly**; without it, Discord can take up to an hour to publish them.
To get it: Discord Settings → Advanced → **Developer Mode** on, then right-click
your server icon → **Copy Server ID**.

`.env` is already in `.gitignore`. Don't commit it.

### 5. Install and run

```bash
npm install
npm start
```

You should see:

```
Registered /ask and /alerts to guild 123...
Asturio online as Asturio#1234
```

Leave the terminal open, the bot is only online while it's running.
`Ctrl+C` stops it.

---

## Using it

| | |
|---|---|
| `/ask <question>` | Ask anything weather-related |
| `/alerts` | Nationwide NWS alert summary |
| `@Asturio <question>` | Same as `/ask`, just by mention |
| `/economy profile` | Your CAPE balance, your pet, and your chase streak |
| `/economy chase` | Go storm chasing for CAPE, once every 20 hours |
| `/economy adopt <type>` | Adopt a pet: a supercell, a tornado, or a hurricane |
| `/economy name <nickname>` | Give your pet a name |
| `/economy feed` | Spend CAPE to grow your pet to its next stage |
| `/economy leaderboard` | Top CAPE balances across the server |

Answers take a few seconds because it fetches live data first, so the bot defers
the reply, that's the "thinking" state, not a hang.

Every reply Asturio gives, from `/ask` or from a plain `@Asturio` mention, goes
out as a Discord embed rather than plain chat text, so it reads as Asturio
speaking rather than an undecorated wall of text. `/economy` is the same:
a weather-themed little economy, one save file per Discord user. Every chaser
gets a CAPE balance (Convective Available Potential Energy, the number every
real chaser actually watches) and can adopt one pet: a supercell, a tornado,
or a hurricane, each one growing through the real scale chasers use for it
(EF Scale, Saffir-Simpson, and hail size). Chasing pays out on a weighted
table where most days are, honestly, a bust, same as the real hobby, with the
odd legendary day making up for it. A chase streak stacks a bonus on the
payout, and CAPE spent on `/economy feed` grows the pet toward its next
stage.

---

## Pinging people from the map

Someone on the radar site can type `@` in the chat and pick a person. Their
message reaches Discord with a real mention in it, so that person gets a real
notification on their phone.

**Where the list of people comes from.** The website has no Discord token and
a webhook can only post, never read, so it cannot ask who is in the server.
The bot writes the list instead, into a `chatRoster` collection in Firestore:
Discord id, display name, avatar. By default it remembers everyone it sees,
which means anyone who talks in the bridged channel, runs a command, or links
their account. That grows on its own and needs no special permission.

If you want the whole membership listed from the start instead, three things
have to be true together, or the bot will not start at all:

1. **Server Members Intent** switched on in the Discord developer portal
   (Bot → Privileged Gateway Intents).
2. `GatewayIntentBits.GuildMembers` added to the intents list in
   `asturio-bot.mjs`.
3. `ROSTER_SWEEP=1` in `.env`.

Asking for a privileged intent that has not been granted is a hard failure,
not a degraded one, which is why this is opt-in and off by default.

**What a ping cannot do.** The parsing server decides, not the browser. Every relayed
message carries `allowed_mentions` with an empty `parse`, which is what makes
`@everyone`, `@here` and role pings impossible whatever the message says,
plus a `users` list holding only the ids the sender actually picked. Those ids
are checked to be plain digits and capped at eight per message before they go
anywhere. So a message can notify the people it names and nobody else.

**Coming the other way**, a mention typed in Discord arrives on the map as
`@Name` rather than as `<@844029301...>`: the bot resolves it before writing
to Firestore, because the raw token is unreadable to anyone looking at the
map.

---

## If something goes wrong

**`Missing DISCORD_TOKEN or DISCORD_CLIENT_ID`**
You haven't created `.env`, or it's not in the `services/bot/` folder. Step 4.

**`Could not log in: No Description`**
Discord's unhelpful way of saying the token is wrong. Reset it in the portal and
paste the new one, resetting invalidates the old token immediately.

**Slash commands don't show up**
Either you registered globally (up to an hour) or the bot was invited without the
`applications.commands` scope. Set `DISCORD_GUILD_ID` and restart, and re-invite
with both scopes if needed.

**Bot ignores @mentions but slash commands work**
**MESSAGE CONTENT INTENT** is off. Step 2.5.

**`NWS alerts unavailable`**
api.weather.gov is down or rate-limiting. The bot still answers, just without that
context, it's deliberately non-fatal.

---

## Keeping it running

Closing the terminal kills the bot. To keep it up on your laptop:

```bash
npx pm2 start "npm start" --name asturio
npx pm2 logs asturio      # watch output
npx pm2 stop asturio      # stop it
```

For genuine 24/7 uptime it wants a machine that's always on, a small VPS, or a
parsing server. The same files work anywhere Node runs.

## If the Gemini key is refused

    Gemini key refused, switching to the shared worker for the rest of
    this session.

That is not fatal. There are two ways to ask: a `GEMINI_API_KEY` of your own,
or the same Cloudflare Worker the website uses, which needs no key. If Google
refuses the key, the bot says so once and uses the worker from then on, so the
bot keeps answering.

To use your own key instead, the message says what to change: on the key at
console.cloud.google.com/apis/credentials, set API restrictions to "Gemini
API". Google will not let one key hold Gemini alongside other APIs, so Gemini
needs its own.

The distinction matters: a refused key is worth falling back from, but a quota
message or a retired model name would fail exactly the same way through the
worker, so those are reported rather than retried.

## /map picks layers the way the site does

`/map` takes four options: `place`, `layer`, `overlay` and `zoom`.

A layer is a path through the site's left menu, the same taps a person makes
there: `Waves > SST > Coral Reef Watch > Actual`, `Radar > Level 2 > Velocity`.
Start typing any words from it, in any order (`coral actual`), and the box
offers the matching paths. Several layers go in one box joined with `|`.

The picture comes from a `?menu=` link: the page goes back to the top of its
own menu and taps each label in turn, so a path shows exactly what those taps
show by hand, for every layer.

Overlays are the site's row of overlay switches, by name. The outlooks carry
their day and hazard as a path too: `SPC Outlook > Day 2 > Tornado`,
`WPC Outlook > Day 1`, `CPC Outlook > 6-10 Day Temperature`.

The layer paths live in `services/bot/map-menu.json`, written by walking the
real menu in a headless browser:

    node tools/crawl-map-menu.mjs

Run it (with the network on, so rows filled from the network are walked too)
after changing the site's menus, then restart the bot so the command
re-registers. Overlay names still come from `services/bot/map-options.json`:

    node tools/extract-map-options.js

    node services/bot/test-map-command.mjs

Builds the real command and checks it against Discord's own limits, which are
otherwise discovered at startup when registration fails and the bot is already
down. Also checks it against the site: every family reached an option, nothing
hidden is on the menu, and no completion is a value Discord would refuse.

Lists too long for Discord's 25 fixed choices, and anything taking several
values at once, complete as you type instead. Completion finishes the value
after the last comma and hands back everything before it untouched.

Anything the site does not have is refused with a note saying so, rather than
quietly producing a picture without it. Silently ignoring a name is how someone
ends up believing a layer is on when it never was.

## The bot's face

It wears `assets/img/asturio-ai-512.png`, which is built from
`assets/img/asturio-logo.png`: the exact file the AI panel header displays.
The bot shares a brain and a name with the assistant in the app, so it shares
a face, and it is the same image rather than an interpretation of it.

It used to wear a stylised mark instead, the app's rings drawn as a lit iris
with Matrix rain behind them. That looked good and it was not the logo, so
somebody who knows this site by its red, gold and cyan rings did not
recognise the bot as belonging to it.

The logo is framed rather than uploaded raw, because it is a ring mark with a
transparent middle: sent as it is, Discord would show its own background
through the centre and the picture would look different in the light theme
than the dark one, and at the forty pixels a message list gives it, an
outline with no edge dissolves. So it is composited onto the panel's dark
chrome inside a gold rim, which is exactly how the site's own header frames
it.

    node tools/make-asturio-avatar.mjs

Rebuilds the PNG. Run it if the site's logo changes, then restart the bot.
The generator does nothing random and reads no clock, so re-running it with
nothing changed produces the same bytes and shows no diff.

The bot uploads the picture on start, but only when it differs from the one it
last sent, which it records in `services/bot/.avatar-stamp` (ignored by git).
That is not tidiness: Discord limits how often a bot may change its avatar, in
the region of twice an hour, so a bot that re-uploads on every restart gets
refused and then cannot change it when it matters.

A refusal is logged and shrugged off. A weather bot that will not answer
because it could not change its profile picture is worse than one with the
wrong picture.

    node tools/test-asturio-avatar.mjs

Checks the picture is square, 512, and small enough to upload; that the
generator is deterministic; that the mark uses the site's own palette, read out
of `index.html` rather than repeated, so it cannot drift off-brand; and that
the upload is skipped when nothing changed.
