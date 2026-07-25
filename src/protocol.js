// The idTech4 master-server wire protocol, as implemented by Quake 4, Doom 3 and Prey.
//
// Everything is UDP and connectionless. Each packet opens with idBitMsg's
// CONNECTIONLESS_MESSAGE_ID, written by WriteShort as two little-endian bytes (0xFF 0xFF),
// followed by a NUL-terminated command word. idBitMsg::WriteBits fills bytes LSB-first
// (neo/idlib/BitMsg.cpp), so every multi-byte integer on the wire is little-endian.
//
// Three messages matter to a master:
//
//   server -> master   \xFF\xFF "heartbeat\0"
//       Fire-and-forget, every HEARTBEAT_MSEC (5 minutes, neo/framework/async/AsyncServer.cpp).
//       No reply is expected or required. It arrives over the server's own game socket, so the
//       packet's source address IS the address to list. That is the whole trick: we never have
//       to parse an address out of the payload, and a server cannot announce someone else.
//
//   client -> master   \xFF\xFF "getServers\0" <int32 protocol> <fs_game\0> <6 bits of filters>
//       Sent by idAsyncClient::GetNETServers.
//
//   master -> client   \xFF\xFF "servers\0" then, repeated: <ip 4 bytes> <port int16 LE>
//       Parsed by idAsyncClient::ProcessServersListMessage, which loops until the packet is
//       exhausted. There is no count field, no terminator and no authentication.
//
// The client only accepts this reply from the address it asked (Sys_CompareNetAdrBase against
// net_master0), so the reply must leave from the same socket the request arrived on.

export const OOB = Buffer.from([0xff, 0xff]);

// Quake 4 servers and clients live here by convention; id's own master used 27650.
export const DEFAULT_PORT = 27650;

// A getServers reply has no length field, so we simply must not exceed the path MTU or the
// packet fragments and is likely dropped. 1200 bytes of payload is the usual safe figure for
// UDP over the open internet; at 6 bytes per server that is ~198 servers per packet, and the
// client happily accepts several packets in a row because it appends rather than replaces.
export const MAX_PAYLOAD = 1200;
const BYTES_PER_SERVER = 6;

/** Build any out-of-band command packet: \xFF\xFF + "<command>\0" + optional body. */
export function oob(command, body) {
  const head = Buffer.concat([OOB, Buffer.from(`${command}\0`, 'latin1')]);
  return body ? Buffer.concat([head, body]) : head;
}

/**
 * Read the command word off an inbound packet.
 * @returns {{command: string, rest: Buffer}|null} null if it isn't an idTech4 OOB packet.
 */
export function parseCommand(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xff) return null;
  const end = buf.indexOf(0, 2);
  if (end === -1) return null;
  return { command: buf.toString('latin1', 2, end), rest: buf.subarray(end + 1) };
}

/**
 * Decode the body of a getServers request. The trailing filter bits are advisory and we do not
 * act on them, but the protocol version and fs_game tell us what the client can actually join.
 * Tolerant by design: a truncated or odd request still yields a usable object rather than
 * throwing, because the correct response to a weird client is a server list, not a stack trace.
 */
export function parseGetServers(rest) {
  if (!Buffer.isBuffer(rest) || rest.length < 4) return { protocol: 0, fsGame: '' };
  const protocol = rest.readUInt32LE(0);
  const end = rest.indexOf(0, 4);
  const fsGame = end === -1 ? rest.toString('latin1', 4) : rest.toString('latin1', 4, end);
  return { protocol, fsGame };
}

/** The `getInfo` probe we use to prove a heartbeat came from a real, running server. */
export function buildGetInfo() {
  return oob('getInfo');
}

/** True if a packet is the infoResponse to our getInfo probe. */
export function isInfoResponse(buf) {
  const parsed = parseCommand(buf);
  return parsed !== null && parsed.command === 'infoResponse';
}

/**
 * Pull the NUL-delimited key/value dictionary out of an infoResponse. Used only to record what
 * mod a verified server runs, so `getServers` can honour a client's fs_game if asked to.
 */
export function parseInfoResponse(buf) {
  const at = buf.indexOf('infoResponse');
  if (at === -1) return {};
  let p = at + 'infoResponse'.length;
  // Skip the binary preamble (challenge + protocol) to the first lowercase key byte.
  while (p < buf.length && !(buf[p] >= 0x61 && buf[p] <= 0x7a)) p++;
  const info = {};
  while (p < buf.length) {
    const kEnd = buf.indexOf(0, p);
    if (kEnd === -1) break;
    const key = buf.toString('latin1', p, kEnd);
    p = kEnd + 1;
    if (key === '') break;
    const vEnd = buf.indexOf(0, p);
    if (vEnd === -1) break;
    info[key] = buf.toString('latin1', p, vEnd);
    p = vEnd + 1;
  }
  return info;
}

/**
 * Encode a server list into one or more `servers` replies.
 * @param {Array<{ip: string, port: number}>} servers
 * @returns {Buffer[]} one packet per MAX_PAYLOAD worth of entries; [] if there is nothing to send.
 */
export function buildServersReply(servers) {
  const usable = [];
  for (const s of servers) {
    const octets = String(s.ip).split('.');
    if (octets.length !== 4) continue;
    const bytes = octets.map(Number);
    if (bytes.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) continue;
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    usable.push({ bytes, port });
  }
  if (!usable.length) return [];

  const header = oob('servers');
  const perPacket = Math.floor((MAX_PAYLOAD - header.length) / BYTES_PER_SERVER);
  const packets = [];
  for (let i = 0; i < usable.length; i += perPacket) {
    const slice = usable.slice(i, i + perPacket);
    const body = Buffer.alloc(slice.length * BYTES_PER_SERVER);
    let o = 0;
    for (const { bytes, port } of slice) {
      body[o++] = bytes[0]; body[o++] = bytes[1]; body[o++] = bytes[2]; body[o++] = bytes[3];
      body.writeUInt16LE(port, o); o += 2;
    }
    packets.push(Buffer.concat([header, body]));
  }
  return packets;
}

/** Decode a `servers` reply. Used by the tests and by the bundled client. */
export function parseServersReply(buf) {
  const parsed = parseCommand(buf);
  if (!parsed || parsed.command !== 'servers') return [];
  const out = [];
  const b = parsed.rest;
  for (let p = 0; p + BYTES_PER_SERVER <= b.length; p += BYTES_PER_SERVER) {
    out.push(`${b[p]}.${b[p + 1]}.${b[p + 2]}.${b[p + 3]}:${b.readUInt16LE(p + 4)}`);
  }
  return out;
}
