# quakehub-q4master

An open-source master server for idTech4 games: **Quake 4**, Doom 3 and Prey.

Quake 4 had no working master server. id's `q4master.idsoftware.com` still resolves and still
answers, but it no longer serves the server **list**. (It does still handle client
**authorisation** - see [below](#it-also-has-to-carry-authorisation-and-that-is-not-optional).
An earlier version of this README said it "answers nothing", which was wrong and mattered.)

**When the list stopped is not settled.** This README used to say it had stopped by January 2022,
which is when someone built `q4masterserver.baseq.fr` to replace it. A server operator who was
using a working list reports it still working as recently as **19 July 2026**, and id's host moved
from `198.20.216.53` to `198.20.216.37` on **30 July 2026**, so there has been recent churn there.
Those two accounts may both be right if the 2026 one was pointed at the community master rather
than id's. We do not know, and rather than pick a winner: as of 30 July 2026 a `getServers` to
id's host goes unanswered while auth through it works. That is the situation this project
addresses, and the list may yet come back.

`q4masterserver.baseq.fr` is NXDOMAIN. The other person known to have a working implementation has
said he won't publish the source. So out of the box the in-game server browser is empty, and every
Quake 4 server list that exists is maintained by hand in someone's text file.

This is that missing piece, MIT licensed, so nobody has to ask permission to run one.

---

## Just want your server browser to work?

**There is a public instance running. Put this one line in your `autoexec.cfg`:**

```
seta net_master0 "master.quakehub.net"
```

Start Quake 4, go to **Multiplayer → Internet**, and the list fills up. Full instructions with
file paths are in [For players](#for-players-retail-or-gog-quake-4).

Run by [quakehub.net](https://quakehub.net), free, no account, nothing to install. It tracks
quakehub's live Quake 4 list, so every server on it was verified within the last few minutes.

**You are not required to use it, and you shouldn't have to trust it.** That's the entire point
of this repository being open: [stand up your own](#hosting-a-master-step-by-step) in about
fifteen minutes, point it wherever you like, and tell people to use yours instead. A community
that depends on one box is exactly the problem this was written to fix.

---

## What this actually does

It is a phone book, and nothing more.

It keeps a list of Quake 4 servers that are verified to be alive right now. When a Quake 4
client asks "what servers exist?", it answers with a list of addresses. The client then contacts
each of those servers itself to get the map, player count and ping.

The visible result: **the in-game Multiplayer → Internet server browser fills up instead of
being empty.**

### It also has to carry authorisation, and that is not optional

`q4master.idsoftware.com:27650` serves **two** things, and only one of them died:

| | Status | Who needs it |
| --- | --- | --- |
| **Server list** | Dead for years. Returns nothing. | Anyone wanting a populated in-game browser |
| **Client authorisation** | **Still alive and required to play** | Everyone, every time a GUID needs renewing |

A master that answers `getServers` and ignores everything else therefore **fixes the browser and
silently breaks the ability to connect**. The failure is delayed and looks unrelated: a client
keeps working on the GUID it already has, and only when that needs renewing does it sit on
"waiting for authorisation" and then fail with **"Client unknown to auth"** - on *every* server,
not just yours. Blanking `net_master0` does not undo it either, because no master at all fails
identically to a silent one.

This happened. A player in Germany lost the ability to play for two days after pointing
`net_master0` here, and it took a long time to identify because the browser was working
perfectly the whole time.

**So this master relays.** Anything that is not a server-list request or a heartbeat is forwarded
verbatim to `q4master.idsoftware.com:27650` and the reply is passed back over the same socket the
client wrote to. Lists come from us, authorisation comes from id. `test/upstream.test.js` pins
this so the drop cannot come back.

**And the relay must be a session, not a one-shot.** The CD-key exchange is a conversation -
challenge, response, verdict, several datagrams each way - and id's auth server tracks it by the
source address *and port* it arrives from. Forwarding each packet on a fresh socket makes every
round look like a new stranger, id answers with a deny, and an explicit deny makes the engine
**wipe the player's stored CD key** ("my cd key is reset each time I try to run a map or join a
server" - reported within a day of a one-shot relay shipping here). Each client therefore keeps
one upstream socket for its whole conversation, and every reply datagram is passed back, not just
the first. Also pinned in `test/upstream.test.js`.

If you fork this or write your own, **that relay is the part you must not skip.** Serving lists is
the easy half - and a request/response relay is not enough, because auth is not request/response.

> **Never hardcode id's IP.** It resolves to `198.20.216.37` today and was `198.20.216.53` until
> 30 July 2026. Use the hostname so a move like that costs you nothing.

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
- It does not replace id's authorisation. It forwards it there. If id's master ever goes
  down for real, nobody can play Quake 4 online and no master can fix that.
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
seta net_master0 "master.quakehub.net"
```

That's the public instance. Swap in your own hostname if you're running one, and add `:27650`
if it listens on a non-standard port.

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
seta net_master1 "master.quakehub.net:27650"
```

Your server then announces itself every 5 minutes and appears in the list automatically, as long
as it answers a `getInfo` probe from the master.

Use slot **1** or higher here, not 0. The *server* side does loop over all five slots
(`AsyncServer.cpp`), so you can advertise to several masters at once without giving up any of
them. Add a second master on `net_master2`, a third on `net_master3`, and you are listed
everywhere at once. Slot 0 is your own client-side setting, leave it for that.

**You do not have to do this to be listed.** The master also probes its seed list directly,
which is how it works at all for the surviving Quake 4 servers, essentially none of which are
configured to heartbeat anyone. The public instance tracks
[quakehub.net](https://quakehub.net)'s Quake 4 list, so if your server shows up there it is
already being served.

---

## Hosting a master, step by step

**Please do run your own.** One master serving everyone is the failure mode that got Quake 4
here in the first place: `q4masterserver.baseq.fr` worked until it didn't, and nobody could
replace it. Several independent masters, each listed by operators on `net_master1` through
`net_master4`, is a scene that survives any one of them going away.

Complete walkthrough on a fresh Ubuntu/Debian box. Takes about fifteen minutes. You need a
machine with a public IP and a domain you can add a DNS record to. It is very light: the public
instance idles at **28 MB of RAM** and negligible CPU, so it sits happily on a box already
running game servers.

### 1. Install Node

```bash
sudo apt update
sudo apt install -y nodejs npm git
node --version    # must be v18 or newer
```

If your distro ships something older than v18, use [NodeSource](https://github.com/nodesource/distributions)
or [nvm](https://github.com/nvm-sh/nvm) instead.

### 2. Get the code

```bash
sudo git clone https://github.com/booskibro/quakehub-q4master /opt/quakehub-q4master
cd /opt/quakehub-q4master
```

There is nothing to install or build. No `npm install`, no dependencies.

### 3. Check it runs

```bash
sudo node src/index.js
```

You should see something like:

```
[master] listening on UDP 27650
[master] 19 server(s) verified
```

If you see `EACCES`, you're not root and the port is privileged; use `sudo`, or pick a high port
with `Q4MASTER_PORT`. Press `Ctrl+C` to stop it for now.

### 4. Open the firewall

The service needs **inbound UDP 27650** so clients can reach it, and **outbound UDP** so it can
probe game servers.

```bash
# Ubuntu/Debian
sudo ufw allow 27650/udp

# RHEL/Fedora
sudo firewall-cmd --add-port=27650/udp --permanent && sudo firewall-cmd --reload
```

**If you're on a cloud provider, that is not enough.** AWS, GCP, Azure, Oracle, Vultr and
friends have their own firewall in front of the machine. Open 27650/UDP in the provider's
security group or firewall rules as well. This is the single most common reason a master looks
dead from outside while working perfectly on the box.

### 5. Point a hostname at it

Add a DNS **A record** for the machine's public IPv4 address:

```
Type   Name      Value
A      master    203.0.113.10
```

giving you `master.yourdomain.net`. That's the address players will use.

> **Do not put it behind Cloudflare's proxy** (the orange cloud), or any reverse proxy.
> Cloudflare does not proxy UDP, so the hostname must resolve straight to your machine. Set the
> record to "DNS only" (grey cloud).

Check it resolves to the right place:

```bash
dig +short master.yourdomain.net
```

### 6. Run it permanently

Create `/etc/systemd/system/quakehub-q4master.service`:

```ini
[Unit]
Description=quakehub-q4master
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/quakehub-q4master/src/index.js
Restart=always
User=nobody
# Optional: track a live server list instead of the bundled snapshot.
# See "Keeping the list current" below.
Environment=Q4MASTER_SEEDS_URL=https://quakehub.net/api/v1/servers/q4

[Install]
WantedBy=multi-user.target
```

`nobody` cannot bind port 27650 (anything under 1024 is privileged, but 27650 is not, so this is
fine). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now quakehub-q4master
sudo systemctl status quakehub-q4master
journalctl -u quakehub-q4master -f     # watch it work
```

### 7. Verify from somewhere else

This is the step people skip, and it's the one that catches the cloud-firewall problem. From a
**different** machine, not the one running it:

```bash
git clone https://github.com/booskibro/quakehub-q4master
cd quakehub-q4master
node tools/query.js master.yourdomain.net
```

```
master.yourdomain.net:27650 -> 19 server(s)
  66.55.137.189:28004
  ...
```

If that works from another network, it will work for players. If it prints nothing here but the
service log on the box looks healthy, it is a firewall between you and it, almost always the
cloud provider's, see step 4.

### 8. Tell people the address

Players add one line to `autoexec.cfg` (see [For players](#for-players-retail-or-gog-quake-4)):

```
seta net_master0 "master.yourdomain.net"
```

Server operators can optionally add:

```
seta net_master1 "master.yourdomain.net:27650"
```

---

## Troubleshooting

**The in-game browser is still empty.**

Check the master is answering at all, from the same machine you're playing on:

```bash
node tools/query.js master.quakehub.net     # or your own master's hostname
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
| `Q4MASTER_SEEDS_URL` | off | HTTP list re-fetched every sweep, **added** to the above. See [Keeping the list current](#keeping-the-list-current) |
| `Q4MASTER_STRICT_GAME` | off | Filter the reply by the client's `fs_game` |
| `Q4MASTER_HTTP_PORT` | off | Serve the [info page](#the-info-page) on this TCP port, e.g. `80` |
| `Q4MASTER_HOSTNAME` | - | Your public hostname, used in the info page's copy-paste examples |
| `Q4MASTER_QUIET` | off | Suppress per-request logging |

### The info page

A master is a UDP service, so its hostname isn't a website. But the moment you tell anyone the
address, Twitter, Discord and every chat client turn it into a clickable link, and people click
it. With nothing listening on port 80 the browser hangs until it times out and then says "site
can't be reached", which reads as broken rather than as "this isn't a web address".

Set `Q4MASTER_HTTP_PORT=80` and a visitor gets one page instead: what the hostname is, the
`autoexec.cfg` line to paste, how many servers are listed right now, and a link to this repo so
they can run their own. `/servers.json` on the same port returns the list machine-readably.

```bash
Q4MASTER_HTTP_PORT=80 Q4MASTER_HOSTNAME=master.example.net npm start
sudo ufw allow 80/tcp
```

Binding port 80 needs root on Linux, which is why it's off by default. If it can't bind, it logs
and carries on: the UDP master never depends on it.

Seeds may be `ip:port` or `hostname:port`. Hostnames are re-resolved on every sweep, because
several surviving Quake 4 servers sit behind dynamic DNS and move.

**On `Q4MASTER_STRICT_GAME`:** the retail master filtered the list to the mod the client was
running. This defaults to *not* doing that. Quake 4's surviving scene is about twenty servers,
mostly `q4max`, and a player who opens an empty browser concludes the game is dead and quits.
Showing everything live is the friendlier failure. Turn it on for historically accurate
behaviour.

---

## Keeping the list current

By default the master probes [`seeds.json`](seeds.json), a snapshot of known Quake 4 servers.
That file can never show you a *dead* server, because everything is probed before it is listed.
But it can go **incomplete**: if a new server appears next month, a frozen file never learns
about it, and you would have to edit and redeploy to pick it up.

`Q4MASTER_SEEDS_URL` fixes that. Point it at any URL that returns JSON containing server
addresses, and the master re-fetches it on every sweep.

### The one-liner

```bash
Q4MASTER_SEEDS_URL="https://quakehub.net/api/v1/servers/q4" npm start
```

That's the whole setup. You should see:

```
[master] listening on UDP 27650
[seeds] 19 address(es) from https://quakehub.net/api/v1/servers/q4
[master] 19 server(s) verified
```

Confirm it's serving them:

```bash
npm run list
# 127.0.0.1:27650 -> 19 server(s)
```

### With systemd

Add the variable to the unit file from [step 6](#6-run-it-permanently):

```ini
[Service]
Environment=Q4MASTER_SEEDS_URL=https://quakehub.net/api/v1/servers/q4
ExecStart=/usr/bin/node /opt/quakehub-q4master/src/index.js
```

Then `sudo systemctl daemon-reload && sudo systemctl restart quakehub-q4master`.

### With Docker

```bash
docker run -p 27650:27650/udp \
  -e Q4MASTER_SEEDS_URL="https://quakehub.net/api/v1/servers/q4" \
  quakehub-q4master
```

### What URL should I use?

Any URL you trust. The parser accepts every common server-list shape, so most existing feeds
work without modification:

```jsonc
["1.2.3.4:28004", "5.6.7.8:28004"]                       // plain list
{"servers": ["1.2.3.4:28004"]}                            // wrapped list
[{"address": "se.example.net:28004"}]                     // qstat output.json
{"servers": [{"ip": "1.2.3.4", "port": 28004}]}           // ip/port pairs
```

Two that exist today:

| URL | What it is |
| --- | --- |
| `https://quakehub.net/api/v1/servers/q4` | Every Quake 4 server quakehub knows about, each verified within the last 90 seconds. Free, no key. |
| `https://quake4.net/qstat/output.json` | One operator's Q4Max fleet, regenerated on a ~60s cron. |

**This is deliberately not hardcoded to any project, including quakehub.** A master whose seed
list could only come from one website would recreate exactly the single point of failure this
repository exists to remove. Use quakehub, use your own list on your own web server, use
nothing. The bundled `seeds.json` works standalone forever.

### What happens when the seed source goes down

Nothing bad, by design:

- Remote addresses are kept **separately** from the bundled ones and are **added** to them,
  never substituted. Losing the URL can never cost you `seeds.json`.
- A failed fetch keeps the **last successful list**. The master logs it and carries on probing
  everything it already knew about.
- A `200 OK` with an empty list is **ignored**, not obeyed. That is far more likely to be a bug
  at the other end than a genuine claim that no servers exist.
- A response with thousands of entries is capped at 500, so a broken or hostile endpoint cannot
  flood the probe loop.

The worst case is that your list goes slightly stale. It cannot go empty.

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
