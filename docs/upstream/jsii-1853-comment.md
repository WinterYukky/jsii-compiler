<!--
Draft comment for aws/jsii-compiler#1853 ("jsii & TypeScript native").
Final version for maintainer review — paste as-is.
-->

**TL;DR: to answer the question this issue asks, we tested whether jsii can
run on the TypeScript 7 (`tsgo`) programmatic API — by building an
experimental backend and validating it against real packages up to
`aws-cdk-lib`. The verdict: feasible. The output matches the current
compiler, and the jsii compile step drops from ~119s to ~35.5s (3.4x).**

## What we did

We added an experimental `JSII_COMPILER_BACKEND=ts7` backend on a fork of
jsii-compiler. It reimplements the Assembler's and emitter's interactions
with the TypeScript compiler on top of `@typescript/native-preview`, while
the existing (strada) path stays untouched — an env var switches between the
two. That makes validation straightforward: compile the same package with
both backends and compare everything they produce.

jsii produces two kinds of output. The first is the `.jsii` assembly — the
model of all exported types, members and documentation that downstream
binding generators consume. The second is the compiled JavaScript and
declaration files, which jsii post-processes to inject runtime type
information. We compared both, on three packages of increasing size:
`constructs`, `cloud-assembly-schema`, and `aws-cdk-lib` (20,744 types and
100,380 members — one of the largest TypeScript API surfaces in the wild).

The result: on the two smaller packages the `.jsii` assembly is 100%
identical. On `aws-cdk-lib`, 99.9% of members match exactly, and the
remaining 0.1% is a short, fully enumerated list of known differences — a
tail to chase down, not a structural gap. The emitted JavaScript and
declaration files are byte-identical on all three, including jsii's rtti
injection.

Getting there required two APIs the unstable surface did not have when we
started, and both are now available upstream: `checker.getFullyQualifiedName`
(jsii derives its `symbolId` from it; merged as microsoft/typescript-go#4700)
and an emit API that a tool can post-process (the TypeScript team
independently shipped `emit()` in microsoft/typescript-go#4699 while we were
validating; our measurements used our own draft implementation, which is
functionally equivalent).

To be clear about maturity: this is a feasibility validation, not a finished
migration — an experimental flag on a fork, validated against three packages,
with that 0.1% member tail still open.

## How fast is it, and what limits it?

Some context for the numbers. Unlike strada's in-process API, where a checker
query is an ordinary function call, the new API runs the compiler as a
separate Go process: the Node client holds handles to remote objects, and
every query is a synchronous RPC round-trip. Walking `aws-cdk-lib` turned
into ~950k such round-trips in our first working version. So after the port
worked, we measured where the time actually goes — same machine, 3-run
medians, with the parity checks above enforced after every change:

| lever tried | requests | bytes received | wall-clock |
|---|---:|---:|---:|
| baseline | 946k | 958 MB | ~46s |
| client-side fixes (input-keyed type cache, local isArrayType) | 816k → 718k | 958 MB | ~41.5s |
| emit written server-side instead of transferred (−344 MB payload) | 718k | 604 MB | ~38.2s |
| batched doc reads (−218k requests) | 500k | 608 MB | **~35.5s** |

The table tells a clear story. The Go compiler itself is not the limit:
server-side type computation is ~15s, which is actually faster than strada's
in-process checker (~17.6s) for the same work. What dominates is the
round-trips themselves — roughly 500k synchronous waits at ~12-21µs of fixed
cost each. Cutting the bytes transferred by 36% moved wall-clock by only 8%,
while cutting the number of requests moved it almost linearly.

That means getting past ~3.4x is API-shape work on the typescript-go side
(batch-first traversal APIs, async pipelining) rather than anything jsii can
do alone. We are filing the detailed measurements and suggestions with the
typescript-go team separately.

## Artifacts

- Experimental backend + full measurement history:
  https://github.com/WinterYukky/jsii-compiler/tree/feat/ts7-backend-1784773376
  (see `src/ts7/README.md` for the architecture decision and
  `src/ts7/PHASE1-RESULTS.md` for every phase's numbers, gates, and lessons).
- Feasibility spike write-up with API-coverage inventory:
  https://github.com/WinterYukky/jsii-compiler/issues/1
- typescript-go patches: `getFullyQualifiedName` merged (#4700); emit API
  superseded by upstream's own #4699; two performance patches (checker
  input-keyed cache, batched doc reads) are parity-proven on fork branches
  and being submitted upstream.

Happy to upstream any of this — the backend as an experimental flag, the
analysis, and/or the typescript-go patches — in whatever form is most useful
to the maintainers.
