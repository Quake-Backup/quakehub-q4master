// The master itself: one UDP socket, three message types, no state beyond the registry.

import dgram from 'node:dgram';
import {
  parseCommand, parseGetServers, buildServersReply, buildGetInfo,
  isInfoResponse, parseInfoResponse, DEFAULT_PORT,
} from './protocol.js';
import { Registry } from './registry.js';
import { fetchSeeds } from './seed-source.js';
import { createUpstreamProxy, ID_MASTER_HOST, ID_MASTER_PORT } from './upstream.js';

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
  seedsUrl = null,
  strictGameFilter = false,
  probe = probeServer,
  fetchSeedsImpl = fetchSeeds,
  log = console.log,
  // Relay anything we do not serve ourselves to id's master, which still handles client auth.
  // Set upstreamHost to '' to switch it off and go back to dropping - only sensible if you are
  // certain none of your users put you in net_master0.
  upstreamHost = ID_MASTER_HOST,
  upstreamPort = ID_MASTER_PORT,
  upstreamImpl = null,
  ...registryOpts
} = {}) {
  const registry = new Registry({ probe, seeds, ...registryOpts });
  const sock = dgram.createSocket('udp4');
  let sweepTimer = null;
  const upstream = upstreamHost
    ? (upstreamImpl || createUpstreamProxy({ host: upstreamHost, port: upstreamPort, log }))
    : null;

  // Refresh the remote seed list, if one is configured. Never throws: a seed source that is
  // down must not stop us probing everything we already know about.
  async function refreshRemoteSeeds() {
    if (!seedsUrl) return;
    try {
      const list = await fetchSeedsImpl(seedsUrl);
      if (!list.length) {
        log(`[seeds] ${seedsUrl} returned no usable addresses; keeping the previous ${registry.remoteSeeds.size}`);
        return;
      }
      registry.setRemoteSeeds(list);
      log(`[seeds] ${list.length} address(es) from ${seedsUrl}`);
    } catch (err) {
      log(`[seeds] ${seedsUrl}: ${err.message} (keeping the previous ${registry.remoteSeeds.size})`);
    }
  }

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

    // EVERYTHING ELSE GOES UPSTREAM. This used to be a silent drop, and that drop is what broke
    // authorisation for anyone who put us in net_master0: id's master serves both the (dead)
    // server list and the (still very much alive) client auth on the same host and port, so
    // answering getServers and ignoring the rest fixed the browser and quietly removed auth.
    // See upstream.js for the full account.
    if (upstream) {
      log(`[upstream] ${parsed.command || 'unknown'} from ${from.address}:${from.port} -> ${upstreamHost}`);
      upstream.forward(msg, from, (replyMsg) => sock.send(replyMsg, from.port, from.address));
    }
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
      log(upstream
        ? `[master] relaying non-list traffic to ${upstreamHost}:${upstreamPort} (this is what keeps auth working)`
        : '[master] upstream relay DISABLED - clients using net_master0 will not be able to authorise');
      // Probe everything once at boot so the first client to ask gets a real list, then keep
      // it fresh. unref so the timer alone never holds the process open.
      await refreshRemoteSeeds();
      await registry.sweep();
      log(`[master] ${registry.size} server(s) verified`);
      sweepTimer = setInterval(() => {
        refreshRemoteSeeds()
          .then(() => registry.sweep())
          .then(() => log(`[master] ${registry.size} server(s) verified`));
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
