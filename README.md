# quakehub-q4master

An open-source master server for idTech4 games: **Quake 4**, Doom 3 and Prey.

Quake 4 has no working master server. id's shut down years ago, the community replacement
(`q4masterserver.baseq.fr`) went with whoever ran it, and the one person known to have a working
implementation has said he won't publish the source. So the in-game server browser is empty for
everyone, and every Quake 4 server list that exists is maintained by hand in someone's text file.

This is that missing piece, MIT licensed, so nobody has to ask permission to run one.

It is about 300 lines. The protocol is documented in full below, so even if this repository
disappears, anyone can rebuild it from these notes.

---

## What this actually does

It is a phone book, and nothing more.

It keeps a list of Quake 4 servers that are verified to be alive right now. When a Quake 4
client asks "what servers exist?", it answers with a list of addresses. The client then contacts
each of those servers itself to get the map, player count and ping.

The visible result: **the in-game Multiplayer → Internet server browser fills up instead of
being empty.**

### Who this helps

| | Does it help? | What you do |
| --- | --- | --- |
| **Retail or GOG Quake 4** | **Yes** | Set `net_master0`, see [Players](#for-players-retail-or-gog-quake-4) |
| **Dedicated server operators** | **Yes** | Set `net_master1`, see [Server operators](#for-server-operators) |
| **[openQ4](https://github.com/themuffinator/openQ4)** | **No** | Its `net_master0` is read-only. See [openQ4](#openq4) |
| **[PlayQ4 launcher](https://playq4-net.webflow.io/)** | **No** | It has its own browser and never contacts a master. See [PlayQ4](#playq4-launcher) |

### What it does not do

- It does not patch, modify or replace your game. It's a separate service on a server somewhere.
- It does not make old servers work again, or fix Quake 4's file-download problems.
- It does not host games. It only tells clients where games are.
- It is not required for anyone to play. Connecting directly with `connect ip:port` has always
  worked and still does. This just means you don't have to know the IP in advance.

---

## Quick start

```bash
git clone https://github.com/booskibro/quakehub-q4master
cd quakehub-q4master
npm start
```

That's it. No dependencies, no build step, no database. It listens on UDP 27650, probes the
servers in [`seeds.json`](seeds.json), and starts answering.

Check it works:

```bash
npm run list
# 127.0.0.1:27650 -> 19 server(s)
#   66.55.137.189:28004
#   207.148.16.147:28004
#   ...
```

Or with Docker:

```bash
docker build -t quakehub-q4master .
docker run -p 27650:27650/udp quakehub-q4master
```

---

## For players (retail or GOG Quake 4)

**1. Find your Quake 4 folder.**

- Steam: `C:\Program Files (x86)\Steam\steamapps\common\Quake 4\q4base`
  (or in Steam, right-click Quake 4 → Manage → Browse local files, then open `q4base`)
- GOG: `C:\GOG Games\Quake 4\q4base`
- Linux: `~/.quake4/q4base`

If you launch with a mod such as Q4Max (`+set fs_game q4max`), use that mod's folder instead of
`q4base` — that's the directory the game reads config from once the mod is loaded.

**2. Create a file called `autoexec.cfg` in that folder** (plain text, and make sure Windows
hasn't named it `autoexec.cfg.txt`), containing one line:

```
seta net_master0 "master.example.net"
```

Replace `master.example.net` with the address of the master you're using. If it runs on a
non-standard port, write `"master.example.net:27650"`.

**3. Start Quake 4 and go to Multiplayer → Internet.** The list should populate. If it doesn't,
see [Troubleshooting](#troubleshooting).

You can also type the same command into the in-game console (`Ctrl+Alt+~`) to test it without
creating a file, but Quake 4 does not save this cvar between sessions, which is why `autoexec.cfg`
is the permanent answer.

> **It must be `net_master0`.** The client hardcodes slot 0 when it asks for the list
> (`idAsyncClient::GetNETServers`), so `net_master1` through `4` are read by nothing on the
> client side. See [why](#why-net_master1-4-dont-work-for-clients).

### openQ4

**This does not work on [openQ4](https://github.com/themuffinator/openQ4).** It declares
`net_master0` as `CVAR_ROM`, so slot 0 is both the only slot the client queries and the one slot
you cannot write to. There is no config-file workaround; the cvar simply refuses to be set.

Making it work needs a small engine patch, either changing that flag or, better, making
`GetNETServers` loop over all five slots the way the server side already does. If you build
openQ4 yourself, that is a handful of lines in `src/framework/async/`. Pull requests to openQ4
would help everyone.

Until then, openQ4 players find servers the same way they do today: an external list, then
`connect ip:port` in the console.

### PlayQ4 launcher

**This does not help PlayQ4 launcher users either, and it is worth understanding why.**

The [PlayQ4 launcher](https://playq4-net.webflow.io/) does not use a master server at all. It
ships its own list of addresses in `resources/app/cfg/servers.json` inside the application, and
queries each one directly with [gamedig](https://github.com/gamedig/node-gamedig). So it will
show exactly the servers its author put in that file, whatever any master says.

That is a perfectly reasonable design and it is why the launcher works at all when every master
is dead. The tradeoff is that the list only changes when the application is updated, and stale
entries stay forever. At the time of writing the shipped list has 17 addresses and 1 still
answers.

If you maintain a launcher like this, pointing it at a master instead of a bundled file means
your list stays current without shipping a new build. The [`tools/query.js`](tools/query.js) in
this repo is a ~40-line example of asking a master for its list.

---

## For server operators

Add this to your server config:

```
seta net_master1 "master.example.net:27650"
```

Your server then announces itself every 5 minutes and appears in the list automatically, as long
as it answers a `getInfo` probe from the master.

Use slot **1** or higher here, not 0. The *server* side does loop over all five slots
(`AsyncServer.cpp`), so you can advertise to several masters at once without giving up your
existing one. Slot 0 is your own client-side setting.

**You do not have to do this to be listed.** The master also probes its seed list directly,
which is how it works at all for the surviving Quake 4 servers, essentially none of which are
configured to heartbeat anyone. Ask whoever runs the master to add your address, or run your own.

---

## Hosting a master

The service needs **inbound UDP on port 27650** and outbound UDP so it can probe servers.

```bash
# Ubuntu/Debian
sudo ufw allow 27650/udp

# RHEL/Fedora
sudo firewall-cmd --add-port=27650/udp --permanent && sudo firewall-cmd --reload
```

If it's behind NAT or a cloud provider, open 27650/udp in the provider's firewall or security
group too. Note that Cloudflare and most reverse proxies **cannot** proxy UDP, so the hostname
you give players must resolve directly to the machine. A DNS A record pointing at the box is
the whole setup.

Keeping it running with systemd:

```ini
# /etc/systemd/system/quakehub-q4master.service
[Unit]
Description=quakehub-q4master
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/quakehub-q4master/src/index.js
Restart=always
User=nobody

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now quakehub-q4master
sudo systemctl status quakehub-q4master
```

Verify from another machine:

```bash
node tools/query.js your-master.example.net
```

---

## Troubleshooting

**The in-game browser is still empty.**

Check the master is answering at all, from the same machine you're playing on:

```bash
node tools/query.js your-master.example.net
```

- If that prints servers but the game shows none, the game isn't reading your setting. Confirm
  with `net_master0` typed alone in the console; it should echo your address, not
  `q4master.idsoftware.com`. If it echoes id's address, your `autoexec.cfg` isn't being loaded
  (wrong folder, or Windows saved it as `autoexec.cfg.txt`).
- If that prints nothing either, the master is unreachable: firewall, wrong port, or the
  hostname doesn't resolve to the box.

**`net_master0` won't change, it always reads back the old value.** You're on openQ4, where the
cvar is read-only. See [openQ4](#openq4) above.

**My server isn't in the list.** The master only lists servers that answer its `getInfo` probe.
Check your server is reachable from outside your own network (`node tools/query.js` won't help
here; ask someone else to try `connect your-ip:28004`). Firewalled or LAN-only servers, and
servers with `net_LANServer 1` set, will never be listed.

**The list has servers that don't work.** Report it, that's a bug. Every entry is verified within
the last 16 minutes, so a dead entry means the probe is passing when it shouldn't.

---

## What makes this list trustworthy

**Nothing is advertised until it answers a `getInfo` probe from the master itself.** That single
rule is the whole design.

It matters because the alternative is what the community has now. The PlayQ4 launcher ships a
hand-typed list of 17 addresses; at the time of writing 1 of them still answers. Lists rot,
silently, and nobody notices until a player clicks a dead server.

It also means a heartbeat cannot lie. We probe the *source address of the packet*, never an
address supplied in a payload, so a server can only ever register itself.

Servers that stop answering age out after 16 minutes, three missed heartbeats. A single missed
sweep never drops anyone, so a map change or a brief blip doesn't empty the browser.

---

## Configuration

All environment variables, all optional.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Q4MASTER_PORT` | `27650` | UDP port to listen on |
| `Q4MASTER_SEEDS` | - | Comma-separated addresses; overrides the seed file |
| `Q4MASTER_SEEDS_FILE` | `./seeds.json` | Path to a seed list |
| `Q4MASTER_STRICT_GAME` | off | Filter the reply by the client's `fs_game` |
| `Q4MASTER_QUIET` | off | Suppress per-request logging |

Seeds may be `ip:port` or `hostname:port`. Hostnames are re-resolved on every sweep, because
several surviving Quake 4 servers sit behind dynamic DNS and move.

**On `Q4MASTER_STRICT_GAME`:** the retail master filtered the list to the mod the client was
running. This defaults to *not* doing that. Quake 4's surviving scene is about twenty servers,
mostly `q4max`, and a player who opens an empty browser concludes the game is dead and quits.
Showing everything live is the friendlier failure. Turn it on for historically accurate
behaviour.

---

## Using it for Doom 3 or Prey

The protocol is the engine's, not the game's, so this works unchanged. Point it at a different
seed list and tell clients to set `net_master0`. Doom 3 servers listen on 27666 by default and
Prey on 27719; the master itself doesn't care.

---

## The protocol, in full

Everything below was read out of the [Doom 3 GPL source](https://github.com/id-Software/DOOM-3)
(`neo/framework/async/`), which shares the engine with Quake 4, and verified against live
servers. It's written out here so this knowledge isn't trapped in one codebase again.

All traffic is UDP. Every packet opens with idBitMsg's `CONNECTIONLESS_MESSAGE_ID`, written by
`WriteShort` as two little-endian bytes (`0xFF 0xFF`), followed by a NUL-terminated command
word. `idBitMsg::WriteBits` fills bytes LSB-first (`neo/idlib/BitMsg.cpp`), so **every
multi-byte integer on the wire is little-endian**, including the ports.

### Server announces itself

```
server -> master    \xFF\xFF "heartbeat\0"
```

Sent every `HEARTBEAT_MSEC` (5 minutes, `AsyncServer.cpp`) to each configured `net_master`.
Fire-and-forget: the master is not required to reply, and the server doesn't check whether it
did. It goes out over the server's own game socket, so **the packet's source address is the
address to list**. There is no payload to parse and no way to announce someone else.

### Client asks for the list

```
client -> master    \xFF\xFF "getServers\0" <uint32 protocol> <fs_game\0> <6 bits of filters>
```

Sent by `idAsyncClient::GetNETServers`. The filter bits are
`gui_filter_password`, `gui_filter_players` and `gui_filter_gameType`, 2 bits each. This
implementation ignores them.

### Master answers

```
master -> client    \xFF\xFF "servers\0" then repeated: <ip 4 bytes> <port uint16 LE>
```

Read by `idAsyncClient::ProcessServersListMessage`, which loops until the packet is exhausted.
**There is no count field, no terminator, and no authentication.** 6 bytes per server.

Two things will silently break a reply:

1. **It must come from the same address and port the client sent to.** The client checks the
   source with `Sys_CompareNetAdrBase` against `net_master0` and drops anything else. Replying
   from a second socket looks exactly like the master being dead.
2. **Don't exceed the path MTU.** There's no length field, so an oversized datagram just
   fragments and gets dropped. This implementation caps packets at 1200 bytes (~198 servers)
   and sends several when it needs to; the client appends, so multiple packets are fine.

The client then queries each returned address itself with `getInfo`. The master's only job is
the phone book.

### Why `net_master1`-`4` don't work for clients

`AsyncServer.cpp` loops over all five slots when heartbeating:

```c
for ( int i = 0 ; i < MAX_MASTER_SERVERS ; i++ ) {
    if ( idAsyncNetwork::GetMasterAddress( i, adr ) ) {
        outMsg.WriteString( "heartbeat" );
        serverPort.SendPacket( adr, ... );
    }
}
```

But `AsyncClient.cpp` hardcodes slot 0 when asking:

```c
if ( idAsyncNetwork::GetMasterAddress( 0, adr ) ) {
    clientPort.SendPacket( adr, msg.GetData(), msg.GetSize() );
}
```

Every other master reference in the client is the argless overload, which is also index 0. So
servers can advertise to five masters, but clients only ever read one. Aggregating all five
would work fine and dedupe on `ip:port`; nobody has written that patch.

---

## Tests

```bash
npm test
```

27 tests, no dependencies. The protocol tests pin the wire format byte for byte (a big-endian
port would put players on the wrong port with no error message). The master tests run a real
UDP socket with a stand-in dedicated server, so the socket plumbing is covered too, including
that spoofed heartbeats are refused and junk traffic doesn't crash it.

---

## Credits

Protocol notes derived from id Software's GPL release of Doom 3. Seed list from
[quakehub.net](https://quakehub.net), which verifies every Quake 4 server every 90 seconds and
publishes the results as free JSON at `https://quakehub.net/api/v1/servers/q4` if you'd rather
build your own list from a live source.

MIT licensed. Run it, fork it, host it, no permission needed. That's the point.
