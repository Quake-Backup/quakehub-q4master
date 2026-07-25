// The list of servers the master hands out.
//
// Two ways in, and both end at the same gate: nothing is listed until it answers a `getInfo`
// probe from us directly.
//
//   heartbeats  - a server running `set net_master1 "<you>:27650"` announces itself every 5
//                 minutes. The source address of that packet is the address we probe.
//   seeds       - addresses configured by the operator. Quake 4's surviving servers were set up
//                 years ago and almost none of them send heartbeats to anyone, so without seeds
//                 a fresh master is empty forever. Seeds are re-probed on the same schedule.
//
// Verifying rather than trusting is what keeps this honest. Every other Quake 4 list in
// existence is hand-maintained and mostly dead: the PlayQ4 launcher ships 17 addresses of which
// 1 still answers. A list that verifies cannot rot, and it also means a hostile server cannot
// register an address it does not control, because we probe the address rather than the payload.

import { promises as dns } from 'node:dns';

const MINUTE = 60 * 1000;

const defaultResolve = (host) => dns.resolve4(host);

export const DEFAULTS = {
  // A server heartbeats every 5 minutes. Three misses before we drop it, so a brief network
  // blip or a map change never empties the browser.
  ttlMs: 16 * MINUTE,
  // How often to re-probe everything we know about.
  sweepMs: 3 * MINUTE,
  probeTimeoutMs: 2500,
};

export class Registry {
  /**
   * @param {object} opts
   * @param {(ip: string, port: number, timeoutMs: number) => Promise<object|null>} opts.probe
   *   Returns the server's info dict if it answers, else null.
   */
  constructor({ probe, seeds = [], now = () => Date.now(), resolve = defaultResolve, ...opts } = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.probe = probe;
    this.now = now;
    this.resolve = resolve;
    this.seeds = new Set(seeds);
    /** @type {Map<string, {ip:string, port:number, lastSeen:number, fsGame:string, name:string}>} */
    this.servers = new Map();
  }

  /** A server said hello. Probe it; list it only if it answers. */
  async heartbeat(ip, port) {
    return this.#verify(ip, port);
  }

  /** Re-probe everything: known servers keep their slot, dead ones age out, seeds get a chance. */
  async sweep() {
    const targets = new Map();
    for (const [key, s] of this.servers) targets.set(key, { ip: s.ip, port: s.port });
    // Seeds may be hostnames. Several surviving Quake 4 servers sit behind dynamic DNS
    // (arenacamper.ddns.net and friends), so resolving every sweep rather than once at startup
    // is what keeps them listed after their address changes under them.
    for (const addr of this.seeds) {
      for (const parsed of await this.#resolveSeed(addr)) {
        targets.set(`${parsed.ip}:${parsed.port}`, parsed);
      }
    }
    await Promise.all([...targets.values()].map(({ ip, port }) => this.#verify(ip, port)));
    this.#expire();
  }

  async #resolveSeed(addr) {
    const direct = splitAddress(addr);
    if (direct) return [direct];
    const at = String(addr).lastIndexOf(':');
    if (at === -1) return [];
    const host = String(addr).slice(0, at);
    const port = Number(String(addr).slice(at + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
    try {
      const ips = await this.resolve(host);
      return ips.map((ip) => ({ ip, port }));
    } catch {
      return [];
    }
  }

  async #verify(ip, port) {
    let info = null;
    try {
      info = await this.probe(ip, port, this.opts.probeTimeoutMs);
    } catch {
      info = null;
    }
    if (!info) return false;
    this.servers.set(`${ip}:${port}`, {
      ip,
      port,
      lastSeen: this.now(),
      fsGame: String(info.fs_game || info.fs_game_base || ''),
      name: String(info.si_name || `${ip}:${port}`),
    });
    return true;
  }

  #expire() {
    const cutoff = this.now() - this.opts.ttlMs;
    for (const [key, s] of this.servers) {
      if (s.lastSeen < cutoff) this.servers.delete(key);
    }
  }

  /**
   * The servers to advertise.
   * @param {object} [filter]
   * @param {string} [filter.fsGame] The client's mod. See the note in index.js on why the
   *   default is to ignore this rather than filter strictly.
   */
  list({ fsGame } = {}) {
    const all = [...this.servers.values()];
    if (!fsGame) return all;
    const matching = all.filter((s) => s.fsGame.toLowerCase() === fsGame.toLowerCase());
    return matching.length ? matching : all;
  }

  get size() {
    return this.servers.size;
  }
}

/** "1.2.3.4:27650" -> {ip, port}. Returns null for hostnames and malformed input. */
export function splitAddress(addr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(String(addr).trim());
  if (!m) return null;
  const ip = m[1];
  const port = Number(m[2]);
  if (ip.split('.').some((o) => Number(o) > 255)) return null;
  if (port < 1 || port > 65535) return null;
  return { ip, port };
}
