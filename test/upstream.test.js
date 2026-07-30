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
  const proxy = createUpstreamProxy({ maxInFlight: 2, log: quiet, sendImpl: () => {} });
  const from = { address: '198.51.100.7', port: 1234 };
  for (let i = 0; i < 10; i += 1) proxy.forward(packet('getAuthKey', 'x'), from, () => {});
  assert.equal(proxy.inFlight, 2, 'capped at maxInFlight');
});
