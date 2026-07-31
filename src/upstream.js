// Forward anything we don't serve ourselves to id's original master, and relay the answer back.
//
// This exists because port 27650 on q4master.idsoftware.com carries TWO services, and only one of
// them died. Server LISTS have returned nothing for years, which is why the in-game browser is
// empty and why this project exists. But client AUTHORISATION on that same host and port is still
// alive - the engine has a dedicated "Authorize server timed out" error and a
// "server %s requests master authorization for this client" path, both of which go here.
//
// So a master that answers getServers and drops everything else fixes the browser and silently
// removes auth. It does not fail immediately, which is what made it so hard to spot: a client
// keeps working on its existing GUID until that needs renewing, and only then does it sit on
// "waiting for authorisation" before giving up with "Client unknown to auth". Reported by a
// player in Germany two days after he set net_master0 to us, and reproduced here.
//
// THE RELAY MUST BE A SESSION, NOT A ONE-SHOT. The first version forwarded each packet on its
// own ephemeral socket and closed it after the first reply - a request/response shape that CD-key
// auth simply does not have. The exchange is a CONVERSATION: the client submits its key, the auth
// server answers with a challenge, the client responds, the server delivers the verdict - several
// datagrams each way, and id's auth server tracks the conversation by SOURCE ADDRESS AND PORT.
// One socket per packet meant every round arrived at id from a different port, so round two
// looked like a stranger opening a malformed exchange, id answered with an explicit deny, and the
// engine treats an explicit deny as a bad key: it CLEARS the stored CD key and prompts again.
// Reported on the Q4 Discord within a day of the relay shipping - "my cd key is reset each time
// I try to run a map or join a server" - which is exactly that deny, once per auth attempt.
//
// So: one upstream socket PER CLIENT, held for the life of the conversation (and a generous
// idle window beyond it), with EVERY reply datagram relayed back - not just the first. The
// client's whole exchange leaves us from one stable port, which is as close to talking to id
// directly as a relay can be.

import dgram from 'node:dgram';

export const ID_MASTER_HOST = 'q4master.idsoftware.com';
export const ID_MASTER_PORT = 27650;

/**
 * Build the session-sticky forwarder.
 *
 * The reply MUST be sent back over the master's own socket: the client is waiting for an answer
 * from the address it wrote to (Sys_CompareNetAdrBase against net_master0), and a datagram from
 * anywhere else is ignored.
 *
 * @param {object} opts
 * @param {string} opts.host        upstream master (default: id's)
 * @param {number} opts.port        upstream port
 * @param {number} opts.idleMs      forget a client's session this long after its last packet
 *                                  in either direction. Auth rounds are seconds apart; two
 *                                  minutes comfortably covers a slow exchange plus the re-auth
 *                                  a map change triggers, without holding sockets for hours.
 * @param {number} opts.maxSessions bound on concurrent client sessions. Dropping past the cap
 *                                  is exactly what we did before the relay existed, so a flood
 *                                  degrades to the old behaviour, never to unbounded sockets.
 * @param {Function} opts.log
 * @param {Function} opts.sendImpl  test seam: (msg, port, host, cb) => void
 */
export function createUpstreamProxy({
  host = ID_MASTER_HOST,
  port = ID_MASTER_PORT,
  idleMs = 120_000,
  maxSessions = 256,
  sweepMs = 30_000,
  log = console.log,
  sendImpl = null,
} = {}) {
  const sessions = new Map(); // "address:port" -> { sock, seen, reply }

  function destroy(key) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    try { s.sock.close(); } catch { /* already closed */ }
  }

  /** Reap sessions idle past the window. Exposed for tests; runs on its own timer in service. */
  function sweep(now = Date.now()) {
    for (const [key, s] of sessions) if (now - s.seen > idleMs) destroy(key);
  }
  const sweepTimer = setInterval(sweep, sweepMs);
  sweepTimer.unref?.();

  /**
   * @param {Buffer} msg      the client's packet, forwarded byte for byte
   * @param {{address:string, port:number}} from  who asked
   * @param {(reply: Buffer) => void} reply       hands answers back over the master's socket
   */
  function forward(msg, from, reply) {
    const key = `${from.address}:${from.port}`;
    let s = sessions.get(key);
    if (!s) {
      if (sessions.size >= maxSessions) {
        log(`[upstream] dropped a packet from ${from.address}: ${sessions.size} sessions already open`);
        return;
      }
      const sock = dgram.createSocket('udp4');
      s = { sock, seen: Date.now(), reply };
      // EVERY upstream datagram goes back to the client for as long as the session lives.
      // The auth verdict is often not the first reply, and closing after one datagram is the
      // exact bug this file's header documents.
      sock.on('message', (replyMsg) => { s.seen = Date.now(); s.reply(replyMsg); });
      sock.on('error', (err) => { log(`[upstream] ${key}: ${err.message}`); destroy(key); });
      sessions.set(key, s);
    }
    s.seen = Date.now();
    s.reply = reply; // the latest callback captures the same client address; keep it fresh
    const send = sendImpl || ((m, p, h, cb) => s.sock.send(m, p, h, cb));
    send(msg, port, host, (err) => {
      if (err) { log(`[upstream] send: ${err.message}`); destroy(key); }
    });
  }

  /** Shut down: stop the sweeper and close every session socket. */
  function close() {
    clearInterval(sweepTimer);
    for (const key of [...sessions.keys()]) destroy(key);
  }

  return { forward, sweep, close, get sessionCount() { return sessions.size; } };
}
