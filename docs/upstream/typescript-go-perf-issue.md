<!--
Draft issue for microsoft/typescript-go.
Suggested title:
  API: synchronous per-request round-trips dominate bulk-extraction workloads
  — measurements and patches
-->

## Summary

To test whether [jsii](https://github.com/aws/jsii-compiler) (the AWS CDK
multi-language binding generator) can run on the `@typescript/native-preview`
API, we built an experimental port and measured it against `aws-cdk-lib`
(20,744 types / ~100k members). The port works, and is 3.4x faster
end-to-end than the strada-based pipeline (119s → 35.5s), with output parity
enforced at every step. Go-side type computation turned out to be faster
than strada's in-process checker for the same work (~15s vs ~17.6s). The
remaining bottleneck is neither compute nor payload size: it is ~500k
synchronous RPC round-trips at ~12-21µs fixed cost each.

The rest of this issue covers why this workload stresses the API, the
measurements that isolate that conclusion, suggestions, and two
parity-proven patches we're happy to PR.

## Background: why jsii stresses the API

jsii walks every exported symbol, type and doc comment of a package and
queries the checker about each one — a "bulk extraction" pattern shared by
documentation generators, API extractors, and binding generators. With the
strada API this all happens in-process, so per-query cost is a function
call. The native-preview API instead runs the compiler as a Go server: the
Node client holds handles to remote objects, and each query is a synchronous
RPC round-trip. On `aws-cdk-lib`, our initial port issued ~950k round-trips
for a single compile. The question the measurements answer is: of the ~46s
that took, what is actually paying for what?

## Environment

EC2 c7i.4xlarge, Ubuntu 24.04, Node 22, sync API (`unstable/sync`), patched
build including `getFullyQualifiedName` (#4700, since merged) and a draft
disk-writing emit (functionally equivalent to the `emit()` that #4699 has
since shipped). All numbers are 3-run medians on the same instance; every
step was gated on byte/structural output parity, so no step changes
observable behaviour.

## Measurements

Each row changes one variable at a time:

| step | requests | bytes recv | wall | serverTime | transport overhead |
|---|---:|---:|---:|---:|---:|
| initial port | 946,637 | 958 MB | 46s | 15.5s | 20.4s |
| + input-keyed checker cache, client-local isArrayType | 718,548 | 958 MB | 41.5s | 15.3s | 17.1s |
| + emit written server-side (finding 2) | 718,548 | **604 MB (−36%)** | 38.2s | 15.2s | 15.4s |
| + batched doc reads (finding 3) | **500,458 (−30%)** | 608 MB | **35.5s** | 15.2s | 12.7s |

Findings:

1. **Per-request fixed cost dominates.** Wall-clock tracks request count
   nearly linearly at ~12-21µs per synchronous round-trip. A −36% payload cut
   moved wall-clock only −8%; request-count cuts moved it linearly. For bulk
   extraction, the tail is "wait for ~500k serial RPCs".
2. **Huge single responses hurt too.** A full-project emit of aws-cdk-lib
   returned ~345 MB in one response (63% of all received bytes) when emit
   output crossed the channel. Writing server-side with a names-only response
   removed the transfer entirely, with byte-identical outputs on disk.
   *Upstream has since shipped exactly this shape in #4699's `emit()` — good
   to see the direction confirmed; this finding stands as the data behind it.*
3. **The client re-fetches types it already knows.** `getTypeAtLocation`
   issued 116,906 requests that resolved to only 20,317 distinct type ids
   (~5.75x). The object registry dedupes by the *returned* handle, but
   nothing caches by the *input* (node / symbol+location). An input-keyed
   cache on the Checker (valid within a snapshot, cleared on dispose) removed
   ~98k requests with zero behaviour change.

### Batching: measured wins and losses

- **Win:** a batched `getSymbolDocumentations(symbols[])` — per-element
  identical to the individual `getJsDocTags` + `getDocumentationComment` —
  replaced most of ~302k individual doc reads with ~20k batched calls:
  **−218k requests (−30%), −2.7s transport**, no parity impact.
- **Loss:** eagerly prefetching member types ahead of the consumer's lazy
  filters materialized masses of types the lazy path never touched and
  **regressed wall-clock 38 → 47-52s** despite fewer requests. Small batches
  (~2 elements per call) also lose to the per-request fixed cost.
- Rule of thumb: batch APIs pay off exactly when elements are certainly
  needed (post-filter) and batches are large.

## Suggestions

1. **Batch-first traversal APIs** for symbols/types/docs — the remaining
   ~12.7s of transport for this workload lives here.
2. **Async pipelining / request coalescing** on the channel, so a traversal
   is not ~500k sequential waits.
3. **Input-keyed caching on Checker query methods** (node /
   symbol+location), valid per snapshot.
4. A disk-writing emit mode was on this list as well, but #4699 has since
   shipped it, so we consider it addressed.

## Patches (parity-proven, ready to PR)

- Suggestion 3: `WinterYukky/typescript-go@feat/checker-input-cache`
- Suggestion 1 (doc reads): `WinterYukky/typescript-go@feat/api-batched-symbol-docs`
- `checker.getFullyQualifiedName`: merged as #4700

Full measurement history (per-phase gates, raw logs):
https://github.com/WinterYukky/jsii-compiler/blob/feat/ts7-backend-1784773376/src/ts7/PHASE1-RESULTS.md
