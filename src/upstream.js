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
// Relaying costs us nothing and keeps the promise the instruction always made: put us in slot 0
// and the browser works. It just has to be true that everything ELSE still reaches id.

import dgram from 'node:dgram';

export const ID_MASTER_HOST = 'q4master.idsoftware.com';
export const ID_MASTER_PORT = 27650;

/**
 * Build a forwarder. Each in-flight request gets its own ephemeral socket so replies can never be
 * confused with each other or with the master's own listening port.
 *
 * The reply MUST be sent back over the master's own socket: the client is waiting for an answer
 * from the address it wrote to, and a datagram from anywhere else is ignored.
 *
 * @param {object} opts
 * @param {string} opts.host      upstream master (default: id's)
 * @param {number} opts.port      upstream port
 * @param {number} opts.timeoutMs how long to wait before giving up on upstream
 * @param {Function} opts.log
 * @param {Function} opts.sendImpl  test seam: (msg, port, host, cb) => void
 */
export function createUpstreamProxy({
  host = ID_MASTER_HOST,
  port = ID_MASTER_PORT,
  timeoutMs = 3000,
  maxInFlight = 64,
  log = console.log,
  sendImpl = null,
} = {}) {
  let inFlight = 0;

  /**
   * @param {Buffer} msg      the client's packet, forwarded byte for byte
   * @param {{address:string, port:number}} from  who asked
   * @param {(reply: Buffer) => void} reply       hands the answer back over the master's socket
   */
  function forward(msg, from, reply) {
    // A flood of unanswerable packets must not turn into unbounded sockets. Dropping is exactly
    // what we did before this existed, so the failure mode is no worse than the old behaviour.
    if (inFlight >= maxInFlight) {
      log(`[upstream] dropped a packet from ${from.address}: ${inFlight} already in flight`);
      return;
    }
    inFlight += 1;

    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (replyMsg) => {
      if (settled) return;
      settled = true;
      inFlight -= 1;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      if (replyMsg) reply(replyMsg);
    };

    const timer = setTimeout(() => {
      log(`[upstream] ${host}:${port} did not answer for ${from.address}:${from.port}`);
      done(null);
    }, timeoutMs);

    sock.on('message', (replyMsg) => done(replyMsg));
    sock.on('error', (err) => { log(`[upstream] ${err.message}`); done(null); });
    const send = sendImpl || ((m, p, h, cb) => sock.send(m, p, h, cb));
    send(msg, port, host, (err) => { if (err) { log(`[upstream] send: ${err.message}`); done(null); } });
  }

  return { forward, get inFlight() { return inFlight; } };
}
