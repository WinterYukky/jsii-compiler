<!--
Draft comment for aws/jsii-compiler#1853 ("jsii & TypeScript native").
Final version — paste as-is.
-->

We tested whether jsii can run on the TypeScript 7 (`tsgo`) programmatic API
by building an experimental backend on a fork and validating it against real
packages. The backend produces output that matches the current compiler
exactly on all three packages we tested, and the jsii compile step on
`aws-cdk-lib` went from 119 seconds to 34 seconds, a 3.5x improvement. Both
figures are 3-run medians of the full jsii step (type check, assembly, and
emit) on the same EC2 c7i.4xlarge (Ubuntu 24.04, Node 22).

## What we built and how we validated it

The experimental backend reimplements the compiler interactions of jsii's
Assembler and emitter on top of `@typescript/native-preview`. The existing
compilation path is untouched, so we can compile the same package with both
backends and compare everything they produce.

jsii produces two kinds of output. The first is the `.jsii` assembly, the
model of exported types, members, and documentation that binding generators
consume. The second is the compiled JavaScript and declaration files, which
jsii post-processes to inject runtime type information. We compared both on
three packages of increasing size: `constructs`, `cloud-assembly-schema`,
and `aws-cdk-lib` (21,192 types, 102,570 members).

The `.jsii` assembly is identical on all three packages (53/53 members on
constructs, 213/213 on cloud-assembly-schema, 102,570/102,570 on
aws-cdk-lib, zero differences). The emitted JavaScript and declaration files
are byte-identical as well, including the injected runtime type information.

## Artifacts

The experimental backend and the full measurement history are on the fork:
https://github.com/WinterYukky/jsii-compiler/tree/feat/ts7-backend-1784773376.
Happy to share more detail on any of it.

Would it be OK to start by opening a draft PR that adds this backend behind
an experimental flag, so you can poke at it directly? If a different route
is easier to review, we'll follow your lead.

## Appendix A: How we got the performance

The 3.5x above is not the number of a naive port. The new API runs the
compiler as a separate Go process, and every checker query is a synchronous
RPC round-trip; our first working version issued roughly 950,000 of them for
a single `aws-cdk-lib` compile. From there we changed one variable at a time
and measured, re-running the parity checks above after every change (all
numbers 3-run medians).

| change | requests | bytes received | wall-clock |
|---|---:|---:|---:|
| first working version | 946k | 958 MB | ~46s |
| client-side fixes (local isArrayType and other redundant calls) | 816k | 958 MB | ~44s |
| input-keyed type cache on the client | 718k | 958 MB | ~41.5s |
| emit written server-side instead of transferred (−344 MB) | 718k | 604 MB | ~38.2s |
| batched documentation reads (−218k requests) | 500k | 608 MB | ~35.5s |
| parameter docs read from source text | 472k | 621 MB | ~34.1s |

The Go compiler itself is not the limiting factor. Server-side type
computation takes about 13.5 seconds, faster than the current in-process
checker doing the same work (about 17.6 seconds, measured on the same
machine). The limiting factor is the round-trips themselves. In the final
row, 13.4 of the 34.1 seconds is transport overhead spread over 472,193
requests, about 28µs per synchronous round-trip. Reducing the bytes
transferred by 36% improved wall-clock time by only 8%, while reducing the
number of requests improved it almost linearly.

Gains beyond this point live in the typescript-go API surface
(batch-oriented traversal, pipelining on the RPC channel) rather than in
anything jsii can do alone. We think these measurements are worth having on
the typescript-go side too, so we are filing them there separately.

## Appendix B: Notes

When we started this validation, the API was missing two capabilities jsii
needs. We contributed one upstream, `checker.getFullyQualifiedName`, which
jsii uses to derive `symbolId` (merged as microsoft/typescript-go#4700).
While we were validating, the TypeScript team shipped the other, an emit API
whose outputs a tool can post-process (microsoft/typescript-go#4699). Both
gaps are closed today. We also found that tsgo's doc APIs currently resolve
parameter JSDoc differently from TypeScript 5 (inheriting `@param` from base
declarations too eagerly, and dropping some tags). The backend reads
documentation directly from source text to work around this, and we are
reporting the difference upstream with a reproduction and a proposed fix.

This is a feasibility validation, not a finished migration and not a
proposal to switch now. The programmatic API is still the unstable preview
surface and is scheduled to stabilize in a later release.
