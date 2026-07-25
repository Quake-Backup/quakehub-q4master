// The master itself: one UDP socket, three message types, no state beyond the registry.

import dgram from 'node:dgram';
import {
  parseCommand, parseGetServers, buildServersReply, buildGetInfo,
  isInfoResponse, parseInfoResponse, DEFAULT_PORT,
} from './protocol.js';
import { Registry } from './registry.js';

/**
 * Send a getInfo to a server and resolve its info dict, or null if it doesn't answer.
 * Each probe uses its own ephemeral socket so replies can never be confused with each other
 * or with traffic arriving on the master's listening port.
 */
export function probeServer(ip, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on('message', (msg) => done(isInfoResponse(msg) ? parseInfoResponse(msg) : null));
    sock.on('error', () => done(null));
    sock.send(buildGetInfo(), port, ip, (err) => { if (err) done(null); });
  });
}

export function createMaster({
  port = DEFAULT_PORT,
  seeds = [],
  strictGameFilter = false,
  probe = probeServer,
  log = console.log,
  ...registryOpts
} = {}) {
  const registry = new Registry({ probe, seeds, ...registryOpts });
  const sock = dgram.createSocket('udp4');
  let sweepTimer = null;

  sock.on('message', (msg, from) => {
    const parsed = parseCommand(msg);
    if (!parsed) return; // not an idTech4 packet; ignore silently

    if (parsed.command === 'heartbeat') {
      // The source address is the server's own game socket, so this is the address to list.
      // We probe it before believing it, which also means a spoofed heartbeat achieves nothing.
      registry.heartbeat(from.address, from.port).then((ok) => {
        log(`[heartbeat] ${from.address}:${from.port} ${ok ? 'verified' : 'did not answer getInfo, ignored'}`);
      });
      return;
    }

    if (parsed.command === 'getServers') {
      const { protocol, fsGame } = parseGetServers(parsed.rest);
      const servers = registry.list(strictGameFilter ? { fsGame } : {});
      const packets = buildServersReply(servers);
      for (const p of packets) sock.send(p, from.port, from.address);
      log(`[getServers] ${from.address}:${from.port} protocol=${protocol} fs_game="${fsGame}" -> ${servers.length} servers in ${packets.length} packet(s)`);
      return;
    }

    // getInfo arrives if someone points a server browser straight at us. Nothing to say.
  });

  return {
    registry,
    socket: sock,
    async start() {
      await new Promise((resolve, reject) => {
        sock.once('error', reject);
        sock.bind(port, () => { sock.removeListener('error', reject); resolve(); });
      });
      log(`[master] listening on UDP ${sock.address().port}`);
      // Probe everything once at boot so the first client to ask gets a real list, then keep
      // it fresh. unref so the timer alone never holds the process open.
      await registry.sweep();
      log(`[master] ${registry.size} server(s) verified`);
      sweepTimer = setInterval(() => {
        registry.sweep().then(() => log(`[master] ${registry.size} server(s) verified`));
      }, registry.opts.sweepMs);
      sweepTimer.unref?.();
      return this;
    },
    async stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      await new Promise((resolve) => sock.close(resolve));
    },
  };
}
