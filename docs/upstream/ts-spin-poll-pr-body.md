# Draft PR body for microsoft/TypeScript — api: spin-poll briefly before blocking reads on the synchronous channel

> Target: https://github.com/microsoft/TypeScript, branch `WinterYukky/TypeScript` `perf/api-sync-spin-poll` (one commit on top of upstream `main`). Fixes https://github.com/microsoft/TypeScript/issues/65049. Measurement log: `src/ts7/PHASE1-RESULTS.md`, Phases 4–5F, in `WinterYukky/jsii-compiler` branch `feat/ts7-backend-1784773376`.

---

Fixes https://github.com/microsoft/TypeScript/issues/65049

## Summary

The synchronous API exchanges one message per query: the client blocks on every reply and the server blocks on every request. Between back-to-back messages each side waits only a few tens of microseconds, but blocking immediately lets the CPU drop into a deep idle state whose exit latency (~190 µs for C6 on current Intel hosts) then dominates the round trip. On a traversal that issues many small checker queries (jsii issues ~700k per aws-cdk-lib compile) that cost adds up to 15–20 % of the wall clock, and it is also what made `batchRequests` slower rather than faster in that workload (details in the issue).

This PR makes both ends poll for the next message for a short budget before taking one blocking read. In the common case the message is already there or arrives within the budget, so neither process blocks and the idle-state exit cost disappears. The protocol and the API surface are unchanged; the generated output of the workloads I used to measure is byte-identical with and without the change.

## What changes

- `tsc/internal/ipc/spinreader.go` (new): `ParseSyncSpin` / `ParseSyncSpinAdaptive` for the two environment variables, and a small `spinState` state machine for the adaptive mode (suspend after 3 consecutive waits > 1 ms, resume after 3 consecutive waits < 1 ms).
- `tsc/internal/ipc/spinreader_unix.go` (new, `//go:build unix`): `NewSpinReadCloser` wraps an `io.ReadCloser` that exposes `Fd()`; `Read` runs `poll(2)` with a zero timeout until the descriptor is readable or the budget runs out, then performs the normal blocking `Read`.
- `tsc/internal/ipc/spinreader_other.go` (new, `//go:build !unix`): `NewSpinReadCloser` returns the reader unchanged. Windows uses a named pipe without `poll`, and wasip1 reads stdin through its own loop; both keep today's behaviour.
- `tsc/cmd/tsc/api.go`: for the synchronous stdio transport (not `--async`, not `--pipe`), wrap stdin with `NewSpinReadCloser`. The wrapper is a no-op when the input has no file descriptor (wasip1) or when the budget is 0.
- `packages/typescript/src/api/syncChannel.ts`: on POSIX, keep the child's stdout descriptor non-blocking and retry `EAGAIN` in a new `readFromPipe` for up to the budget before switching the descriptor to blocking for one `readSync`. The adaptive state machine mirrors the Go side and keeps the descriptor in the blocking state that matches the current mode, so the steady state costs no extra `fcntl`. The Windows named-pipe path is untouched.

The two sides are independent: the server-side wrapper helps any client, and the client-side loop helps any server.

## Defaults and knobs

| Variable | Default | Meaning |
|---|---|---|
| `TSGO_SYNC_SPIN_US` | `100` | Budget in microseconds spent polling before a blocking read. `0` (or anything that is not a positive integer) disables spinning on both ends. |
| `TSGO_SYNC_SPIN_ADAPTIVE` | on | `0` keeps spinning unconditionally. With the default, spinning is suspended after three consecutive messages that arrived more than 1 ms after the wait began (the peer is idle between messages) and resumed after three consecutive quick ones. |

The 1 ms threshold is deliberately far above the budget: on a C6 host a blocked read returns after ~200 µs even when the peer answered at once, so "the budget ran out" alone would switch spinning off exactly where it helps. The adaptive mode exists so that a client that is idle between requests (an editor-style consumer) does not pay the extra core; the dense-traffic result is within noise of the fixed budget.

I am proposing on-by-default because no measured case gets slower, but whether this should instead be opt-in, and the budget itself, are the project's decision; both are one-line changes in `spinreader.go` and `syncChannel.ts`.

## Tests

- `tsc/internal/ipc/spinreader_test.go`: env parsing and the adaptive state machine (suspend after N slow waits, resume after N fast waits, a single observation in the other direction resets the count, round trip).
- `tsc/internal/ipc/spinreader_unix_test.go`: on a real pipe — the wrapper is bypassed when disabled or when the reader has no descriptor; data that arrives inside the budget is returned without waiting for the budget; data that arrives after the budget is returned by the blocking read; EOF and `Close` pass through; the adaptive mode suspends after slow writers and resumes once messages are already waiting.
- Repo checks on the branch (Linux, c7i.4xlarge): `npx hereby test:tsc`, `npx hereby test:api`, `npx hereby lint`, `npx hereby check:format` all pass (Node 24; `test:api` needs Node 24 because the test sources use `using`, as CI's `lts/*` does).
- Cross-compilation of the `ipc` package and `cmd/tsc`: `GOOS=windows`, `GOOS=wasip1 GOARCH=wasm`, `GOOS=darwin`, `GOOS=freebsd`.

## Numbers

Same fork build, two runs per cell unless noted, `.jsii` output byte-identical across cells. "aws-cdk-lib benchmark" is the snapshot jsii-compiler uses for its benchmark (~20k types, ~700k requests per compile). CPU cost is measured from `/proc/<pid>/stat` during the run.

| Host | Spin off | 100 µs budget | Adaptive (this PR's default) | CPU cost |
|---|---|---|---|---|
| c7i.4xlarge, aws-cdk-lib benchmark | 41.8 / 41.0 s | 34.8 / 34.6 s | 34.6 / 34.9 s | about +0.2 core per process |
| c7i.4xlarge, current aws-cdk-lib built from source | 51.4 s | 43.1 s | — | — |
| 4 vCPU (c7i.xlarge) | 49.0 / 48.5 s | 44.3 / 45.0 s | 44.1 / 45.1 s | +0.1 core client, +0.2 server |
| 2 CPUs (pinned on the 4 vCPU host) | 51.1 / 51.9 s | 48.6 / 48.9 s | 48.5 / 48.8 s | +0.1 core client, +0.15 server |
| c7g.4xlarge (Graviton, no deep idle state) | 60.5 / 60.7 s | 55.2 / 55.3 s | 55.6 / 56.8 s | about +0.3 core server |
| cgroup `CPUQuota=200%` on c7i.4xlarge, 1 run | 47.2 s | 41.5 s | 42.3 s | throttled time 0.5 s → 5.2 s of a 42 s run; wall still −5 s |

Under a cgroup CPU quota the spin does turn partly into throttled time (the scope was throttled in 115 of ~420 periods with the default, 34 without), but average demand stays under the cap (1.6 vs 1.2 cores) and the wall clock still improves; I did not measure tighter quotas.

Sparse traffic is where a fixed budget costs something: in the worst case I constructed (50 fast requests followed by one slow one, repeated 40 times) the server's CPU time goes from 0.03 s to 0.46 s with a fixed budget; the adaptive mode lands at 0.04 s.

Root cause, for reference: c7i/m7i expose C6 at 190 µs exit latency and m8i exposes C6 (170 µs) and C6P (210 µs); c5, c6i, c6a and c7g expose no deep idle state to the guest. Disabling C6 on the host removes about half of the gain; the rest is the pipe wake-up (two context switches per round trip) that the poll skips when the message arrives within the budget, which is why Graviton improves as well.

## Not covered

Windows is a no-op (the named-pipe transport would need its own way to check for a pending message). 100 µs is the only budget measured at scale.
