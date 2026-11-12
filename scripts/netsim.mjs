#!/usr/bin/env node
// Network conditions simulator for Hush.
//
// An HTTP CONNECT proxy that sits between Hush and Signal's servers and can be
// switched, live, into the kinds of bad network a laptop actually sees. Only
// the process launched with HTTPS_PROXY pointing here is affected, so this is
// safe to use on a machine whose own connection must stay up.
//
// Hush's Rust networking (reqwest, including the chat websocket and CDN
// uploads/downloads) honours HTTPS_PROXY. TLS runs end to end through the
// tunnel, so certificate pinning is unaffected.
//
//   node scripts/netsim.mjs serve            # start the proxy (foreground)
//   node scripts/netsim.mjs set offline      # change conditions
//   node scripts/netsim.mjs status
//
// Modes:
//   normal     pass everything through
//   offline    refuse new connections and reset open ones (Wi-Fi off)
//   blackhole  accept nothing and silently stall open connections: TCP stays
//              up but no bytes move (walked into a dead zone). The nasty case;
//              only keepalive timeouts notice it.
//   slow       add latency and cap bandwidth. Options: --latency ms (800),
//              --kbps n (32)
//   flaky      pass through, but kill each connection after a random 3-20s
//
// Launch Hush through it with scripts/hush-netsim.sh.

import net from 'node:net';
import http from 'node:http';

const PROXY_PORT = Number(process.env.NETSIM_PORT || 8899);
const CONTROL_PORT = PROXY_PORT + 1;

const state = {mode: 'normal', latency: 800, kbps: 32};
const tunnels = new Set();

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

// One direction of a tunnel. Data is queued so that latency and bandwidth can
// be applied per chunk without reordering, and so blackhole can hold it.
function pipe(src, dst, tunnel) {
  let queue = Promise.resolve();
  let nextFree = 0;
  src.on('data', chunk => {
    if (state.mode === 'blackhole') {
      // Swallow: the peer never sees it and never answers.
      return;
    }
    if (state.mode !== 'slow') {
      if (!dst.destroyed) dst.write(chunk);
      return;
    }
    // Serialise the chunk at the capped rate after a fixed latency.
    const now = Date.now();
    const txMs = (chunk.length * 8) / state.kbps;
    const start = Math.max(now + state.latency, nextFree);
    nextFree = start + txMs;
    const due = nextFree;
    src.pause();
    queue = queue.then(
      () =>
        new Promise(resolve =>
          setTimeout(() => {
            if (!dst.destroyed && !tunnel.dead) dst.write(chunk);
            if (!src.destroyed) src.resume();
            resolve();
          }, Math.max(0, due - Date.now())),
        ),
    );
  });
}

function kill(tunnel, why) {
  if (tunnel.dead) return;
  tunnel.dead = true;
  tunnels.delete(tunnel);
  clearTimeout(tunnel.flakyTimer);
  // resetAndDestroy sends RST, which is what a vanished network looks like
  // from the client's side far more than a polite FIN.
  for (const s of [tunnel.client, tunnel.upstream]) {
    if (!s) continue;
    if (typeof s.resetAndDestroy === 'function') s.resetAndDestroy();
    else s.destroy();
  }
  log(`x ${tunnel.host} (${why})`);
}

function armFlaky(tunnel) {
  clearTimeout(tunnel.flakyTimer);
  if (state.mode !== 'flaky') return;
  const ms = 3000 + Math.random() * 17000;
  tunnel.flakyTimer = setTimeout(() => kill(tunnel, 'flaky'), ms);
}

const proxy = http.createServer((req, res) => {
  res.writeHead(405).end('CONNECT only\n');
});

proxy.on('connect', (req, client, head) => {
  const host = req.url;
  if (state.mode === 'offline') {
    log(`- ${host} refused (offline)`);
    client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    return;
  }
  if (state.mode === 'blackhole') {
    // Never answer the CONNECT. The client's connect timeout fires, if it has one.
    log(`- ${host} stalled (blackhole)`);
    const tunnel = {host, client, dead: false};
    tunnels.add(tunnel);
    client.on('error', () => {});
    client.on('close', () => kill(tunnel, 'client closed'));
    return;
  }
  const [hostname, port] = host.split(':');
  const tunnel = {host, client, upstream: null, dead: false};
  tunnels.add(tunnel);
  const upstream = net.connect(Number(port) || 443, hostname, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    pipe(client, upstream, tunnel);
    pipe(upstream, client, tunnel);
    armFlaky(tunnel);
    log(`+ ${host}`);
  });
  tunnel.upstream = upstream;
  upstream.on('error', e => kill(tunnel, `upstream ${e.code || e.message}`));
  client.on('error', e => kill(tunnel, `client ${e.code || e.message}`));
  upstream.on('close', () => kill(tunnel, 'upstream closed'));
  client.on('close', () => kill(tunnel, 'client closed'));
});

function applyMode(next) {
  const prev = state.mode;
  Object.assign(state, next);
  log(`mode ${prev} -> ${state.mode}`, state.mode === 'slow' ? `(${state.latency}ms, ${state.kbps}kbps)` : '');
  if (state.mode === 'offline') {
    for (const t of [...tunnels]) kill(t, 'went offline');
  }
  if (prev === 'blackhole' && state.mode !== 'blackhole') {
    // Connections that were never answered can't recover; a real network
    // coming back doesn't resurrect them either.
    for (const t of [...tunnels]) if (!t.upstream) kill(t, 'left blackhole');
  }
  for (const t of tunnels) armFlaky(t);
}

const control = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/set') {
    const next = {mode: url.searchParams.get('mode') || 'normal'};
    if (url.searchParams.has('latency')) next.latency = Number(url.searchParams.get('latency'));
    if (url.searchParams.has('kbps')) next.kbps = Number(url.searchParams.get('kbps'));
    if (!['normal', 'offline', 'blackhole', 'slow', 'flaky'].includes(next.mode)) {
      res.writeHead(400).end(`unknown mode ${next.mode}\n`);
      return;
    }
    applyMode(next);
  }
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(
    JSON.stringify({...state, tunnels: [...tunnels].map(t => t.host)}, null, 2) + '\n',
  );
});

async function ctl(path) {
  const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${path}`).catch(() => null);
  if (!res) {
    console.error(`netsim isn't running (start it with: node scripts/netsim.mjs serve)`);
    process.exit(1);
  }
  process.stdout.write(await res.text());
  if (!res.ok) process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'serve') {
  proxy.listen(PROXY_PORT, '127.0.0.1', () => {
    control.listen(CONTROL_PORT, '127.0.0.1', () => {
      log(`netsim proxy on 127.0.0.1:${PROXY_PORT}, control on :${CONTROL_PORT}`);
    });
  });
} else if (cmd === 'set' && rest[0]) {
  const params = new URLSearchParams({mode: rest[0]});
  for (let i = 1; i < rest.length; i += 2) {
    params.set(rest[i].replace(/^--/, ''), rest[i + 1]);
  }
  await ctl(`/set?${params}`);
} else if (cmd === 'status') {
  await ctl('/');
} else {
  console.log('usage: netsim.mjs serve | set <normal|offline|blackhole|slow|flaky> [--latency ms] [--kbps n] | status');
  process.exit(cmd ? 1 : 0);
}
