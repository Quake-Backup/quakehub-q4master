#!/usr/bin/env node
// Ask any idTech4 master for its server list, exactly as the game client would.
//
//   node tools/query.js                     # localhost
//   node tools/query.js master.example.net  # someone else's
//
// Handy for two things: proving your own master works before you tell anyone about it, and
// checking whether a master someone points you at is actually alive. Most are not.

import dgram from 'node:dgram';
import { oob, parseServersReply, DEFAULT_PORT } from '../src/protocol.js';

const [hostArg, portArg] = process.argv.slice(2);
const host = hostArg || '127.0.0.1';
const port = Number(portArg) || DEFAULT_PORT;

// Quake 4 1.4.2's ASYNC_PROTOCOL_VERSION. A real master may filter on this; ours does not.
const PROTOCOL = (2 << 16) | 0;
const FS_GAME = process.env.FS_GAME || '';

function buildGetServers() {
  const body = Buffer.alloc(4 + FS_GAME.length + 2);
  body.writeUInt32LE(PROTOCOL, 0);
  body.write(`${FS_GAME}\0`, 4, 'latin1');
  return oob('getServers', body);
}

const sock = dgram.createSocket('udp4');
const found = [];

sock.on('message', (msg) => {
  const servers = parseServersReply(msg);
  if (!servers.length) return;
  found.push(...servers);
});

sock.send(buildGetServers(), port, host, (err) => {
  if (err) {
    console.error(`send failed: ${err.message}`);
    process.exit(1);
  }
});

// Masters may answer in several packets; wait for them all rather than the first.
setTimeout(() => {
  sock.close();
  if (!found.length) {
    console.log(`${host}:${port} returned nothing (no reply, or an empty list)`);
    process.exit(1);
  }
  console.log(`${host}:${port} -> ${found.length} server(s)`);
  for (const s of found) console.log(`  ${s}`);
  process.exit(0);
}, 3000);
