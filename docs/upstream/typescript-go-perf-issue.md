<!--
Draft issue for microsoft/typescript-go.
Suggested title:
  API: performance characteristics for bulk-extraction workloads
  (compiler-as-a-library tools) — measurements and suggestions
-->

## Summary

We ported [jsii](https://github.com/aws/jsii-compiler) (the AWS CDK multi-language
binding generator — a "traverse every exported symbol, type and doc comment"
compiler-as-a-library tool) onto the `@typescript/native-preview` API and measured
it against `aws-cdk-lib` (20,744 types / ~100k members, one of the largest real
TypeScript API surfaces). The port works and is already **3.4x faster than the
strada-based pipeline end-to-end**, and Go-side type computation is *faster than
the in-process strada checker* for the same work.

This issue shares where the remaining time goes for this class of workload, with
step-by-step measurements, and a few API suggestions — plus parity-proven patches
we're happy to PR.

Environment: EC2 c7i.4xlarge, Ubuntu 24.04, Node 22, sync API (`unstable/sync`),
patched build including #4700 (`getFullyQualifiedName`) and a draft
`getEmitOutput`. All numbers are 3-run medians on the same instance; every step
was gated on byte/structural output parity, so no step changes observable
behaviour.

## Measurements: eliminating the suspects one by one

| step | requests | bytes recv | wall | serverTime | transport overhead |
|---|---:|---:|---:|---:|---:|
| initial port | 946,637 | 958 MB | 46s | 15.5s | 20.4s |
| + input-keyed checker cache, client-local isArrayType | 718,548 | 958 MB | 41.5s | 15.3s | 17.1s |
| + emit written server-side (see below) | 718,548 | **604 MB (−36%)** | 38.2s | 15.2s | 15.4s |
| + batched doc reads (see below) | **500,458 (−30%)** | 608 MB | **35.5s** | 15.2s | 12.7s |

Three findings:

1. **Per-request fixed cost dominates.** Wall-clock tracks request count nearly
   linearly at **~12-21µs per synchronous round-trip**; a −36% payload cut moved
   wall-clock only −8%. For bulk extraction, the tail is "wait for ~500k serial
   RPCs", not bytes and not Go compute.
2. **`getEmitOutput`-style APIs shouldn't return the whole emit over the wire.**
   A full-project emit of aws-cdk-lib returned **~345 MB in a single response**
   (63% of all received bytes). An optional `writeToDisk` (server writes outputs
   via the same code path the CLI uses, response carries names only) removed the
   transfer entirely with byte-identical outputs on disk.
3. **The client re-fetches types it already knows.** `getTypeAtLocation` was
   observed issuing 116,906 requests that resolve to only **20,317 distinct type
   ids (~5.75x)** — the object registry dedupes by the *returned* handle, but
   nothing caches by the *input* (node / symbol+location). An input-keyed cache
   on the Checker (safe within a snapshot; cleared on dispose) removed ~98k
   requests with zero behaviour change.

### What batching does and doesn't buy (measured)

- **Wins**: small, self-contained, certainly-needed payloads in large batches.
  A batched `getSymbolDocumentations(symbols[])` (per-element identical to the
  individual `getJsDocTags` + `getDocumentationComment`) replaced most of ~302k
  individual doc reads with ~20k batched calls (a ~64k tail on the parameter
  path remains individual): **−218k total requests (−30%), −2.7s transport**,
  no parity impact.
- **Losses**: (a) batching that front-runs lazy evaluation — eagerly prefetching
  member types *before* the consumer's filters ran materialized masses of types
  the lazy path never touched and **regressed wall-clock 38→47-52s** despite
  fewer requests; (b) small batches (~2 elements per signature) lose to the
  per-request fixed cost. Batch APIs help exactly when elements are post-filter
  certain and batches are large.

## Suggestions

1. **Batch-first traversal APIs** for symbols/types/docs (and auditing the
   client's internal lazy materialization for the same pattern) — this is where
   the remaining ~12.7s of transport for this workload lives.
2. **Break round-trip seriality**: async pipelining / request coalescing on the
   channel, so a traversal isn't ~500k sequential waits.
3. **`getEmitOutput` with a write-to-disk (or streaming) mode** rather than a
   single huge response.
4. **Input-keyed caching on Checker query methods** (node / symbol+location),
   valid per snapshot.

## Patches (parity-proven, happy to PR)

- Input-keyed Checker cache (suggestion 4): fork branch
  `WinterYukky/typescript-go@draft/api-client-typecache-*`
- `getEmitOutput` + `writeToDisk` (suggestion 3): `draft/api-emit-*`
- Batched `getSymbolDocumentations` (suggestion 1): `draft/api-batch-docs-*`
- `checker.getFullyQualifiedName`: already open as #4700

Full measurement history (per-phase gates, raw logs):
https://github.com/WinterYukky/jsii-compiler/blob/feat/ts7-backend-1784773376/src/ts7/PHASE1-RESULTS.md
