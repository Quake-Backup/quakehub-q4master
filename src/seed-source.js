// Optional: pull the seed list from an HTTP endpoint instead of (or as well as) seeds.json.
//
// The bundled seeds.json is a snapshot. It cannot show a dead server, because everything is
// probed before it is listed, but it can go *incomplete* — if a new Quake 4 server appears, a
// frozen file never learns about it. That is the same rot that leaves the PlayQ4 launcher
// shipping 17 addresses of which 1 answers, just in a less visible form.
//
// Pointing Q4MASTER_SEEDS_URL at a live list fixes that. It is off by default and deliberately
// takes ANY url, because a master whose seed list is hardcoded to one project's API would
// recreate the single point of failure this whole repository exists to remove. Run it against
// quakehub, against your own list, against a file on your own web server, or against nothing.

// A compromised or simply broken endpoint should not be able to flood the probe loop.
const MAX_SEEDS = 500;

/**
 * Pull addresses out of whatever JSON shape the endpoint returns. Deliberately permissive:
 * server lists in the wild are arrays of strings, arrays of objects with an `address`, or a
 * wrapper object around either. Anything unrecognisable yields [] rather than throwing.
 */
export function extractAddresses(json) {
  const rows = Array.isArray(json)
    ? json
    : (json && typeof json === 'object'
      && (json.servers || json.data || Object.values(json).find(Array.isArray))) || [];
  if (!Array.isArray(rows)) return [];

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    let addr = null;
    if (typeof row === 'string') {
      addr = row;
    } else if (row && typeof row === 'object') {
      if (typeof row.address === 'string') addr = row.address;
      else if (row.ip != null && row.port != null) addr = `${row.ip}:${row.port}`;
      else if (typeof row.host === 'string' && row.port != null) addr = `${row.host}:${row.port}`;
    }
    if (typeof addr !== 'string') continue;
    addr = addr.trim();
    // host:port, where host is a dotted quad or a DNS name. The registry resolves names itself.
    if (!/^[A-Za-z0-9._-]+:\d{1,5}$/.test(addr)) continue;
    const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
    if (out.length >= MAX_SEEDS) break;
  }
  return out;
}

/**
 * Fetch and parse a remote seed list.
 * @returns {Promise<string[]>} addresses; throws on network/HTTP/JSON failure so the caller can
 *   decide what to do (which is always: keep the previous list, never shrink to nothing).
 */
export async function fetchSeeds(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'quakehub-q4master (+https://github.com/booskibro/quakehub-q4master)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return extractAddresses(await res.json());
}
