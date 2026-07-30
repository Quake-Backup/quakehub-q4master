// Optional tiny HTTP page on port 80, explaining what this hostname is.
//
// A master server is a UDP service, so its hostname is not a website. But the moment you tell
// anyone the address, Twitter, Discord and every chat client turn it into a clickable link, and
// people click it. With nothing listening the browser hangs until it times out and then says
// "site can't be reached", which reads as broken rather than as "this isn't a web address".
//
// So: one page, no dependencies, that tells a visitor what they've found and what to do with it.
// Off by default because binding port 80 needs privileges and not every host wants it.

import http from 'node:http';

function page({ host, port, serverCount, repo }) {
  const addr = port === 27650 ? host : `${host}:${port}`;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(host)} — Quake 4 master server</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; padding:3rem 1.25rem; background:#0a0908; color:#e7e9ee;
         font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;
         display:flex; justify-content:center }
  main { max-width:44rem; width:100% }
  h1 { font-size:1.6rem; margin:0 0 .35rem; color:#e8a33d }
  .sub { color:#8b93a7; margin:0 0 2rem }
  code, pre { font-family:ui-monospace,Consolas,monospace }
  pre { background:#100e0c; border:1px solid rgba(232,163,61,.45); border-radius:10px;
        padding:1rem 1.15rem; overflow-x:auto; font-size:.95rem; color:#f0ede6 }
  pre b { color:#e8a33d; font-weight:normal }
  h2 { font-size:1rem; margin:2rem 0 .6rem; color:#e7e9ee }
  p { margin:.6rem 0 }
  a { color:#e8a33d }
  .live { display:inline-block; padding:.15rem .55rem; border:1px solid rgba(232,163,61,.45);
          border-radius:999px; font-size:.85rem; color:#e8a33d; margin-bottom:1.5rem }
  footer { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid #2e2823;
           color:#8b93a7; font-size:.9rem }
</style>
<main>
  <h1>${esc(host)}</h1>
  <p class="sub">This is a Quake 4 master server, not a website. There is nothing to see here,
     but there is something to do with it.</p>
  <span class="live">${serverCount} server${serverCount === 1 ? '' : 's'} listed right now</span>

  <h2>If you play Quake 4</h2>
    <p>Quake 4&rsquo;s official master server no longer serves a server list, which is why
     <b>Multiplayer &rarr; Internet</b> shows an empty list. Point the game here instead.</p>
  <p>Create a file called <code>autoexec.cfg</code> in your <code>q4base</code> folder
     (Steam: <code>steamapps/common/Quake 4/q4base</code>) containing one line:</p>
  <pre>seta net_master0 <b>"${esc(addr)}"</b></pre>
  <p>Start the game, open <b>Multiplayer &rarr; Internet</b>, and the list fills up.</p>
    <p>Slot <b>0</b> carries your client&rsquo;s authorisation as well as the server list, so a
       master that only serves listings would leave you unable to connect anywhere. This one
       forwards that traffic straight to id&rsquo;s master, untouched, and logs only the command
       name and source address. If you run your own instance, make sure it does the same:
       versions before 30 July 2026 did not, and that silently broke players a couple of days
       later when their GUID needed renewing.</p>

  <h2>If you run a Quake 4 server</h2>
  <p>Add this to your server config and it will list itself automatically:</p>
  <pre>seta net_master1 <b>"${esc(host)}:${port}"</b></pre>
  <p>You don't have to. This master also probes a list of known servers directly, so you may
     already be on it.</p>

  <h2>If you'd rather not depend on this one</h2>
  <p>Good. Run your own, that's the point. The code is MIT licensed with step-by-step hosting
     instructions, and servers can advertise to several masters at once.</p>
  <p><a href="${esc(repo)}">${esc(repo.replace(/^https?:\/\//, ''))}</a></p>

  <footer>Powered by <a href="${esc(repo)}">quakehub-q4master</a>.
     Server list from <a href="https://quakehub.net">quakehub.net</a>.</footer>
</main>`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Start the info page. Returns the http.Server, or null if disabled.
 * Never fatal: if the port is taken or privileged, we log and carry on serving UDP, because the
 * master's actual job does not depend on this.
 */
export function startInfoPage({
  port = 80, host = 'localhost', masterPort = 27650, registry,
  repo = 'https://github.com/booskibro/quakehub-q4master', log = console.log,
} = {}) {
  const server = http.createServer((req, res) => {
    // A machine-readable view too, so the hostname is useful to more than a browser.
    if (req.url === '/servers.json') {
      const list = registry ? registry.list().map((s) => `${s.ip}:${s.port}`) : [];
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ master: host, servers: list }, null, 2));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page({ host, port: masterPort, serverCount: registry ? registry.size : 0, repo }));
  });

  server.on('error', (err) => {
    log(`[info-page] not started on port ${port}: ${err.message}`);
  });
  server.listen(port, () => log(`[info-page] http://${host}${port === 80 ? '' : `:${port}`}`));
  server.unref?.();
  return server;
}

export const _test = { page };
