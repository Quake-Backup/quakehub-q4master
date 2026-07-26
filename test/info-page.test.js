// The info page exists because a master's hostname always ends up as a clickable link, and a
// browser hanging on a firewalled port reads as "broken" rather than "this isn't a website".
import test from 'node:test';
import assert from 'node:assert/strict';
import { startInfoPage } from '../src/info-page.js';

const fakeRegistry = (n) => ({
  size: n,
  list: () => Array.from({ length: n }, (_, i) => ({ ip: `1.2.3.${i}`, port: 28004 })),
});

async function withPage(opts, fn) {
  const server = startInfoPage({ port: 0, log: () => {}, ...opts });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('the page tells a visitor what the hostname is and what to paste', async () => {
  await withPage({ host: 'master.example.net', masterPort: 27650, registry: fakeRegistry(19) }, async (base) => {
    const html = await (await fetch(base)).text();
    assert.ok(html.includes('not a website'), 'says what it is');
    assert.ok(html.includes('seta net_master0'), 'gives players the client line');
    assert.ok(html.includes('seta net_master1'), 'gives operators the server line');
    assert.ok(html.includes('master.example.net'), 'uses the real hostname, not a placeholder');
    assert.ok(html.includes('19 servers listed'), 'shows live state');
    assert.ok(html.includes('quakehub-q4master'), 'links the source so people can run their own');
  });
});

test('a non-standard master port shows up in the copy-paste line', async () => {
  // Otherwise someone on a custom port copies a line that silently points at the wrong place.
  await withPage({ host: 'm.example.net', masterPort: 27777, registry: fakeRegistry(2) }, async (base) => {
    const html = await (await fetch(base)).text();
    assert.ok(html.includes('"m.example.net:27777"'), 'client line carries the port');
  });
});

test('singular/plural reads correctly, including when the list is empty', async () => {
  await withPage({ registry: fakeRegistry(1) }, async (base) => {
    assert.ok((await (await fetch(base)).text()).includes('1 server listed'));
  });
  await withPage({ registry: fakeRegistry(0) }, async (base) => {
    assert.ok((await (await fetch(base)).text()).includes('0 servers listed'));
  });
});

test('/servers.json exposes the same list machine-readably', async () => {
  await withPage({ host: 'm.example.net', registry: fakeRegistry(3) }, async (base) => {
    const res = await fetch(`${base}/servers.json`);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const j = await res.json();
    assert.equal(j.master, 'm.example.net');
    assert.deepEqual(j.servers, ['1.2.3.0:28004', '1.2.3.1:28004', '1.2.3.2:28004']);
  });
});

test('any other path still serves the page rather than a 404', async () => {
  // People paste URLs with tracking junk on the end; a 404 would look broken again.
  await withPage({ registry: fakeRegistry(5) }, async (base) => {
    const res = await fetch(`${base}/anything?utm_source=twitter`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('not a website'));
  });
});

test('a hostname with markup in it is escaped, not injected', async () => {
  await withPage({ host: '<script>alert(1)</script>', registry: fakeRegistry(0) }, async (base) => {
    const html = await (await fetch(base)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

test('a port it cannot bind is logged, not thrown, so UDP keeps serving', async () => {
  // The master's actual job must not depend on the vanity page starting. Port-in-use is the
  // portable way to force this; low-port privilege differs by platform (Windows allows :1).
  const held = startInfoPage({ port: 0, registry: fakeRegistry(0), log: () => {} });
  await new Promise((r) => held.once('listening', r));
  const taken = held.address().port;

  const logs = [];
  const second = startInfoPage({ port: taken, registry: fakeRegistry(0), log: (m) => logs.push(m) });
  await new Promise((r) => setTimeout(r, 300));

  try { second.close(); } catch { /* never listened */ }
  await new Promise((r) => held.close(r));
  assert.ok(
    logs.some((l) => l.includes('not started') && l.includes('EADDRINUSE')),
    `expected a soft failure, got ${JSON.stringify(logs)}`,
  );
});
