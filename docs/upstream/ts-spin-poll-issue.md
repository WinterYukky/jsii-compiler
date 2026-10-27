# Draft issue for microsoft/TypeScript — sync API: the client and the server spend more time waiting for each other's next message than handling it; a small change to how both wait

> Target: https://github.com/microsoft/TypeScript (the `--api` server and the `typescript/sync` client). Template: Feature request / performance. Reference implementation: fork branch `WinterYukky/TypeScript` `perf/api-sync-spin-1792807669` (fixed budget) and `perf/api-sync-spin-adaptive-1792824081` (adaptive variant). Full measurement log: `src/ts7/PHASE1-RESULTS.md`, Phases 4–5E, in `WinterYukky/jsii-compiler` branch `feat/ts7-backend-1784773376`.

I am an independent contributor experimenting with running jsii (the AWS CDK's multi-language binding generator) on the TypeScript 7 programmatic API; this is something I noticed along the way, and I think it may be useful beyond jsii. I would be glad to adjust the approach or the details to whatever fits the project.

## Summary

The sync API exchanges one message per query. While the server handles a request, the client blocks waiting for the reply; while the client prepares its next request, the server blocks waiting for it. On many current hosts, the CPU of whichever process is blocked enters a deep idle state between messages, and leaving that state costs up to 190 µs, which is more than the server spends answering a typical query (a few µs). A tool that walks a whole program issues a very large number of such queries (jsii issues about 700k per aws-cdk-lib compile), and the idle-state exit cost adds up to 15–20% of its wall clock.

The change I am proposing is small: when either the client or the server is waiting for the next message from the other, it keeps checking for the message itself for a very short time (up to 100 µs) before handing the wait to the OS and blocking. Replies usually arrive within 20 µs, so in the common case neither process blocks and the idle-state exit cost disappears entirely. On a current aws-cdk-lib checkout built from source, a jsii compile goes from 51 s to 43 s for about +0.4 CPU cores while it runs. The protocol and the API surface are unchanged.

## What I observed

I added `runtime/trace` regions around the server's read, handle and write steps on the sync connection (fork branch `perf/api-runtime-trace-1792804258`) and ran jsii's TypeScript 7 backend over the aws-cdk-lib snapshot that jsii-compiler uses for its benchmark (~20k types, ~700k API requests per compile; "the aws-cdk-lib benchmark" below). The host was a c7i.4xlarge (16 vCPU, Sapphire Rapids, Ubuntu 24.04).

Three observations led to the proposal.

First, the server's own work per request is small, and the server's wait for the client's next request is not. The server's handler for the hot methods (`getJsDocTags`, `getTypeAtLocation`, `getTypeOfSymbolAtLocation`, `getDocumentationComment`) takes 1.6–5 µs per request, while the server goroutine spends 24 s of a 45 s run blocked in `read`, waiting for the client's next request, about 60% of the wall clock. That wait has a long tail: the median gap between two requests is 19 µs, but the 90th percentile is 31–82 µs, with a plateau at ~200 µs after the type-materialising methods.

Second, the plateau matches the host's deep idle state. The host exposes C6 (a deep CPU idle state; ~190 µs to exit), and the number of C6 entries during a run tracks the size of the tail. Disabling C6 at runtime, same build, same box, removes the plateau and takes the benchmark from 44.5 s to 41.0 s. The same effect is visible with the `echo` method alone: back-to-back small echoes take 8 µs each, but interleaving one large request every 30 small ones raises the small-echo mean by 70%, because the server's longer handling time for the large request leaves the client's CPU idle long enough to enter C6.

Third, whether C6 exists at all depends on the host. On Ubuntu 24.04, c7i and m7i expose C6 at 190 µs, m8i exposes C6 at 170 µs and C6P at 210 µs, while c5, c6i, c6a and c7g (Graviton) expose no deep idle state to the guest and do not show the tail. I also ran the benchmark on a c7g.4xlarge (Graviton, no idle driver at all): the proposal still helps there (60.6 → 55.3 s, see Results) because the client and the server still skip the pipe wake-up whenever the reply arrives within the budget, but the gain is smaller than on c7i, which is consistent with the idle-state exit being the larger of the two costs on x86. Users of the API rarely control the idle-state configuration of the machine they build on (CI runners in particular), so I think the communication layer is the right place to absorb this rather than a host tuning recommendation.

## Proposal

When either the client or the server is waiting for the next message from the other, it keeps checking for the message's arrival itself for a very short budget (I used 100 µs) before handing the wait to the OS and blocking. On the server this is a thin wrapper around the connection's input; on the client it is a bounded retry loop in the sync channel's read path. No message format, handler or client-facing type changes; the implementation is on the fork branches above.

A fixed budget wastes CPU when traffic is sparse (see "Other things I tried"), so the fork also has an adaptive variant: the checking is suspended after three consecutive waits longer than 1 ms and resumed after three consecutive waits shorter than 1 ms. The 1 ms threshold is deliberately far above the budget: on a C6 host a blocked `read` returns after ~200 µs even when the other process answered at once, so "the budget ran out" alone would switch the checking off exactly where it helps.

I think the adaptive variant with a 100 µs budget is a reasonable default, with an environment variable to turn it off, but the default, the budget and whether it should be opt-in are decisions I would rather leave to you; the fork exposes `TSGO_SYNC_SPIN_US` and `TSGO_SYNC_SPIN_ADAPTIVE` so the options can be compared directly.

## Results

All numbers are from the same fork build, two runs per cell, with the generated `.jsii` output byte-identical across cells.

| Host | Without the change | 100 µs budget | Adaptive | CPU cost |
|---|---|---|---|---|
| c7i.4xlarge, aws-cdk-lib benchmark | 41.8 / 41.0 s | 34.8 / 34.6 s | 34.6 / 34.9 s | about +0.2 core per process |
| c7i.4xlarge, current aws-cdk-lib built from source | 51.4 s | 43.1 s | — | — |
| 4 vCPU (c7i.xlarge) | 39.1 / 38.6 s | 37.3 / 37.2 s | 37.5 / 37.3 s | — |
| 2 CPUs (pinned on the same 4 vCPU host) | 41.9 / 41.4 s | 40.8 / 40.9 s | 41.2 / 40.5 s | — |
| c7g.4xlarge (Graviton, no deep idle state) | 60.5 / 60.7 s | 55.2 / 55.3 s | 55.6 / 56.8 s | about +0.3 core on the server |

CPU cost is measured from `/proc/<pid>/stat` during the run (on the c7i.4xlarge benchmark the Node client goes from 14 to 18 CPU-seconds and the Go server from 56 to 58 over a 37 s run); the client only checks while the server is working and the server only checks while the client is working, so the cost stays well below one core. The 4 vCPU and 2 CPU rows use the coarse-endpoint traversal proposed separately, so their baseline is not directly comparable with the first row; they are there to check that the client and the server competing for cores does not invert the result, and it does not. The Graviton benchmark is slower overall for reasons unrelated to this proposal; the per-iteration cost of the checking is also higher on that platform.

## Other things I tried

Disabling C6 on the host. I expected it to remove the whole tail and therefore match the proposal. It helped less: -3.5 s on the benchmark against -7 s for the checking, and the two combined gave -6 s over the C6-off baseline. The difference is that the checking also skips the pipe wake-up itself, two context switches per round trip, whenever the reply arrives within the budget, which disabling an idle state cannot do; the two are complementary rather than redundant.

Before looking at the channel I tried the obvious lever, fewer requests. The API already offers `batchRequests`, so I bundled jsii's documentation reads (`getJsDocTags` and `getDocumentationComment`, about 250k of the 700k requests) into requests of up to 1000 symbols each, which cut the total request count by about 30%. I expected a proportional saving of a few seconds.

Instead the compile got slower, 42 s to 49 s on the benchmark, and the slowdown varied a lot between runs (anywhere from +4 s to +20 s). Server time was unchanged and the Node client's CPU was unchanged; the extra time was pure waiting, and it was spread over the requests that were not batched: ordinary single `getTypeAtLocation` calls that normally take 26 µs took 60 µs on average in the batched runs. A request count that goes down while every remaining request gets slower did not fit any explanation on the API side, and I could not reproduce the size of the effect with GC settings, Go scheduler settings or smaller batch sizes.

The execution trace resolved it: a 1000-symbol batch keeps the server busy for 30–300 µs instead of 3 µs, which is long enough for the client's CPU to enter C6 while the client waits, and the client then pays the 190 µs exit on that reply and on the next few; the same happens to the server's CPU while the client parses the large response. The batching API was doing exactly what it should; the idle-state tail it triggered cost more than the round trips it saved. With the checking enabled the two variants are equal (34.7 s each) and with C6 disabled the batched variant is the faster one, which is the result I had originally expected.

Sparse traffic is where a fixed budget costs something. I measured a client that sends a request only every 10 ms, and requests that take the server several milliseconds each. I expected the checking to be wasted there, and it is: the waiting process (the server in the first case, the client in the second) spends the full 100 µs checking before it blocks, and no reply or request arrives in that window. In the worst case I constructed (50 fast requests followed by one slow one, repeated 40 times) the server's CPU time goes from 0.03 s to 0.46 s with a fixed budget. The adaptive variant notices the long waits, suspends the checking, and lands at 0.04 s, while keeping the dense-traffic result within noise. The absolute amounts are small; the adaptive variant exists to bring the cost close to zero for workloads that do not benefit.

## What I have not verified

The fork's Windows build is a no-op (the named-pipe transport would need its own way to check for a pending message). I have not measured containers under a CPU quota, where the checking could turn into throttling, and I would recommend one measurement there before enabling anything by default. 100 µs is the only budget I measured at scale; 20 µs gave the same echo floor in the microbenchmark but I did not run the benchmark with it.

## Reproduction

Build the fork branch (`npx hereby build && npx hereby build:api`), point the sync client at it, and compare `TSGO_SYNC_SPIN_US=0` against `TSGO_SYNC_SPIN_US=100` (optionally with `TSGO_SYNC_SPIN_ADAPTIVE=1`) on any traversal that issues many small checker requests; `api.getTimingInfo()` reports round-trip and server time per run. The host's idle states can be listed with `cat /sys/devices/system/cpu/cpu0/cpuidle/state*/latency` and a state can be disabled with the `disable` knob in the same directory to confirm the dependence.

If a different approach to the same problem fits the project better, or if there are concerns about the client and the server checking for messages in the channel at all, I am happy to rework this.
