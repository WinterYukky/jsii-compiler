<!--
Draft comment for aws/jsii-compiler#1853 ("jsii & TypeScript native").
Final version for maintainer review — paste as-is.
-->

**TL;DR: we built an experimental jsii backend on the TypeScript 7 (`tsgo`)
programmatic API. It produces the same output as the current compiler on real
packages up to `aws-cdk-lib`, and the jsii compile step drops from ~119s to
~35.5s (3.4x).** Sharing the results as concrete input for the question this
issue asks.

## Does the new API cover what jsii needs? Yes.

We added an experimental `JSII_COMPILER_BACKEND=ts7` backend on a fork (the
existing strada path is untouched) and enforced output-parity gates at every
step:

- `.jsii` assembly: **100% identical** on `constructs` and
  `cloud-assembly-schema`; **99.9% member-identical on `aws-cdk-lib`**
  (20,744 types / 100,380 members — the residual is a short, enumerated tail,
  not a structural gap).
- Emitted JS/d.ts: **byte-identical**, including jsii's rtti injection.
- Two API gaps required patches on the typescript-go side:
  `checker.getFullyQualifiedName` (needed for `symbolId`; now merged upstream
  as microsoft/typescript-go#4700) and a `getEmitOutput`-shaped emit API
  (jsii post-processes emit output for rtti).

## How fast is it, and what limits it?

Same machine, 3-run medians, parity gates enforced at every step:

| lever tried | requests | bytes received | wall-clock |
|---|---:|---:|---:|
| baseline port | 946k | 958 MB | ~46s |
| client-side fixes (input-keyed type cache, local isArrayType) | 816k → 718k | 958 MB | ~41.5s |
| emit written server-side instead of transferred (−344 MB payload) | 718k | 604 MB | ~38.2s |
| batched doc reads (−218k requests) | 500k | 608 MB | **~35.5s** |

Two takeaways:

- **The Go compiler is not the limit.** Go-side type computation is ~15s —
  faster than strada's in-process checker (~17.6s) for the same work.
- **The limit is the out-of-process seam**: ~500k synchronous round-trips at
  ~12-21µs of fixed cost each. Cutting payload by 36% moved wall-clock only
  −8%; cutting request count moved it linearly.

Getting past ~3.4x therefore needs API-shape work on the typescript-go side
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
- typescript-go patches: `getFullyQualifiedName` is merged (#4700); the emit
  API, checker input-keyed cache, and batched doc reads are parity-proven on
  fork branches and being submitted upstream.

Happy to upstream any of this — the backend as an experimental flag, the
analysis, and/or the typescript-go patches — in whatever form is most useful
to the maintainers.
