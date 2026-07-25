// Entry point. Configuration is all environment variables so a container needs no config file.
//
//   Q4MASTER_PORT          UDP port to listen on            (default 27650)
//   Q4MASTER_SEEDS         comma-separated addresses, overrides seeds.json entirely
//   Q4MASTER_SEEDS_FILE    path to a JSON file like seeds.json (default ./seeds.json)
//   Q4MASTER_STRICT_GAME   "1" to honour the client's fs_game filter (see below)
//   Q4MASTER_QUIET         "1" to suppress per-request logging
//
// On fs_game filtering: the retail master filtered the list by the mod the client was running.
// We default to NOT doing that, and the reason is specific to Quake 4 in 2026. The surviving
// scene is about twenty servers, most of them running q4max, and a player who opens an empty
// browser concludes the game is dead and quits. Showing them every live server, even ones whose
// mod they will be prompted to download, is the friendlier failure. Set Q4MASTER_STRICT_GAME=1
// for the historically accurate behaviour.

import { readFileSync } from 'node:fs';
import { createMaster } from './master.js';
import { DEFAULT_PORT } from './protocol.js';

function loadSeeds() {
  const inline = process.env.Q4MASTER_SEEDS;
  if (inline) return inline.split(',').map((s) => s.trim()).filter(Boolean);

  const file = process.env.Q4MASTER_SEEDS_FILE || new URL('../seeds.json', import.meta.url);
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.servers;
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch (err) {
    // Not fatal. A master with no seeds still works; it just stays empty until servers
    // heartbeat it, which is the correct behaviour for someone running this for a new game.
    console.warn(`[master] no seed list loaded (${err.message}); starting with heartbeats only`);
    return [];
  }
}

const quiet = process.env.Q4MASTER_QUIET === '1';

const master = createMaster({
  port: Number(process.env.Q4MASTER_PORT) || DEFAULT_PORT,
  seeds: loadSeeds(),
  strictGameFilter: process.env.Q4MASTER_STRICT_GAME === '1',
  log: quiet ? () => {} : console.log,
});

await master.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    master.stop().then(() => process.exit(0));
  });
}
