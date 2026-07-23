<!--
Draft comment for aws/jsii-compiler#1853 ("jsii & TypeScript native").
Final version for maintainer review — paste as-is.
-->

We spent some time answering exactly the question this issue poses — what the new
TS7 API means for jsii — and went one step further: we built an **experimental
jsii backend on the TypeScript 7 (`tsgo`) programmatic API** and validated it
against real packages, up to and including `aws-cdk-lib`. Sharing the results
here in case they are useful input for the roadmap.

## TL;DR

- **Feasibility: yes.** The `@typescript/native-preview` unstable API covers what
  the Assembler needs. An experimental `JSII_COMPILER_BACKEND=ts7` backend
  (strada path untouched) produces `.jsii` output that is **100% identical** on
  `constructs` and `cloud-assembly-schema`, and **99.9% member-identical on
  `aws-cdk-lib`** (20,744 types / 100,380 members; the residual is a short,
  enumerated tail, not a structural gap). Emitted JS/d.ts are **byte-identical**,
  including jsii's rtti injection.
- **Performance: the jsii step on `aws-cdk-lib` went from ~119s (strada) to
  ~35.5s — 3.4x** — measured on the same machine, 3-run medians, with parity
  gates enforced at every step.
- **Two API gaps needed patches** (both prototyped on a fork of typescript-go):
  `checker.getFullyQualifiedName` (needed for `symbolId`; upstream PR
  microsoft/typescript-go#4700 is open) and a `getEmitOutput`-shaped emit API
  (jsii needs to post-process emit outputs for rtti).

## What the remaining 35s is — and is not

The interesting part for planning: after porting, the wall-clock is **not** the
Go compiler. We instrumented the RPC channel and eliminated suspects one by one:

| lever tried | requests | bytes received | wall-clock |
|---|---:|---:|---:|
| baseline port | 946k | 958 MB | ~46s |
| client-side fixes (input-keyed type cache, local isArrayType) | 816k → 718k | 958 MB | ~41.5s |
| emit written server-side instead of transferred (−344 MB payload) | 718k | 604 MB | ~38.2s |
| batched doc reads (−218k requests) | 500k | 608 MB | **~35.5s** |

- Go-side type computation (`serverTime`) is ~15s — **faster than strada's
  in-process checker (~17.6s)** for the same work.
- The rest is the out-of-process seam: ~500k synchronous round-trips at ~12-21µs
  of fixed cost each. Payload cuts (−36% bytes) moved wall-clock only −8%;
  request-count cuts moved it linearly.

So jsii-on-TS7 today lands at ~3.4x, and the path beyond that is API-shape work
on the typescript-go side (batch-first traversal APIs, async pipelining) rather
than anything jsii can do alone. We are filing the detailed measurements and
suggestions with the typescript-go team separately.

## What exists, if useful

- Experimental backend + full measurement history:
  https://github.com/WinterYukky/jsii-compiler/tree/feat/ts7-backend-1784773376
  (see `src/ts7/README.md` for the architecture decision and
  `src/ts7/PHASE1-RESULTS.md` for every phase's numbers, gates, and lessons).
- Feasibility spike write-up with API-coverage inventory:
  https://github.com/WinterYukky/jsii-compiler/issues/1
- typescript-go patches (getFullyQualifiedName is #4700; emit API, checker
  input-keyed cache, batched doc reads are on fork branches, parity-proven).

Happy to upstream any of this — the backend as an experimental flag, the
analysis, and/or the typescript-go patches — in whatever form is most useful to
the maintainers.
