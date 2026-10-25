# Draft issue for microsoft/TypeScript — sync API channel: idle-state wake-up latency dominates small round trips; proposal: adaptive spin-poll

> Target: https://github.com/microsoft/TypeScript (the Go compiler and the `typescript/sync` client). Template: Feature request / performance. Reference implementation: fork branch `WinterYukky/TypeScript` `perf/api-sync-spin-1792807669` (spin-poll) and `perf/api-sync-spin-adaptive-1792824081` (adaptive variant). Measurement history: `src/ts7/PHASE1-RESULTS.md` Phases 4–5D in `WinterYukky/jsii-compiler` branch `feat/ts7-backend-1784773376`.

## Summary

The `typescript/sync` API client and the `--api` server exchange one message per request over a pipe, and both sides block in `read` while waiting for the other. On hosts that expose a deep CPU idle state to the guest (Intel 7th/8th-generation Nitro instances expose C6 with a 190 µs exit latency), a blocked reader's core drops into that state between messages, so a request whose server-side work takes 3 µs costs ~200 µs of wake-up latency in the tail. For traversal tools that issue hundreds of thousands of small checker queries (jsii issues ~700k for aws-cdk-lib), this tail is 15–20% of the wall clock. I propose that both ends poll the pipe briefly before blocking, adaptively, so the waiting core stays in a shallow idle state and the futex/pipe wake-up is skipped when the reply arrives within the budget.

## How I measured it

I instrumented the server with `runtime/trace` regions around the sync connection's read / handle / write (`TSGO_API_TRACE`, fork branch `perf/api-runtime-trace-1792804258`) and ran jsii's TypeScript 7 backend over aws-cdk-lib (the fixture jsii uses for its benchmark, ~20k types, ~700k API requests), on a c7i.4xlarge (16 vCPU, Sapphire Rapids, Ubuntu 24.04, Linux 7.0).

Where the server goroutine spends its time (seconds, default traversal vs. a variant that batches documentation reads into ~1000-symbol requests):

| region | default | batched docs | delta |
|---|---|---|---|
| `ipc.read` (blocked waiting for the next request) | 24.3 | 27.9 | +3.6 |
| `ipc.handle` | 18.5 | 18.9 | +0.4 |
| `ipc.write` | 3.5 | 3.2 | -0.3 |

The batched variant issues 30% fewer requests yet is 5–15 s slower end to end, and the entire difference is in the client turnaround. It is a tail, not a shift: `ipc.read` p50 19→21 µs, p90 31→82 µs, with a plateau at ~200 µs after type-materialising methods (`getTypeOfSymbolAtLocation` p90 33→193 µs, `getTypeFromTypeNode` 24→204 µs). Node's non-wait CPU, V8 GC counts/pauses and Go GC cycles are identical between the two runs, so both processes are off-CPU for the extra time.

The quantum matches the host's deep idle state: `/sys/devices/system/cpu/cpu0/cpuidle/state3` is C6 with `latency=190` µs, and C6 entries during the run go from 267k (default) to 409k (batched): longer gaps between requests let the governor choose C6 over C1E (2 µs). Disabling C6 at runtime (`echo 1 > .../cpuidle/state3/disable`) confirms it, same build, same box, two runs each:

| run | C6 enabled | C6 disabled |
|---|---|---|
| ts7 default | 44.4 / 44.6 s | 40.9 / 41.1 s |
| ts7 batched docs | 49.2 / 49.5 s | 38.6 / 38.1 s |

With C6 off, batching becomes 2.7 s faster than the default instead of 5 s slower, so the API's request-coalescing was not the problem; the wake-up tail was.

The same effect is reproducible with the `echo` method alone: back-to-back 100-byte echoes have a median round trip of 8.1 µs; one 300 KB echo every 30 small ones raises the small-echo mean to 14.7 µs (+70%), every 100 to 10.7 µs, every 400 to 9.2 µs. Large requests lengthen the server's handling and therefore the client's wait, long enough for the governor to pick C6.

Host dependence (one line of `cpuidle` sysfs per instance family, Ubuntu 24.04): c7i and m7i expose C6 at 190 µs; m8i exposes C6 at 170 µs and C6P at 210 µs; c5, c6i, c6a and c7g expose no idle driver at all (HLT only), so the tail does not exist there. Users' build hosts vary, so a fix in the channel is preferable to a host tuning recommendation.

## Proposal

Before each blocking read, both ends poll the pipe for up to a small budget (I used 100 µs): the Go side wraps stdin in a `poll(2)`-with-zero-timeout loop (`ipc.NewSpinReadCloser`, unix build tag), the Node side switches the read fd to non-blocking and retries `readSync` on `EAGAIN` until the deadline, then takes one blocking read. No protocol change, no change to the handlers.

Adaptive variant: spinning is suspended after three consecutive waits longer than 1 ms (the peer is idle between messages or doing long work per request) and resumed after three consecutive waits shorter than 1 ms. The threshold must be well above the spin budget, not equal to it: on a C6 host a blocking read returns after ~200 µs even when the peer answered at once, so "budget exceeded" alone would turn spinning off exactly where it is needed.

Suggested defaults: adaptive spin on, 100 µs budget, `TSGO_SYNC_SPIN_US=0` to disable; the fork exposes `TSGO_SYNC_SPIN_US` and `TSGO_SYNC_SPIN_ADAPTIVE` for measurement.

## Results

Same fork build, c7i.4xlarge, aws-cdk-lib fixture, two runs per cell, `.jsii` output byte-identical across cells:

| cell | ts7 default | ts7 batched docs | transport overhead (default / batched) |
|---|---|---|---|
| C6 on, spin off (status quo) | 41.8 / 41.0 s | 48.2 / 46.5 s | 14.9 s / 20.2 s |
| C6 on, spin 100 µs | 34.8 / 34.6 s | 34.6 / 34.9 s | 8.6 s / 7.9 s |
| C6 off, spin off | 38.2 / 38.3 s | 35.5 / 35.4 s | 12.7 s / 9.6 s |
| C6 off, spin 100 µs | 32.0 / 32.4 s | 31.5 / 31.5 s | 7.3 s / 5.9 s |

Spin-poll alone beats disabling C6 (-7 s default, -12 s batched): besides avoiding C6 it skips the pipe wake-up (two context switches per round trip) whenever the reply arrives within the budget, which is the common case (~20 µs). With C6 already off, spin still gives -6 s; nothing regresses.

Real aws-cdk-lib (aws-cdk main built with lerna, `--strip-deprecated`, C6 on): 51.4 s → 43.1 s with spin (and 42.6 → 38.0 s combined with the coarse endpoints proposed separately).

Smaller hosts (coarse-endpoint traversal, spin off → spin 100 µs → adaptive, two runs): 4 vCPU 39.1/38.6 → 37.3/37.2 → 37.5/37.3 s; 2 CPUs (`taskset -c 0,1` on the same box) 41.9/41.4 → 40.8/40.9 → 41.2/40.5 s. The gain shrinks with fewer cores but never inverts.

CPU cost, from `/proc/<pid>/stat` during the run: node 14 → 18 s and tsgo 56 → 58 s of CPU over a 37 s run on 4 vCPU, i.e. about +0.2 core per process; each side only spins while the other is working, so it is not a full core.

Low-frequency workloads (echo microbenchmark, CPU seconds node / tsgo, spin off → always spin → adaptive): 300 requests with the client idle 10 ms between them 0.02/0.02 → 0.05/0.09 → 0.06/0.04; 100 requests of millisecond-scale server work 0.00/0.26 → 0.01/0.39 → 0.01/0.04; 50 fast requests followed by one slow, 40 times 0.03/0.03 → 0.07/0.46 → 0.04/0.04. Always-on spinning wastes up to 10x CPU on sparse traffic (small absolute numbers); the adaptive variant removes that while keeping the dense-traffic gain within noise (37.3 vs 37.5 s above).

## What I have not verified

Windows: named pipes have no `poll`, the fork's Windows build is a no-op; a `PeekNamedPipe`-based equivalent is possible but unmeasured. Containers under a cgroup CPU quota: spinning could convert into throttling; I recommend one measurement before enabling by default there. The 100 µs budget is the only value measured at scale (20 µs gave the same echo floor in the microbenchmark). The Node side uses `EAGAIN` retries; a native `poll` would be tighter.

## Reproduction

Build the fork branch (`npx hereby build && npx hereby build:api`), point the sync client at it, and compare `TSGO_SYNC_SPIN_US=0` with `TSGO_SYNC_SPIN_US=100` (optionally `TSGO_SYNC_SPIN_ADAPTIVE=1`) on any traversal that issues many small checker requests; `api.getTimingInfo()` reports round-trip and server time per run. The C-state dependence can be checked with `cat /sys/devices/system/cpu/cpu0/cpuidle/state*/latency` and toggled with the `disable` knob under the same directory.
