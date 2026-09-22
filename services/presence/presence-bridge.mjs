#!/usr/bin/env node
/*
 * Turns what you're viewing on GWCFCRadar into your own Discord Rich
 * Presence, the "Playing ..." card that shows under your name.
 *
 *     node --env-file=.env presence-bridge.mjs
 *
 * A browser tab cannot reach Discord directly: Rich Presence needs a local
 * named pipe (Windows) or Unix socket (Mac/Linux) that only Discord's own
 * desktop app listens on, and a webpage has no way to open one. This is the
 * program that opens it instead. It runs on your machine, connects to your
 * own Discord client over that pipe, and exposes one small HTTP endpoint on
 * 127.0.0.1 that the site POSTs a short "what am I looking at" summary to
 * every 15 seconds while Settings > Discord Rich Presence is turned on.
 *
 * No dependencies on purpose: the IPC handshake below is the same small,
 * stable, widely-used protocol every other Rich Presence integration
 * speaks, implemented here with nothing but Node's own net/http/crypto so
 * there is nothing to `npm install` before this runs.
 */
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { platform, tmpdir } from 'node:os';

const CLIENT_ID = process.env.DISCORD_PRESENCE_CLIENT_ID;
const PORT = Number(process.env.PRESENCE_BRIDGE_PORT || 32473);
const IMAGE_KEY = process.env.DISCORD_PRESENCE_IMAGE_KEY || 'gwcfc';
const ALLOWED_ORIGIN = process.env.PRESENCE_ALLOWED_ORIGIN || '*';

// ── The pipe Discord's desktop app listens on ──────────────────────────────
// Discord tries discord-ipc-0 through discord-ipc-9 in order (a second
// running instance takes the next number), so every candidate is worth a
// try rather than assuming 0. platform/env are parameters, not read
// globally, purely so a test can hand in a fake platform without needing a
// fake filesystem or a real Windows/Mac/Linux box to prove the path shape.
export function ipcPaths(env = process.env, plat = platform()) {
  if (plat === 'win32') {
    return Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);
  }
  const base = (env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || tmpdir())
    .replace(/\/$/, '');
  return Array.from({ length: 10 }, (_, i) => `${base}/discord-ipc-${i}`);
}

export const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// Every message on the pipe is an 8-byte header (opcode, then byte length,
// both little-endian uint32) followed by that many bytes of JSON. Framing
// it as one function each way keeps the encode/decode symmetry testable
// without a socket at all.
export function encodeFrame(opcode, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(opcode, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

// Pulls as many complete frames as `buf` currently holds. Returns the
// leftover (possibly partial) bytes so the caller can keep appending as
// more data arrives, a socket's 'data' event has no notion of "one frame
// per event", it hands over whatever the kernel buffer happened to have.
export function decodeFrames(buf) {
  const frames = [];
  while (buf.length >= 8) {
    const opcode = buf.readUInt32LE(0);
    const len = buf.readUInt32LE(4);
    if (buf.length < 8 + len) break;
    frames.push({ opcode, body: buf.subarray(8, 8 + len) });
    buf = buf.subarray(8 + len);
  }
  return { frames, rest: buf };
}

export class DiscordIpc {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.pending = new Map(); // nonce -> {resolve, reject}
  }

  async connect() {
    if (this.ready) return;
    let lastErr = new Error('Discord is not running, or Rich Presence is off in its settings.');
    for (const path of ipcPaths()) {
      try { await this._tryPath(path); return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  _tryPath(path) {
    return new Promise((resolve, reject) => {
      const sock = createConnection(path);
      const onError = (e) => { sock.destroy(); reject(e); };
      sock.once('error', onError);
      sock.once('connect', () => {
        sock.removeListener('error', onError);
        this.socket = sock;
        this.buf = Buffer.alloc(0);
        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('close', () => { this.ready = false; this.socket = null; });
        sock.on('error', () => {}); // surfaced through the pending promises instead
        this._readyResolve = resolve;
        this._readyReject = reject;
        this._readyTimer = setTimeout(() => {
          if (!this.ready) { sock.destroy(); reject(new Error('Discord handshake timed out')); }
        }, 5000);
        sock.write(encodeFrame(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
      });
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = rest;
    frames.forEach(({ opcode, body }) => this._onFrame(opcode, body));
  }

  _onFrame(opcode, body) {
    if (opcode === OP.CLOSE) { this.socket?.destroy(); return; }
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch { return; }
    if (msg.evt === 'READY') {
      this.ready = true;
      clearTimeout(this._readyTimer);
      this._readyResolve?.();
    } else if (msg.evt === 'ERROR' && !this.ready) {
      clearTimeout(this._readyTimer);
      this._readyReject?.(new Error(msg.data?.message || 'Discord refused the handshake'));
    } else if (msg.nonce && this.pending.has(msg.nonce)) {
      const { resolve, reject } = this.pending.get(msg.nonce);
      this.pending.delete(msg.nonce);
      if (msg.evt === 'ERROR') reject(new Error(msg.data?.message || 'Discord refused the command'));
      else resolve(msg.data);
    }
  }

  setActivity(activity) {
    if (!this.ready || !this.socket) return Promise.reject(new Error('not connected to Discord'));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(nonce, { resolve, reject });
      this.socket.write(encodeFrame(OP.FRAME, {
        cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce,
      }));
      setTimeout(() => {
        if (this.pending.has(nonce)) { this.pending.delete(nonce); reject(new Error('SET_ACTIVITY timed out')); }
      }, 5000);
    });
  }
}

// ── The local HTTP side the website actually talks to ─────────────────────
// Exported as a factory, taking the ipc client and the moment the bridge
// started, so a test can hand in a fake ipc client instead of a real
// Discord connection and still exercise every HTTP code path.
export function createBridgeServer({ ipc, startedAt = Date.now(), imageKey = IMAGE_KEY, allowedOrigin = ALLOWED_ORIGIN }) {
  let connecting = null;
  const ensureConnected = () => {
    if (ipc.ready) return Promise.resolve();
    if (!connecting) connecting = ipc.connect().finally(() => { connecting = null; });
    return connecting;
  };

  return createServer((req, res) => {
    // The site runs on a real https origin POSTing to this plain localhost
    // server: cross-origin by definition. Chrome also gates any public-page
    // request into a private address (this one) behind a Private Network
    // Access preflight, hence the extra header alongside the ordinary CORS
    // ones.
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, discordConnected: ipc.ready }));
      return;
    }

    if (req.method === 'POST' && req.url === '/update') {
      let body = '';
      let tooBig = false;
      req.on('data', (c) => {
        body += c;
        if (body.length > 8192) { tooBig = true; req.destroy(); }
      });
      req.on('end', async () => {
        if (tooBig) { res.writeHead(413); res.end(); return; }
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* treat as empty */ }
        const details = payload.details ? String(payload.details).slice(0, 128) : undefined;
        const state = payload.state ? String(payload.state).slice(0, 128) : undefined;
        try {
          await ensureConnected();
          await ipc.setActivity({
            details, state,
            largeImageKey: imageKey,
            largeImageText: 'GWCFCRadar',
            startTimestamp: Math.floor(startedAt / 1000),
            instance: false,
          });
          // The site posts here every 15 seconds while the setting is on,
          // completely silently otherwise - this is the only way to tell
          // from this terminal whether the site is reaching the bridge at
          // all, as opposed to Discord itself just not displaying it.
          console.log(`Sent to Discord: "${details || ''}" / "${state || ''}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.log('Discord refused the update:', e.message);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });
}

// Only actually run the server when this file is executed directly, so a
// test can `import` everything above without a real HTTP server or a real
// Discord socket spinning up as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!CLIENT_ID) {
    console.error('Missing DISCORD_PRESENCE_CLIENT_ID. Copy .env.example to .env, '
      + 'fill in the Application ID from discord.com/developers/applications, and run again.');
    process.exit(1);
  }
  const ipc = new DiscordIpc(CLIENT_ID);
  const server = createBridgeServer({ ipc, startedAt: Date.now() });
  ipc.connect()
    .then(() => console.log('Connected to Discord.'))
    .catch((e) => console.log('Not connected yet (will retry when the site posts an update):', e.message));
  // Localhost only: this must never be reachable from the network, only
  // from a browser tab running on the same machine.
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Presence bridge listening on http://127.0.0.1:${PORT}`);
  });
}
