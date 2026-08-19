<!--
Draft comment for aws/jsii-compiler#1853 ("jsii & TypeScript native").
Final version for maintainer review — paste as-is.
-->

We tested whether jsii can run on the TypeScript 7 (`tsgo`) programmatic API.
We built an experimental backend on a fork and validated it against real
packages. The backend produces output that matches the current compiler, and
it compiles `aws-cdk-lib` in 35 seconds where the current compiler takes 119
seconds, a 3.4x improvement. This comment describes the validation, the
performance characteristics, and what we can contribute.

## Validation

The experimental backend reimplements the compiler interactions of jsii's
Assembler and emitter on top of `@typescript/native-preview`. The existing
compilation path is untouched, so we can compile the same package with both
backends and compare everything they produce.

jsii produces two kinds of output: the `.jsii` assembly (the model of
exported types, members, and documentation that binding generators consume)
and the compiled JavaScript and declaration files (which jsii post-processes
to inject runtime type information). We compared both on three packages of
increasing size: `constructs`, `cloud-assembly-schema`, and `aws-cdk-lib`
(20,744 types, 100,380 members).

The `.jsii` assembly is identical on the two smaller packages. On
`aws-cdk-lib`, 99.9% of members match exactly; the remaining 0.1% is a
short, enumerated list of known differences, not a structural gap. The
emitted JavaScript and declaration files are byte-identical on all three
packages, including the injected runtime type information.

The API surface was missing two capabilities jsii needs. We contributed one
upstream: `checker.getFullyQualifiedName`, which jsii uses to derive
`symbolId`, merged as microsoft/typescript-go#4700. The TypeScript team
shipped the other, an emit API whose outputs a tool can post-process, in
microsoft/typescript-go#4699. No API gaps remain for jsii's use case.

This is a feasibility validation, not a finished migration. The backend
lives on a fork behind an experimental flag, we validated three packages,
and the 0.1% member tail on `aws-cdk-lib` is still open.

## Performance

The new API runs the compiler as a separate Go process. The Node client
holds handles to remote objects, and every checker query is a synchronous
RPC round-trip. Compiling `aws-cdk-lib` issued roughly 950,000 round-trips
in our first working version. To understand the cost structure, we changed
one variable at a time and measured. All numbers are 3-run medians on the
same machine, and we re-ran the parity checks after every change.

| change | requests | bytes received | wall-clock |
|---|---:|---:|---:|
| first working version | 946k | 958 MB | ~46s |
| client-side fixes (input-keyed type cache, local isArrayType) | 816k → 718k | 958 MB | ~41.5s |
| emit written server-side instead of transferred (−344 MB payload) | 718k | 604 MB | ~38.2s |
| batched documentation reads (−218k requests) | 500k | 608 MB | ~35.5s |

The Go compiler is not the limiting factor. Server-side type computation
takes about 15 seconds, faster than the current in-process checker doing the
same work (about 17.6 seconds). The limiting factor is the round-trips
themselves: roughly 500,000 synchronous waits of 12-21µs each. Reducing the
bytes transferred by 36% improved wall-clock time by only 8%, while reducing
the number of requests improved it almost linearly.

Gains beyond 3.4x therefore require API changes on the typescript-go side,
such as batch-oriented traversal APIs or pipelining on the RPC channel,
rather than anything jsii can do alone. We are filing the detailed
measurements and suggestions with the typescript-go team separately.

## What exists today

The experimental backend and the full measurement history are on the fork:
https://github.com/WinterYukky/jsii-compiler/tree/feat/ts7-backend-1784773376
(`src/ts7/README.md` covers the architecture decision;
`src/ts7/PHASE1-RESULTS.md` records every phase's numbers, parity gates, and
lessons). The initial feasibility spike, including an API-coverage
inventory, is written up in
https://github.com/WinterYukky/jsii-compiler/issues/1. Two performance
patches for typescript-go, an input-keyed checker cache and batched
documentation reads, are parity-proven on fork branches and being submitted
upstream.

We are happy to contribute any of this — the backend as an experimental
flag, the analysis, or the typescript-go patches — in whatever form is most
useful to the maintainers.
