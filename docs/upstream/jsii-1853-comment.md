<!--
Draft comment for aws/jsii-compiler#1853 ("jsii & TypeScript native").
Final version for maintainer review — paste as-is.
-->

We tested whether jsii can run on the TypeScript 7 (`tsgo`) programmatic API
by building an experimental backend and validating it against real packages,
including `aws-cdk-lib`. It can: the backend produces output that matches the
current compiler, and the jsii compile step on `aws-cdk-lib` went from
roughly 119 seconds to 35 seconds, a 3.4x improvement. This comment
summarizes how we validated that, what limits further gains, and what we can
contribute.

## What we built and how we validated it

We added an experimental `JSII_COMPILER_BACKEND=ts7` backend on a fork of
jsii-compiler. It reimplements the Assembler's and emitter's interactions
with the TypeScript compiler on top of `@typescript/native-preview`, and
leaves the existing compilation path untouched; an environment variable
selects between the two. Because both backends compile the same package,
validation is a direct comparison of everything they produce.

jsii produces two kinds of output. The first is the `.jsii` assembly, the
model of all exported types, members, and documentation that downstream
binding generators consume. The second is the compiled JavaScript and
declaration files, which jsii post-processes to inject runtime type
information. We compared both, on three packages of increasing size:
`constructs`, `cloud-assembly-schema`, and `aws-cdk-lib` (20,744 types and
100,380 members).

On the two smaller packages the `.jsii` assembly is identical. On
`aws-cdk-lib`, 99.9% of members match exactly, and the remaining 0.1% is a
short, fully enumerated list of known differences rather than a structural
gap. The emitted JavaScript and declaration files are byte-identical on all
three packages, including the injected runtime type information.

Reaching this point required two APIs that the unstable surface did not have
when we started, and both are now available upstream.
microsoft/typescript-go#4700 added `checker.getFullyQualifiedName`, which
jsii needs to derive `symbolId`. microsoft/typescript-go#4699 added an
`emit()` whose outputs a tool can post-process; the TypeScript team shipped
it independently while we were validating, and our measurements used our own
draft implementation, which is functionally equivalent.

This is a feasibility validation rather than a finished migration. The
backend is an experimental flag on a fork, validated against three packages,
and the 0.1% member tail on `aws-cdk-lib` is still open.

## Performance

Unlike the current API, where a checker query is a function call within the
same process, the new API runs the compiler as a separate Go process. The
Node client holds handles to remote objects, and every query is a synchronous
RPC round-trip. Compiling `aws-cdk-lib` issued roughly 950,000 round-trips in
our first working version. To understand the cost structure, we changed one
variable at a time and measured. All numbers are 3-run medians on the same
machine, and the parity checks described above were re-run after every
change.

| change | requests | bytes received | wall-clock |
|---|---:|---:|---:|
| first working version | 946k | 958 MB | ~46s |
| client-side fixes (input-keyed type cache, local isArrayType) | 816k → 718k | 958 MB | ~41.5s |
| emit written server-side instead of transferred (−344 MB payload) | 718k | 604 MB | ~38.2s |
| batched documentation reads (−218k requests) | 500k | 608 MB | ~35.5s |

Two conclusions follow. First, the Go compiler is not the limiting factor:
server-side type computation takes about 15 seconds, which is faster than the
current backend's in-process checker doing the same work (about 17.6
seconds). Second, the limiting factor is the round-trips themselves, roughly
500,000 synchronous waits of 12-21µs each. Reducing the bytes transferred by
36% improved wall-clock time by only 8%, while reducing the number of
requests improved it almost linearly.

Gains beyond 3.4x therefore depend on API changes on the typescript-go side,
such as batch-oriented traversal APIs or pipelining on the RPC channel,
rather than on anything jsii can do alone. We are filing the detailed
measurements and suggestions with the typescript-go team separately.

## What exists today

The experimental backend and the full measurement history are on the fork:
https://github.com/WinterYukky/jsii-compiler/tree/feat/ts7-backend-1784773376
(`src/ts7/README.md` covers the architecture decision, and
`src/ts7/PHASE1-RESULTS.md` records every phase's numbers, parity gates, and
lessons). The initial feasibility spike, including an API-coverage inventory,
is written up in https://github.com/WinterYukky/jsii-compiler/issues/1. On
the typescript-go side, `getFullyQualifiedName` is merged, the emit API is
covered by upstream's own work, and two performance patches (an input-keyed
checker cache and batched documentation reads) are parity-proven on fork
branches and being submitted upstream.

We are happy to contribute any of this — the backend as an experimental
flag, the analysis, or the typescript-go patches — in whatever form is most
useful to the maintainers.
