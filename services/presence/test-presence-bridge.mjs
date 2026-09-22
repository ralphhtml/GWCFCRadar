#!/usr/bin/env node
/*
 * Checks the presence bridge without a real Discord client: the IPC frame
 * encoding against known byte layouts, and the HTTP side against a fake
 * Discord connection standing in for the real one.
 *
 *     node test-presence-bridge.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  encodeFrame, decodeFrames, ipcPaths, createBridgeServer, OP,
} from './presence-bridge.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  <' + extra + '>' : '')); }
};

console.log('\n1. IPC frame encoding matches the protocol byte layout');
{
  const buf = encodeFrame(OP.HANDSHAKE, { v: 1, client_id: 'abc' });
  ok('an 8 byte header: opcode then length, both little-endian uint32',
     buf.readUInt32LE(0) === OP.HANDSHAKE
     && buf.readUInt32LE(4) === Buffer.byteLength(JSON.stringify({ v: 1, client_id: 'abc' })));
  ok('the body is exactly the JSON, nothing extra',
     buf.subarray(8).toString('utf8') === JSON.stringify({ v: 1, client_id: 'abc' }));

  const { frames, rest } = decodeFrames(buf);
  ok('a full frame decodes back to the same opcode and body',
     frames.length === 1 && frames[0].opcode === OP.HANDSHAKE
     && JSON.parse(frames[0].body.toString('utf8')).client_id === 'abc');
  ok('nothing left over once the one frame is consumed', rest.length === 0);

  const partial = buf.subarray(0, buf.length - 3);
  const split = decodeFrames(partial);
  ok('a frame cut short is left whole in the leftover, not decoded early',
     split.frames.length === 0 && split.rest.length === partial.length);

  const two = Buffer.concat([
    encodeFrame(OP.FRAME, { cmd: 'A' }),
    encodeFrame(OP.FRAME, { cmd: 'B' }),
  ]);
  const both = decodeFrames(two);
  ok('two frames back to back both decode, in order',
     both.frames.length === 2
     && JSON.parse(both.frames[0].body).cmd === 'A'
     && JSON.parse(both.frames[1].body).cmd === 'B');
}

console.log('\n2. the pipe candidates match each OS\'s real socket location');
{
  const win = ipcPaths({}, 'win32');
  ok('Windows: ten named pipes, discord-ipc-0 through 9',
     win.length === 10 && win[0] === '\\\\.\\pipe\\discord-ipc-0' && win[9] === '\\\\.\\pipe\\discord-ipc-9',
     win.join(','));
  const linux = ipcPaths({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux');
  ok('Linux: XDG_RUNTIME_DIR first, ten socket files',
     linux.length === 10 && linux[0] === '/run/user/1000/discord-ipc-0', linux[0]);
  const mac = ipcPaths({ TMPDIR: '/var/folders/xy/' }, 'darwin');
  ok('Mac: falls through to TMPDIR when XDG_RUNTIME_DIR is unset, trailing slash stripped',
     mac[0] === '/var/folders/xy/discord-ipc-0', mac[0]);
  const bare = ipcPaths({}, 'linux');
  ok('nothing set at all still returns ten usable paths, never throws',
     bare.length === 10 && bare.every(p => p.includes('discord-ipc-')));
}

// A stand-in for the real Discord connection: records every SET_ACTIVITY
// call instead of opening a socket, so the HTTP side is fully testable
// without Discord installed anywhere near this machine.
function fakeIpc({ ready = true, failWith = null } = {}) {
  return {
    ready,
    calls: [],
    connect() { if (ready) return Promise.resolve(); return Promise.reject(new Error('not running')); },
    setActivity(activity) {
      if (failWith) return Promise.reject(failWith);
      this.calls.push(activity);
      return Promise.resolve({});
    },
  };
}

async function withServer(ipc, opts, fn) {
  const server = createBridgeServer({ ipc, startedAt: 1700000000000, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

console.log('\n3. the HTTP side, against a fake Discord connection');
{
  const ipc = fakeIpc();
  await withServer(ipc, {}, async (base) => {
    const pre = await fetch(base + '/update', { method: 'OPTIONS' });
    ok('a CORS preflight gets 204 with the private network header',
       pre.status === 204
       && pre.headers.get('access-control-allow-private-network') === 'true'
       && pre.headers.get('access-control-allow-origin') === '*');

    const ping = await fetch(base + '/ping');
    const pingBody = await ping.json();
    ok('/ping reports the fake connection as ready', ping.status === 200 && pingBody.discordConnected === true);

    const r = await fetch(base + '/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ details: 'Radar: Reflectivity (KATL)', state: '+ Tornado Warnings' }),
    });
    ok('a real update returns 200 ok:true', r.status === 200 && (await r.json()).ok === true);
    ok('the activity actually reached setActivity, image and timestamp filled in',
       ipc.calls.length === 1
       && ipc.calls[0].details === 'Radar: Reflectivity (KATL)'
       && ipc.calls[0].state === '+ Tornado Warnings'
       && ipc.calls[0].largeImageKey === 'gwcfc'
       && ipc.calls[0].startTimestamp === 1700000000
       && ipc.calls[0].instance === false,
       JSON.stringify(ipc.calls[0]));

    const long = 'x'.repeat(500);
    await fetch(base + '/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ details: long, state: long }),
    });
    ok('an oversized line is cut to Discord\'s own 128 char limit',
       ipc.calls[1].details.length === 128 && ipc.calls[1].state.length === 128);

    const garbage = await fetch(base + '/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json{{{',
    });
    ok('garbage in the body does not crash the server, just posts an empty activity',
       garbage.status === 200 && ipc.calls[2].details === undefined && ipc.calls[2].state === undefined);

    const missing = await fetch(base + '/nope');
    ok('an unknown route is a plain 404', missing.status === 404);
  });
}

console.log('\n4. Discord being unreachable is reported, not thrown');
{
  const ipc = fakeIpc({ ready: false });
  await withServer(ipc, {}, async (base) => {
    const r = await fetch(base + '/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ details: 'Radar: Reflectivity' }),
    });
    const body = await r.json();
    ok('a disconnected bridge answers 503 with ok:false rather than hanging or crashing',
       r.status === 503 && body.ok === false, JSON.stringify(body));
  });
}

console.log('\n5. an origin can be pinned instead of the wide-open default');
{
  const ipc = fakeIpc();
  await withServer(ipc, { allowedOrigin: 'https://ralphhtml.github.io' }, async (base) => {
    const r = await fetch(base + '/ping');
    ok('the configured origin is echoed back instead of *',
       r.headers.get('access-control-allow-origin') === 'https://ralphhtml.github.io');
  });
}

const EM = String.fromCharCode(0x2014);
console.log('\n6. no em dashes');
{
  ok('none in the bridge, the tests, or the README',
     !readFileSync(join(ROOT, 'presence-bridge.mjs'), 'utf8').includes(EM)
     && !readFileSync(join(ROOT, 'test-presence-bridge.mjs'), 'utf8').includes(EM)
     && !readFileSync(join(ROOT, 'README.md'), 'utf8').includes(EM));
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
