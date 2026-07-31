// Port 27650 on id's master carries two services and only one of them died. Server LISTS return
// nothing, which is why this project exists. Client AUTHORISATION still works. So a master that
// answers getServers and silently drops everything else fixes the in-game browser and quietly
// removes the ability to connect: "waiting for authorisation", then "Client unknown to auth".
//
// It does not fail immediately, which is what made it so hard to find. A client keeps working on
// its existing GUID until that needs renewing. A player in Germany lost auth two days after
// setting net_master0 to us, and it reproduced here.
//
// These tests exist so nobody ever reintroduces the drop.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createMaster } from '../src/master.js';
import { oob } from '../src/protocol.js';
import { createUpstreamProxy, ID_MASTER_HOST, ID_MASTER_PORT } from '../src/upstream.js';

const packet = (cmd, rest = '') => oob(cmd, rest ? Buffer.from(rest, 'latin1') : undefined);
const quiet = () => {};

// A stand-in for id's master: echoes a recognisable reply to whatever it is sent.
function fakeUpstream() {
  const seen = [];
  return {
    seen,
    forward(msg, from, reply) {
      seen.push({ msg, from });
      reply(oob('authResponse', Buffer.from('OK', 'latin1')));
    },
  };
}

async function withMaster(opts, fn) {
  const m = createMaster({ port: 0, log: quiet, probe: async () => null, ...opts });
  await m.start();
  try { await fn(m, m.socket.address().port); } finally { await m.stop(); }
}

// Send a packet and wait for a reply, or null after a short grace period.
function ask(port, msg, waitMs = 400) {
  return new Promise((resolve) => {
    const c = dgram.createSocket('udp4');
    const timer = setTimeout(() => { try { c.close(); } catch { /* closed */ } resolve(null); }, waitMs);
    c.on('message', (reply) => {
      clearTimeout(timer);
      try { c.close(); } catch { /* closed */ }
      resolve(reply);
    });
    c.send(msg, port, '127.0.0.1');
  });
}

test('an auth packet is relayed upstream and its answer comes back', async () => {
  const up = fakeUpstream();
  await withMaster({ upstreamImpl: up }, async (_m, port) => {
    const reply = await ask(port, packet('getAuthKey', 'xyz'));
    assert.ok(reply, 'the client must get an answer, not silence');
    assert.match(reply.toString('latin1'), /authResponse/);
    assert.equal(up.seen.length, 1, 'exactly one packet forwarded');
    assert.equal(up.seen[0].msg.toString('latin1'), packet('getAuthKey', 'xyz').toString('latin1'),
      'forwarded byte for byte - we are a relay, not a parser');
  });
});

test('getServers is still answered by US, never forwarded', async () => {
  // The whole point of the project. If this regressed into a passthrough the browser would go
  // empty again, because id's list half is dead.
  const up = fakeUpstream();
  await withMaster({ upstreamImpl: up }, async (_m, port) => {
    // No reply is expected: the registry is empty here, and an empty list deliberately produces
    // no packet at all rather than a bare header (see protocol.test.js). What matters is that we
    // answered it ourselves instead of passing it on.
    await ask(port, packet('getServers', '    '), 200);
    assert.equal(up.seen.length, 0, 'getServers must never reach upstream');
  });
});

test('heartbeats are consumed, not forwarded', async () => {
  const up = fakeUpstream();
  await withMaster({ upstreamImpl: up }, async (_m, port) => {
    await ask(port, packet('heartbeat'), 200);
    assert.equal(up.seen.length, 0, 'a server registering with us is not id\'s business');
  });
});

test('the relay can be switched off, and says so loudly', async () => {
  const lines = [];
  const up = fakeUpstream();
  await withMaster({ upstreamHost: '', upstreamImpl: up, log: (l) => lines.push(l) }, async (_m, port) => {
    await ask(port, packet('getAuthKey', 'xyz'), 200);
    assert.equal(up.seen.length, 0);
  });
  assert.ok(lines.some((l) => /relay DISABLED/.test(l)),
    'turning it off must be visible in the log - this is the setting that breaks auth');
});

test('it defaults to id\'s master, on the port that still serves auth', () => {
  assert.equal(ID_MASTER_HOST, 'q4master.idsoftware.com');
  assert.equal(ID_MASTER_PORT, 27650);
});

test('a flood cannot open unbounded sockets', async () => {
  // Dropping under pressure is acceptable: it is exactly what we did before the relay existed.
  // Sessions are per CLIENT, so the flood has to come from many addresses to test the cap -
  // ten packets from one client is one session, and rightly so.
  const proxy = createUpstreamProxy({ maxSessions: 2, log: quiet, sendImpl: () => {} });
  try {
    for (let i = 0; i < 10; i += 1) {
      proxy.forward(packet('getAuthKey', 'x'), { address: `198.51.100.${i}`, port: 1234 }, () => {});
    }
    assert.equal(proxy.sessionCount, 2, 'capped at maxSessions');
  } finally { proxy.close(); }
});

test('a client keeps ONE upstream socket across its whole auth conversation', async () => {
  // The CD-key exchange is challenge/response over several datagrams, and id's auth server
  // tracks it by source address:port. A new socket per packet made round two look like a
  // stranger - id denied, and an explicit deny makes the engine WIPE the stored key. This is
  // the "cd key is reset each time I run a map" report, and it must never come back.
  const sent = [];
  const proxy = createUpstreamProxy({ log: quiet, sendImpl: (m) => sent.push(m) });
  try {
    const from = { address: '198.51.100.7', port: 27666 };
    proxy.forward(packet('clAuth', 'round1'), from, () => {});
    proxy.forward(packet('clAuth', 'round2'), from, () => {});
    proxy.forward(packet('clAuth', 'round3'), from, () => {});
    assert.equal(proxy.sessionCount, 1, 'one conversation, one session, one source port');
    assert.equal(sent.length, 3, 'every round forwarded');

    // A different client is a different conversation on its own socket.
    proxy.forward(packet('clAuth', 'x'), { address: '198.51.100.8', port: 27666 }, () => {});
    assert.equal(proxy.sessionCount, 2);
  } finally { proxy.close(); }
});

test('one source port for the whole exchange, and every reply datagram relayed', async () => {
  // The end-to-end shape of the fix, against a real loopback "id master": three auth rounds
  // must arrive at the upstream FROM THE SAME PORT (id tracks the conversation by it), and a
  // round answered with two datagrams must deliver both to the client (the verdict is often
  // not the first reply - one-shot relaying delivered the challenge and then went deaf).
  const seenPorts = [];
  const fakeId = dgram.createSocket('udp4');
  fakeId.on('message', (msg, rinfo) => {
    seenPorts.push(rinfo.port);
    fakeId.send(oob('challenge', Buffer.from('c', 'latin1')), rinfo.port, rinfo.address);
    fakeId.send(oob('authKey', Buffer.from('ok', 'latin1')), rinfo.port, rinfo.address);
  });
  await new Promise((r) => fakeId.bind(0, '127.0.0.1', r));

  const proxy = createUpstreamProxy({
    host: '127.0.0.1', port: fakeId.address().port, log: quiet,
  });
  try {
    const got = [];
    const from = { address: '198.51.100.9', port: 27666 };
    for (let round = 0; round < 3; round += 1) {
      proxy.forward(packet('clAuth', `round${round}`), from, (msg) => got.push(msg.toString('latin1')));
      await new Promise((r) => setTimeout(r, 120)); // let the round's replies land
    }
    assert.equal(seenPorts.length, 3, 'all three rounds reached the upstream');
    assert.equal(new Set(seenPorts).size, 1,
      'ONE source port across the conversation - a new port per round is the key-wipe bug');
    assert.equal(got.length, 6, 'both reply datagrams of every round reached the client');
    assert.match(got[0], /challenge/);
    assert.match(got[1], /authKey/);
  } finally {
    proxy.close();
    await new Promise((r) => fakeId.close(r));
  }
});

test('idle sessions are reaped; an active conversation is not', async () => {
  const proxy = createUpstreamProxy({ idleMs: 1000, log: quiet, sendImpl: () => {} });
  try {
    const t0 = Date.now();
    proxy.forward(packet('clAuth', 'x'), { address: '198.51.100.7', port: 1 }, () => {});
    proxy.forward(packet('clAuth', 'x'), { address: '198.51.100.8', port: 2 }, () => {});
    assert.equal(proxy.sessionCount, 2);
    proxy.sweep(t0 + 500);
    assert.equal(proxy.sessionCount, 2, 'nothing idle yet');
    proxy.forward(packet('clAuth', 'y'), { address: '198.51.100.8', port: 2 }, () => {}); // refreshes .8
    proxy.sweep(Date.now() + 1001);
    assert.ok(proxy.sessionCount <= 1, 'the idle session is gone');
  } finally { proxy.close(); }
});
