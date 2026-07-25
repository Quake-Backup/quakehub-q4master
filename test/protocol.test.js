// Wire-format tests. These are the bits that must match the engine byte for byte, because a
// client that mis-parses the reply shows an empty browser and gives no error.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  oob, parseCommand, parseGetServers, buildServersReply, parseServersReply,
  buildGetInfo, isInfoResponse, parseInfoResponse, MAX_PAYLOAD,
} from '../src/protocol.js';

test('every packet opens with the connectionless marker and a NUL-terminated command', () => {
  const p = oob('servers');
  assert.deepEqual([...p.subarray(0, 2)], [0xff, 0xff]);
  assert.equal(p.toString('latin1', 2), 'servers\0');
});

test('a getServers request round-trips protocol version and fs_game', () => {
  const body = Buffer.alloc(4 + 6);
  body.writeUInt32LE((2 << 16) | 0, 0);
  body.write('q4max\0', 4, 'latin1');
  const parsed = parseCommand(oob('getServers', body));
  assert.equal(parsed.command, 'getServers');
  assert.deepEqual(parseGetServers(parsed.rest), { protocol: 131072, fsGame: 'q4max' });
});

test('the servers reply uses 4-byte IP + little-endian port, as ProcessServersListMessage reads it', () => {
  const [packet] = buildServersReply([{ ip: '66.55.137.189', port: 28004 }]);
  const body = packet.subarray(oob('servers').length);
  assert.deepEqual([...body.subarray(0, 4)], [66, 55, 137, 189]);
  // 28004 = 0x6D64. Little-endian means 0x64 then 0x6D; big-endian would put the client on
  // port 25709 and every connect would fail.
  assert.deepEqual([...body.subarray(4, 6)], [0x64, 0x6d]);
  assert.deepEqual(parseServersReply(packet), ['66.55.137.189:28004']);
});

test('addresses survive a full encode/decode cycle', () => {
  const servers = [
    { ip: '1.2.3.4', port: 27650 },
    { ip: '255.255.255.255', port: 65535 },
    { ip: '10.0.0.1', port: 1 },
  ];
  const [packet] = buildServersReply(servers);
  assert.deepEqual(parseServersReply(packet), ['1.2.3.4:27650', '255.255.255.255:65535', '10.0.0.1:1']);
});

test('malformed entries are dropped, never emitted as garbage addresses', () => {
  const packets = buildServersReply([
    { ip: '1.2.3.4', port: 28004 },
    { ip: '1.2.3', port: 28004 },        // too few octets
    { ip: '1.2.3.999', port: 28004 },    // octet out of range
    { ip: '1.2.3.5', port: 0 },          // invalid port
    { ip: '1.2.3.6', port: 70000 },      // port out of range
    { ip: 'not.an.ip.addr', port: 28004 },
  ]);
  assert.deepEqual(parseServersReply(packets[0]), ['1.2.3.4:28004']);
});

test('an empty list produces no packet at all, rather than a bare header', () => {
  assert.deepEqual(buildServersReply([]), []);
});

test('long lists split into MTU-safe packets instead of one oversized datagram', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ ip: `10.0.${(i / 256) | 0}.${i % 256}`, port: 28004 }));
  const packets = buildServersReply(many);
  assert.ok(packets.length > 1, 'splits');
  for (const p of packets) assert.ok(p.length <= MAX_PAYLOAD, `packet ${p.length} within MTU budget`);
  // Nothing may be lost in the split: the client appends packets, so the union must be exact.
  const all = packets.flatMap(parseServersReply);
  assert.equal(all.length, 500);
  assert.equal(all[0], '10.0.0.0:28004');
  assert.equal(all[499], '10.0.1.243:28004'); // 499 = 1*256 + 243
});

test('non-idTech4 traffic is rejected rather than misparsed', () => {
  for (const junk of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('GET / HTTP/1.1'), Buffer.from([0xff, 0xff])]) {
    assert.equal(parseCommand(junk), null);
  }
});

test('getInfo probe and infoResponse handling', () => {
  assert.equal(buildGetInfo().toString('latin1', 2), 'getInfo\0');
  // A realistic infoResponse: command, binary preamble, then the NUL-delimited dict.
  const res = Buffer.concat([
    Buffer.from([0xff, 0xff]), Buffer.from('infoResponse\0', 'latin1'),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    Buffer.from('si_name\0Test Server\0fs_game\0q4max\0\0', 'latin1'),
  ]);
  assert.ok(isInfoResponse(res));
  const info = parseInfoResponse(res);
  assert.equal(info.si_name, 'Test Server');
  assert.equal(info.fs_game, 'q4max');
  assert.equal(isInfoResponse(oob('servers')), false);
});
