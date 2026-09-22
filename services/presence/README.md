# Discord Rich Presence bridge

Shows what you're viewing on GWCFCRadar as your own Discord "Playing ..."
card, the one that shows under your name to your friends. This is
different from the Discord bot in `services/bot/`, that shows the bot's
own status to a whole server; this shows YOUR status, on YOUR profile,
and only you can turn it on.

A browser tab cannot talk to Discord directly, Rich Presence needs a local
pipe only the Discord desktop app itself listens on, and a webpage has no
way to open one. This folder is a small program that opens it for you: it
runs on your own computer, connects to your own Discord client, and gives
the website a tiny local address to post updates to.

---

## One-time setup

### 1. Make a Discord Application

1. Go to https://discord.com/developers/applications → **New Application**
2. Name it whatever you want the card to show, e.g. `GWCFCRadar`
3. On **General Information**, copy the **Application ID**
4. Left sidebar → **Rich Presence** → **Art Assets** → **Add Image(s)**,
   upload `assets/img/gwcfc-logo.png` from the repo root, and give it a key
   name (write down exactly what you typed, you'll need it in step 3 below)

No bot token, no OAuth, no server invite. This only ever talks to your own
Discord client on your own machine.

### 2. Configure

```bash
cd services/presence
cp .env.example .env
```

Open `.env` and paste in your Application ID as `DISCORD_PRESENCE_CLIENT_ID`.
If you named the art asset something other than `gwcfc`, also set
`DISCORD_PRESENCE_IMAGE_KEY` to match.

### 3. Run it

```bash
node --env-file=.env presence-bridge.mjs
```

You should see:

```
Connected to Discord.
Presence bridge listening on http://127.0.0.1:32473
```

If Discord wasn't open yet, it'll say so and try again the next time the
site posts an update, no need to restart it once Discord is running.

Leave the terminal open. Closing it, or closing Discord, just means the
card stops updating; nothing else about the site is affected.

### 4. Turn it on in the site

Settings → **Discord Rich Presence** → switch it on. Off by default. While
it's on, the site posts what layer or overlay you're currently viewing to
this bridge every 15 seconds, and the bridge forwards it to Discord as your
Rich Presence.

---

## How it works

Discord's desktop app listens on a local named pipe (Windows) or Unix
socket (Mac/Linux), `discord-ipc-0` through `discord-ipc-9`. A program
connects to it, sends a handshake naming its Application ID, and can then
ask Discord to `SET_ACTIVITY`, the call behind every "Playing ..." card,
whether it's a game, Spotify, or this.

`presence-bridge.mjs` implements that handshake directly with nothing but
Node's own `net`, `http` and `crypto` modules, no `npm install` needed.
It also runs one small local HTTP server, bound to `127.0.0.1` only so
nothing outside your machine can ever reach it, with two routes:

- `GET /ping`, whether the bridge is up and currently connected to Discord
- `POST /update`, takes `{ details, state }` and forwards it as your
  activity's two text lines

## If something goes wrong

**Nothing happens when I turn the setting on**
The bridge isn't running, or Discord isn't open. The setting fails
silently on purpose, every other visitor to the site never runs this
bridge at all, and their experience must not change because of that.

**`Missing DISCORD_PRESENCE_CLIENT_ID`**
You haven't created `.env` yet, or it's not in `services/presence/`. Step 2.

**The card shows no image**
The Art Asset key in `.env` (`DISCORD_PRESENCE_IMAGE_KEY`) doesn't match
what you typed when uploading the image in step 1. Rich Presence asset
keys can't be edited after saving, delete and re-upload it if you need to
rename it.

**`Discord handshake timed out` / `not connected to Discord`**
Discord itself needs to be open on the same machine before the bridge can
reach it. Start Discord, then either restart the bridge or just wait, it
retries automatically the next time the site posts an update.

    node test-presence-bridge.mjs

Checks the HTTP side (CORS/Private-Network-Access headers, request
handling, activity payloads) against a fake Discord connection, and the
IPC frame encoding/decoding against known byte layouts. Doesn't need a
real Discord client running.
