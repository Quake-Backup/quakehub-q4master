# q4master

An open-source master server for idTech4 games: **Quake 4**, Doom 3 and Prey.

Quake 4 has no working master server. id's shut down years ago, the community replacement
(`q4masterserver.baseq.fr`) went with whoever ran it, and the one person known to have a working
implementation has said he won't publish the source. So the in-game server browser is empty for
everyone, and every Quake 4 server list that exists is maintained by hand in someone's text file.

This is that missing piece, MIT licensed, so nobody has to ask permission to run one.

It is about 300 lines. The protocol is documented in full below, so even if this repository
disappears, anyone can rebuild it from these notes.

---

## Quick start

```bash
git clone https://github.com/booskibro/q4master
cd q4master
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
docker build -t q4master .
docker run -p 27650:27650/udp q4master
```

---

## Pointing Quake 4 at it

**Players** (retail or GOG Quake 4), in the console or in `autoexec.cfg`:

```
seta net_master0 "your-master.example.net"
```

It must be `net_master0`. The client hardcodes slot 0 when it asks for the list
(`idAsyncClient::GetNETServers`), so `net_master1` through `4` are read by nothing. The cvar
isn't saved between sessions, which is why `autoexec.cfg` is the right place for it.

> **openQ4 users:** this does not work on [openQ4](https://github.com/themuffinator/openQ4).
> It declares `net_master0` as `CVAR_ROM`, so slot 0 is both the only slot queried and
> unwritable. Fixing that is a small patch to `AsyncNetwork.cpp` if anyone wants to send one.

**Server operators**, in your server config:

```
seta net_master1 "your-master.example.net:27650"
```

Your server will announce itself every 5 minutes. You can use slot 1 and up here because the
*server* side does loop over all five slots, so you can advertise to several masters at once
without giving any of them up.

You do not have to do this to be listed. The master probes its seed list directly too, which is
how it works at all for the surviving Quake 4 servers, none of which were configured to
heartbeat anyone.

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
