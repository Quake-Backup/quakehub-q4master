// The registry's whole job is to never advertise a server that isn't there. These tests pin
// that promise, because the failure it prevents is exactly what's wrong with every other
// Quake 4 list: PlayQ4's launcher ships 17 addresses and 1 of them still answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Registry, splitAddress } from '../src/registry.js';

const alive = (names) => async (ip, port) => (names.has(`${ip}:${port}`)
  ? { si_name: names.get(`${ip}:${port}`), fs_game: 'q4max' }
  : null);

test('a heartbeat from a server that does not answer getInfo is ignored', async () => {
  const r = new Registry({ probe: async () => null });
  assert.equal(await r.heartbeat('1.2.3.4', 28004), false);
  assert.equal(r.size, 0);
});

test('a heartbeat from a real server gets listed, with its mod recorded', async () => {
  const r = new Registry({ probe: async () => ({ si_name: 'Real', fs_game: 'q4max' }) });
  assert.equal(await r.heartbeat('1.2.3.4', 28004), true);
  assert.deepEqual(r.list().map((s) => `${s.ip}:${s.port}`), ['1.2.3.4:28004']);
  assert.equal(r.list()[0].fsGame, 'q4max');
});

test('a spoofed heartbeat cannot register an address the sender does not control', async () => {
  // We probe the packet's source address, never a payload-supplied one, so the only way to get
  // listed is to actually be a running server at that address.
  let probed = null;
  const r = new Registry({ probe: async (ip, port) => { probed = `${ip}:${port}`; return null; } });
  await r.heartbeat('9.9.9.9', 28004);
  assert.equal(probed, '9.9.9.9:28004', 'probes the source address');
  assert.equal(r.size, 0);
});

test('seeds are probed on sweep, and only the ones that answer are listed', async () => {
  const names = new Map([['1.1.1.1:28004', 'Up']]);
  const r = new Registry({
    probe: alive(names),
    seeds: ['1.1.1.1:28004', '2.2.2.2:28004'],
  });
  await r.sweep();
  assert.deepEqual(r.list().map((s) => s.name), ['Up']);
});

test('a server that stops answering ages out after the TTL, not instantly', async () => {
  let up = true;
  let clock = 1_000_000;
  const r = new Registry({
    probe: async () => (up ? { si_name: 'Flaky', fs_game: 'q4max' } : null),
    seeds: ['1.1.1.1:28004'],
    now: () => clock,
    ttlMs: 10 * 60 * 1000,
  });
  await r.sweep();
  assert.equal(r.size, 1);

  // Goes down. One missed sweep must NOT drop it: a map change or a blip would otherwise
  // empty the browser.
  up = false;
  clock += 4 * 60 * 1000;
  await r.sweep();
  assert.equal(r.size, 1, 'survives a short outage');

  // Still down well past the TTL: now it goes.
  clock += 30 * 60 * 1000;
  await r.sweep();
  assert.equal(r.size, 0, 'expires once genuinely gone');
});

test('a recovered server keeps its slot rather than being dropped and re-added', async () => {
  let up = true;
  let clock = 1_000_000;
  const r = new Registry({
    probe: async () => (up ? { si_name: 'Blip', fs_game: 'q4max' } : null),
    seeds: ['1.1.1.1:28004'],
    now: () => clock,
  });
  await r.sweep();
  up = false; clock += 60 * 1000; await r.sweep();
  up = true; clock += 60 * 1000; await r.sweep();
  assert.equal(r.size, 1);
  assert.equal(r.list()[0].lastSeen, clock, 'lastSeen refreshed on recovery');
});

test('hostname seeds are re-resolved every sweep, for servers behind dynamic DNS', async () => {
  // arenacamper.ddns.net and friends move. Resolving once at startup would silently drop them.
  let current = '5.5.5.5';
  const probed = [];
  const r = new Registry({
    probe: async (ip, port) => { probed.push(ip); return { si_name: 'Dyn', fs_game: 'q4mp' }; },
    seeds: ['dyn.example.net:28004'],
    resolve: async () => [current],
  });
  await r.sweep();
  assert.ok(probed.includes('5.5.5.5'));
  current = '6.6.6.6';
  await r.sweep();
  assert.ok(probed.includes('6.6.6.6'), 'picked up the new address');
});

test('a seed that fails DNS is skipped quietly, not fatal', async () => {
  const r = new Registry({
    probe: async () => ({ si_name: 'x' }),
    seeds: ['nx.example.invalid:28004', '1.1.1.1:28004'],
    resolve: async () => { throw new Error('ENOTFOUND'); },
  });
  await r.sweep();
  assert.equal(r.size, 1, 'the good seed still lands');
});

test('a probe that throws is treated as down, never crashing the sweep', async () => {
  const r = new Registry({
    probe: async (ip) => { if (ip === '1.1.1.1') throw new Error('ECONNREFUSED'); return { si_name: 'ok' }; },
    seeds: ['1.1.1.1:28004', '2.2.2.2:28004'],
  });
  await r.sweep();
  assert.equal(r.size, 1);
});

test('fs_game filtering falls back to the whole list rather than showing an empty browser', async () => {
  const r = new Registry({ probe: async () => ({ si_name: 'M', fs_game: 'q4max' }), seeds: ['1.1.1.1:28004'] });
  await r.sweep();
  assert.equal(r.list({ fsGame: 'q4max' }).length, 1, 'exact match');
  assert.equal(r.list({ fsGame: 'Q4MAX' }).length, 1, 'case-insensitive');
  assert.equal(r.list({ fsGame: 'somethingelse' }).length, 1, 'falls back to all, not zero');
  assert.equal(r.list().length, 1);
});

test('splitAddress accepts real addresses and rejects the rest', () => {
  assert.deepEqual(splitAddress('66.55.137.189:28004'), { ip: '66.55.137.189', port: 28004 });
  for (const bad of ['host.example.net:28004', '1.2.3:28004', '1.2.3.999:28004', '1.2.3.4:0', '1.2.3.4:99999', 'nonsense', '']) {
    assert.equal(splitAddress(bad), null, `rejects ${bad}`);
  }
});
