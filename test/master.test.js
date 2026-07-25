// End-to-end over a real UDP socket: we speak to the master exactly as Quake 4 does, and a
// fake game server speaks back exactly as a dedicated server does. If these pass, the wire
// behaviour is right; unit tests alone would not prove the socket plumbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createMaster } from '../src/master.js';
import { oob, parseServersReply, parseCommand } from '../src/protocol.js';

/** A stand-in Quake 4 dedicated server: answers getInfo, and can send a heartbeat. */
async function fakeServer({ answers = true, name = 'Fake', mod = 'q4max' } = {}) {
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, r));
  sock.on('message', (msg, from) => {
    const p = parseCommand(msg);
    if (!answers || !p || p.command !== 'getInfo') return;
    sock.send(Buffer.concat([
      oob('infoResponse'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from(`si_name\0${name}\0fs_game\0${mod}\0\0`, 'latin1'),
    ]), from.port, from.address);
  });
  return {
    port: sock.address().port,
    heartbeatTo: (port) => new Promise((r) => sock.send(oob('heartbeat'), port, '127.0.0.1', r)),
    close: () => new Promise((r) => sock.close(r)),
  };
}

/** Ask a master for its list, the way idAsyncClient::GetNETServers does. */
function getServers(port, { fsGame = '', waitMs = 700 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const found = [];
    sock.on('message', (m) => found.push(...parseServersReply(m)));
    const body = Buffer.alloc(4 + fsGame.length + 2);
    body.writeUInt32LE((2 << 16) | 0, 0);
    body.write(`${fsGame}\0`, 4, 'latin1');
    sock.send(oob('getServers', body), port, '127.0.0.1');
    setTimeout(() => { sock.close(); resolve(found); }, waitMs);
  });
}

async function withMaster(opts, fn) {
  const m = createMaster({ log: () => {}, sweepMs: 60_000, ...opts });
  await m.start();
  try { return await fn(m, m.socket.address().port); } finally { await m.stop(); }
}

test('a verified seed is served to a real getServers request', async () => {
  const srv = await fakeServer({ name: 'Seeded' });
  try {
    await withMaster({ port: 0, seeds: [`127.0.0.1:${srv.port}`] }, async (m, port) => {
      assert.equal(m.registry.size, 1, 'verified at boot');
      assert.deepEqual(await getServers(port), [`127.0.0.1:${srv.port}`]);
    });
  } finally { await srv.close(); }
});

test('a seed that does not answer getInfo is never advertised', async () => {
  const srv = await fakeServer({ answers: false });
  try {
    await withMaster({ port: 0, seeds: [`127.0.0.1:${srv.port}`] }, async (m, port) => {
      assert.equal(m.registry.size, 0);
      assert.deepEqual(await getServers(port), []);
    });
  } finally { await srv.close(); }
});

test('a heartbeat registers a live server, which then appears in the list', async () => {
  const srv = await fakeServer({ name: 'Announced' });
  try {
    await withMaster({ port: 0 }, async (m, port) => {
      assert.deepEqual(await getServers(port), [], 'empty to begin with');
      await srv.heartbeatTo(port);
      await new Promise((r) => setTimeout(r, 400)); // let the verification probe complete
      assert.deepEqual(await getServers(port), [`127.0.0.1:${srv.port}`]);
    });
  } finally { await srv.close(); }
});

test('a heartbeat from something that is not a server is refused', async () => {
  const liar = dgram.createSocket('udp4');
  await new Promise((r) => liar.bind(0, r));
  try {
    await withMaster({ port: 0 }, async (m, port) => {
      await new Promise((r) => liar.send(oob('heartbeat'), port, '127.0.0.1', r));
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(m.registry.size, 0, 'never answered getInfo, so never listed');
    });
  } finally { await new Promise((r) => liar.close(r)); }
});

test('junk traffic on the port neither crashes nor registers anything', async () => {
  await withMaster({ port: 0 }, async (m, port) => {
    const noise = dgram.createSocket('udp4');
    for (const junk of [Buffer.from('GET / HTTP/1.1\r\n'), Buffer.alloc(0), Buffer.from([0xff]), Buffer.alloc(600, 0x41)]) {
      await new Promise((r) => noise.send(junk, port, '127.0.0.1', () => r()));
    }
    await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => noise.close(r));
    assert.equal(m.registry.size, 0);
    // Still healthy afterwards.
    assert.deepEqual(await getServers(port), []);
  });
});

test('strict fs_game filtering is off by default and works when enabled', async () => {
  const max = await fakeServer({ name: 'Max', mod: 'q4max' });
  const stock = await fakeServer({ name: 'Stock', mod: 'q4mp' });
  const seeds = [`127.0.0.1:${max.port}`, `127.0.0.1:${stock.port}`];
  try {
    await withMaster({ port: 0, seeds }, async (m, port) => {
      const all = await getServers(port, { fsGame: 'q4max' });
      assert.equal(all.length, 2, 'lenient by default: an empty browser helps nobody');
    });
    await withMaster({ port: 0, seeds, strictGameFilter: true }, async (m, port) => {
      const only = await getServers(port, { fsGame: 'q4max' });
      assert.deepEqual(only, [`127.0.0.1:${max.port}`]);
    });
  } finally { await max.close(); await stock.close(); }
});

test('the reply leaves from the port the request arrived on', async () => {
  // The client checks the reply's source against net_master0 (Sys_CompareNetAdrBase) and drops
  // anything else, so replying from a different socket would look like total silence.
  const srv = await fakeServer();
  try {
    await withMaster({ port: 0, seeds: [`127.0.0.1:${srv.port}`] }, async (m, port) => {
      const sock = dgram.createSocket('udp4');
      const from = await new Promise((resolve) => {
        sock.on('message', (msg, rinfo) => resolve(rinfo));
        const body = Buffer.alloc(6);
        body.writeUInt32LE((2 << 16) | 0, 0);
        body.write('\0', 4, 'latin1');
        sock.send(oob('getServers', body), port, '127.0.0.1');
      });
      sock.close();
      assert.equal(from.port, port, 'source port matches the master the client asked');
    });
  } finally { await srv.close(); }
});
