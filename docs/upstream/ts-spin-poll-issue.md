# Draft issue for microsoft/TypeScript — sync API: waiting for the next message costs more than handling it; a small change to how both ends wait

> Target: https://github.com/microsoft/TypeScript (the `--api` server and the `typescript/sync` client). Template: Feature request / performance. Reference implementation: fork branch `WinterYukky/TypeScript` `perf/api-sync-spin-1792807669` (fixed budget) and `perf/api-sync-spin-adaptive-1792824081` (adaptive variant). Full measurement log: `src/ts7/PHASE1-RESULTS.md`, Phases 4–5D, in `WinterYukky/jsii-compiler` branch `feat/ts7-backend-1784773376`.

I am an independent contributor experimenting with running jsii (the AWS CDK's multi-language binding generator) on the TypeScript 7 programmatic API; this is something I noticed along the way, and I think it may be useful beyond jsii. I would be glad to adjust the approach or the details to whatever fits the project.

## Summary

The sync API exchanges one message per query, and while one side works the other side blocks waiting for the reply. On many current hosts the waiting CPU drops into a power-saving state between messages, and waking from it costs up to 190 µs, which is more than the server spends answering a typical query (a few µs). A tool that walks a whole program issues a very large number of such queries (jsii issues about 700k per aws-cdk-lib compile), and the wake-up cost adds up to 15–20% of its wall clock.

The change I am proposing is small: the side waiting for a reply polls for up to 100 µs before going to sleep, instead of blocking immediately. Replies usually arrive within 20 µs, so in the common case the wake-up cost disappears entirely. On a current aws-cdk-lib checkout built from source, a jsii compile goes from 51 s to 43 s for about +0.4 CPU cores while it runs. The protocol and the API surface are unchanged.

## What I observed

I added `runtime/trace` regions around the sync connection's read, handle and write steps on the server (fork branch `perf/api-runtime-trace-1792804258`) and ran jsii's TypeScript 7 backend over the aws-cdk-lib snapshot that jsii-compiler uses for its benchmark (~20k types, ~700k API requests per compile; "the aws-cdk-lib benchmark" below). The host was a c7i.4xlarge (16 vCPU, Sapphire Rapids, Ubuntu 24.04).

Three observations led to the proposal.

First, the server's own work is small and the wait is not. The handler for the hot methods (`getJsDocTags`, `getTypeAtLocation`, `getTypeOfSymbolAtLocation`, `getDocumentationComment`) takes 1.6–5 µs per request, while the server goroutine spends 24 s of a 45 s run blocked waiting for the client's next request, about 60% of the wall clock. That wait has a long tail: the median gap between requests is 19 µs, but the 90th percentile is 31–82 µs with a plateau at ~200 µs after the type-materialising methods.

Second, the plateau matches the host's deep idle state. The host exposes C6 (a deep CPU idle state; ~190 µs to wake from), and the number of C6 entries during a run tracks the size of the tail. Disabling C6 at runtime, same build, same box, removes the plateau and takes the benchmark from 44.5 s to 41.0 s. The same effect is visible with the `echo` method alone: back-to-back small echoes take 8 µs each, but interleaving one large request every 30 small ones raises the small-echo mean by 70%, because the longer handling time of the large request is enough for the CPU to choose the deep state.

Third, whether C6 exists at all depends on the host. On Ubuntu 24.04, c7i and m7i expose C6 at 190 µs, m8i exposes C6 at 170 µs and C6P at 210 µs, while c5, c6i, c6a and c7g (Graviton) expose no deep idle state to the guest and do not show the tail. Users of the API rarely control the idle-state configuration of the machine they build on (CI runners in particular), so I think the communication layer is the right place to absorb this rather than a host tuning recommendation.

## Proposal

Before blocking on a read, each side of the sync channel polls the pipe for a short budget (I used 100 µs) and only then sleeps. On the server this is a thin wrapper around the connection's input; on the client it is a bounded retry loop in the channel's read path. No message format, handler or client-facing type changes.

A fixed budget wastes CPU when traffic is sparse (see "Other things I tried"), so the fork also has an adaptive variant: polling is suspended after three consecutive waits longer than 1 ms and resumed after three consecutive waits shorter than 1 ms. The 1 ms threshold is deliberately far above the budget: on a C6 host a blocking read returns after ~200 µs even when the other side answered at once, so "the budget ran out" alone would switch polling off exactly where it helps.

I think the adaptive variant with a 100 µs budget is a reasonable default, with an environment variable to turn it off, but the default, the budget and whether it should be opt-in are decisions I would rather leave to you; the fork exposes `TSGO_SYNC_SPIN_US` and `TSGO_SYNC_SPIN_ADAPTIVE` so the options can be compared directly.

## Results

All numbers are from the same fork build on the same c7i.4xlarge, two runs per cell, with the generated `.jsii` output byte-identical across cells.

aws-cdk-lib benchmark: 41.8 / 41.0 s without polling → 34.8 / 34.6 s with a 100 µs budget → 34.6 / 34.9 s adaptive. A current aws-cdk-lib checkout built from source: 51.4 s → 43.1 s.

CPU cost, measured from `/proc/<pid>/stat` during the run: the Node client goes from 14 to 18 CPU-seconds and the server from 56 to 58 over a 37 s run, i.e. about +0.2 cores per process. Each side only polls while the other is working, so the cost is well below one core.

Smaller hosts, to check that the two processes competing for cores does not invert the result: on 4 vCPU the benchmark improves by 1.9 s (39.1/38.6 → 37.3/37.2 s), pinned to 2 CPUs by 1.0 s (41.9/41.4 → 40.8/40.9 s). The gain shrinks with fewer cores but I did not find a configuration where it reversed.

## Other things I tried

Disabling C6 outright helps less than polling (-3.5 s on the benchmark vs -7 s), because polling also skips the pipe wake-up itself, two context switches per round trip, whenever the reply arrives within the budget; with C6 already off, polling still adds -6 s, so the two are complementary rather than redundant.

Before looking at the channel I tried the obvious lever, fewer requests. The API already offers `batchRequests`, so I bundled jsii's documentation reads (`getJsDocTags` and `getDocumentationComment`, about 250k of the 700k requests) into requests of up to 1000 symbols each, which cut the total request count by about 30%. I expected a proportional saving of a few seconds.

Instead the compile got slower, 42 s to 49 s on the benchmark, and the slowdown varied a lot between runs (anywhere from +4 s to +20 s). Server time was unchanged and the Node client's CPU was unchanged; the extra time was pure waiting, and it was spread over the requests that were not batched: ordinary single `getTypeAtLocation` calls that normally take 26 µs took 60 µs on average in the batched runs. A request count that goes down while every remaining request gets slower did not fit any explanation on the API side, and I could not reproduce the size of the effect with GC settings, Go scheduler settings or smaller batch sizes.

The execution trace resolved it: a 1000-symbol batch keeps the server busy for 30–300 µs instead of 3 µs, which is long enough for the client's CPU to drop into C6 while it waits, and the client then pays the 190 µs wake-up on that reply and on the next few, and the same happens on the server side after the client's longer parse of the big response. The batching API was doing exactly what it should; the wake-up tail it triggered cost more than the round trips it saved. With polling enabled the two variants are equal (34.7 s each) and with C6 disabled the batched variant is the faster one, which is the result I had originally expected.

Sparse traffic is where a fixed budget costs something. A tool that sends a request only every 10 ms, or requests that take the server several milliseconds each, will not get a reply within the budget, so the waiting side spends 100 µs polling for nothing before it sleeps. In an echo microbenchmark the worst case I constructed (50 fast requests followed by one slow one, repeated 40 times) raises the server's CPU time from 0.03 s to 0.46 s with a fixed budget; the adaptive variant notices the long waits, stops polling, and lands at 0.04 s, while keeping the dense-traffic result within noise. The absolute amounts are small; the adaptive variant exists to bring the cost close to zero for workloads that do not benefit.

## What I have not verified

The fork's Windows build is a no-op (the named-pipe transport would need its own polling primitive). I have not measured containers under a CPU quota, where polling could turn into throttling, and I would recommend one measurement there before enabling anything by default. 100 µs is the only budget I measured at scale; 20 µs gave the same echo floor in the microbenchmark but I did not run the benchmark with it.

## Reproduction

Build the fork branch (`npx hereby build && npx hereby build:api`), point the sync client at it, and compare `TSGO_SYNC_SPIN_US=0` against `TSGO_SYNC_SPIN_US=100` (optionally with `TSGO_SYNC_SPIN_ADAPTIVE=1`) on any traversal that issues many small checker requests; `api.getTimingInfo()` reports round-trip and server time per run. The host's idle states can be listed with `cat /sys/devices/system/cpu/cpu0/cpuidle/state*/latency` and a state can be disabled with the `disable` knob in the same directory to confirm the dependence.

If a different approach to the same problem fits the project better, or if there are concerns about polling in the channel at all, I am happy to rework this.
