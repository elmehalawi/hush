# Testing Hush on a bad network

Toggling Wi-Fi drops every other connection on the machine. Instead, run Hush
through `scripts/netsim.mjs`, a local proxy that degrades **only Hush's**
traffic to Signal and can switch conditions while Hush is running.

Hush's Rust networking (reqwest: the chat websocket, REST calls, and CDN
uploads/downloads) honours `HTTPS_PROXY`. TLS runs end to end through the
tunnel, so certificate pinning still applies. Calls (ringrtc) and contact
discovery (CDSI) bypass the proxy.

## Usage

```bash
scripts/hush-netsim.sh                      # start the proxy, relaunch the Debug build through it
scripts/hush-netsim.sh /path/to/Hush.app    # ...or any other build

node scripts/netsim.mjs set offline         # change conditions live
node scripts/netsim.mjs set normal
node scripts/netsim.mjs status              # current mode and open tunnels
tail -f /tmp/hush-netsim.log                # connections as they open and die
```

| Mode | What it simulates |
|---|---|
| `normal` | Pass-through |
| `offline` | Wi-Fi off: new connections refused, open ones reset |
| `blackhole` | Dead zone: TCP stays up but no bytes move. Only keepalive timeouts notice |
| `slow` | Latency and a bandwidth cap: `set slow --latency 1500 --kbps 16` |
| `flaky` | Connections work, then each is killed after a random 3–20s |

`blackhole` is the case that most often looks like "nothing is happening", because
nothing fails quickly.

## What to check

- **Send while offline or in a blackhole.** The message should appear at once,
  greyed, with "Sending…", then turn into "Not sent · Retry · Delete". Retry
  after `set normal` should deliver it and swap in the real message.
- **Messages queued while away.** Go `offline`, have someone send a few
  messages, go `normal`. The sidebar footer should show "Checking for
  messages…" while the backlog drains, then disappear.
- **Connection drop.** `offline` should show "Offline · retrying" within a few
  seconds. `blackhole` takes up to two keepalive intervals to be noticed.

Connection state and pending messages are in the zustand store
(`connectionState`, and messages whose id starts with `local:`), so the CDP
loop in the Metro debugger can assert on them directly.
