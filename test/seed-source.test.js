// The optional remote seed list. The behaviour that matters is not "does it parse JSON" but
// "what happens on a bad day" — a seed source that goes down must never shrink the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { extractAddresses, fetchSeeds } from '../src/seed-source.js';
import { createMaster } from '../src/master.js';
import { oob, parseServersReply, parseCommand } from '../src/protocol.js';

test('reads the shape quakehub.net/api/v1/servers/q4 returns', () => {
  assert.deepEqual(extractAddresses({
    servers: [
      { id: 'q4:1.1.1.1:28004', address: '1.1.1.1:28004', ip: '1.1.1.1', port: 28004, name: 'A' },
      { id: 'q4:2.2.2.2:28005', address: '2.2.2.2:28005', ip: '2.2.2.2', port: 28005, name: 'B' },
    ],
  }), ['1.1.1.1:28004', '2.2.2.2:28005']);
});

test('reads the shape quake4.net/qstat/output.json returns, hostnames and all', () => {
  assert.deepEqual(extractAddresses([
    { address: 'se.quake4.net:28004', protocol: 'q4s' },
    { address: 'useast.quake4.net:28004', protocol: 'q4s' },
  ]), ['se.quake4.net:28004', 'useast.quake4.net:28004']);
});

test('reads plain string lists and ip/port pairs too', () => {
  assert.deepEqual(extractAddresses(['1.1.1.1:28004']), ['1.1.1.1:28004']);
  assert.deepEqual(extractAddresses({ servers: ['1.1.1.1:28004'] }), ['1.1.1.1:28004']);
  assert.deepEqual(extractAddresses([{ ip: '3.3.3.3', port: 28004 }]), ['3.3.3.3:28004']);
  assert.deepEqual(extractAddresses([{ host: 'a.example.net', port: 28004 }]), ['a.example.net:28004']);
});

test('junk entries are dropped and duplicates collapsed', () => {
  assert.deepEqual(extractAddresses([
    '1.1.1.1:28004',
    '1.1.1.1:28004',            // dupe
    'no-port',
    '1.1.1.1:0',                // invalid port
    '1.1.1.1:99999',            // out of range
    'http://x.example.net:28004', // a URL, not an address
    { nope: true },
    null,
    42,
  ]), ['1.1.1.1:28004']);
});

test('an unrecognisable payload yields nothing rather than throwing', () => {
  for (const bad of [null, undefined, 42, 'nope', {}, [], { servers: 'not-an-array' }]) {
    assert.deepEqual(extractAddresses(bad), []);
  }
});

test('a hostile endpoint cannot flood the probe loop', () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `10.0.${(i / 256) | 0}.${i % 256}:28004`);
  assert.equal(extractAddresses(huge).length, 500);
});

test('a non-200 response throws so the caller keeps the previous list', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchSeeds('http://x', { fetchImpl }), /HTTP 503/);
});

// --- the behaviour that actually protects the list ------------------------------------------

/** A stand-in dedicated server that answers getInfo. */
async function fakeServer(name = 'S') {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, r));
  sock.on('message', (msg, from) => {
    const p = parseCommand(msg);
    if (!p || p.command !== 'getInfo') return;
    sock.send(Buffer.concat([
      oob('infoResponse'), Buffer.from([0, 0, 0, 0]),
      Buffer.from(`si_name\0${name}\0fs_game\0q4max\0\0`, 'latin1'),
    ]), from.port, from.address);
  });
  return { port: sock.address().port, close: () => new Promise((r) => sock.close(r)) };
}

function getServers(port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    sock.on('message', (m) => found.push(...parseServersReply(m)));
    const body = Buffer.alloc(6);
    body.writeUInt32LE((2 << 16) | 0, 0);
    sock.send(oob('getServers', body), port, '127.0.0.1');
    setTimeout(() => { sock.close(); resolve(found); }, 600);
  });
}

test('remote seeds are added to the bundled ones, not substituted for them', async () => {
  const bundled = await fakeServer('Bundled');
  const remote = await fakeServer('Remote');
  try {
    const m = createMaster({
      port: 0,
      log: () => {},
      sweepMs: 60_000,
      seeds: [`127.0.0.1:${bundled.port}`],
      seedsUrl: 'http://seeds.test/list',
      fetchSeedsImpl: async () => [`127.0.0.1:${remote.port}`],
    });
    await m.start();
    try {
      const list = await getServers(m.socket.address().port);
      assert.equal(list.length, 2, 'both bundled and remote are listed');
    } finally { await m.stop(); }
  } finally { await bundled.close(); await remote.close(); }
});

test('when the seed source goes down, the list keeps the addresses it already had', async () => {
  // This is the whole point of splitting static from remote seeds. Somebody else's web server
  // having a bad minute must not empty a server browser.
  const bundled = await fakeServer('Bundled');
  const remote = await fakeServer('Remote');
  try {
    let up = true;
    const m = createMaster({
      port: 0,
      log: () => {},
      sweepMs: 60_000,
      seeds: [`127.0.0.1:${bundled.port}`],
      seedsUrl: 'http://seeds.test/list',
      fetchSeedsImpl: async () => {
        if (!up) throw new Error('ECONNREFUSED');
        return [`127.0.0.1:${remote.port}`];
      },
    });
    await m.start();
    try {
      assert.equal((await getServers(m.socket.address().port)).length, 2);
      up = false;
      await m.registry.sweep();
      // The remote seed is still remembered, so it is still probed and still listed.
      assert.equal(m.registry.seeds.size, 2, 'remote seed retained across the outage');
      assert.equal((await getServers(m.socket.address().port)).length, 2);
    } finally { await m.stop(); }
  } finally { await bundled.close(); await remote.close(); }
});

test('a seed source that returns an empty list is ignored, not obeyed', async () => {
  // An endpoint answering 200 with [] is far more likely to be a bug at their end than a
  // genuine statement that no servers exist. Treat it as no news.
  const bundled = await fakeServer('Bundled');
  const remote = await fakeServer('Remote');
  try {
    let payload = [`127.0.0.1:${remote.port}`];
    const m = createMaster({
      port: 0,
      log: () => {},
      sweepMs: 60_000,
      seeds: [`127.0.0.1:${bundled.port}`],
      seedsUrl: 'http://seeds.test/list',
      fetchSeedsImpl: async () => payload,
    });
    await m.start();
    try {
      assert.equal(m.registry.remoteSeeds.size, 1);
      payload = [];
      await m.registry.sweep();
      assert.equal(m.registry.remoteSeeds.size, 1, 'kept the previous list');
    } finally { await m.stop(); }
  } finally { await bundled.close(); await remote.close(); }
});

test('with no seedsUrl configured nothing is fetched at all', async () => {
  let called = false;
  const m = createMaster({
    port: 0, log: () => {}, sweepMs: 60_000, seeds: [],
    fetchSeedsImpl: async () => { called = true; return []; },
  });
  await m.start();
  try {
    assert.equal(called, false, 'stays fully standalone by default');
    assert.equal(m.registry.remoteSeeds.size, 0);
  } finally { await m.stop(); }
});
