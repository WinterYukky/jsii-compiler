# TS7 backend — Phase 1 results & Phase 2 backlog

> Companion to `src/ts7/README.md` (architecture decision) and
> `poc/typescript7/PORT-ANALYSIS.md` (feasibility branch). Records the measured
> outcome of the Phase 1 spike and the concrete follow-up work.

## TL;DR

The experimental `JSII_COMPILER_BACKEND=ts7` backend generates `.jsii` assemblies
that are **byte-for-byte identical to strada on small/medium real packages, and
99.7% member-identical on aws-cdk-lib (20,744 types)**, while running the
check+assemble step **~2.9x faster** than strada. The remaining 0.3% is a small
set of well-understood, enumerated edge cases (not deep bugs).

## Verification results

Same jsii binary, backend selected only via `JSII_COMPILER_BACKEND=ts7`; `.jsii`
compared with `poc/typescript7/compare-jsii.mjs` (which normalizes
`locationInModule` and union member order).

| Gate | Package | Types | Members | Parity | ts7 vs strada (jsii step) |
|---|---|---:|---:|---|---|
| 1 | `constructs` | 12 | 53 | **100%** | 0.16s vs 0.71s |
| 2 | synthetic `constructs` consumer | 3 | 7 | **100%** | fast |
| 2b | `cloud-assembly-schema` | 59 | 213 | **100%** | 0.25s vs 0.77s |
| A (stretch) | `aws-cdk-lib` | 20,744 | 100,108 / 100,380 | **99.7%** | **41s vs 119s (2.9x)** |

### M5 — JS/d.ts emit + rtti (the "and JS/d.ts are emitted" half of the goal)

Building `constructs` with the ts7 backend emits the full artifact set and the
injected rtti matches strada at runtime:

- **7 `.js` + 7 `.d.ts` emitted** (same set as strada).
- **`index.d.ts` byte-identical** to strada's output.
- **rtti identical for 5/5 exported classes** — each carries
  `Symbol.for("jsii.rtti") = { fqn, version }` equal to strada's, verified by
  `require()`-ing both `lib/`s and comparing at runtime.

Gate 2 specifically validated the **external-assembly resolution path**: a class
`extends constructs.Construct`, an interface `extends constructs.IConstruct`, and
properties/params typed as external `constructs.*` types — all resolved to the
correct external FQNs, and `dependencies` emitted, identically to strada.

The compressed on-disk form (`.jsii` redirect + `.jsii.gz`) is produced via the
same `@jsii/spec` `writeAssembly` + a strada-identical fingerprint, so the output
format matches strada exactly (not just the logical structure).

## Phase 2A — tail reduction (correctness pass)

Phase 2A ported more of strada's assembler semantics to shrink the aws-cdk-lib
diff, keeping the three smaller gates at **100%** parity throughout.

| metric (aws-cdk-lib) | Phase 1 | Phase 2A |
|---|---|---|
| members identical | 99.7% (100108) | **99.9% (100234)** |
| field diffs | 25 | **1** |
| member diffs | 635 | **509** |

Landed:
- **Interface heritage flattening** (`_processBaseInterfaces`): erase private/
  internal/unexported bases and recurse into their bases; keep public bases as
  `interfaces`. Fixed 24 of 25 field diffs.
- **Intersection types** (`_intersectionTypeReference`): `A & B` →
  `{ intersection: { types } }`. Eliminated all intersection diffs.
- **Inherited constructor** (`_inheritedConstructor`): walk the `extends` chain
  for the effective initializer when a class declares none.
- **Member declaring-type resolution**: decide "own vs inherited-from-named-base"
  by the member's *declaring* type symbol id. Fixed 96 MISSING members (static
  factories, inherited interface methods).

### Key learning: "declaring type" vs "membership type" (the getParent trap)

For a member obtained from `checker.getPropertiesOfType(type)`, the member
`symbol.getParent()` returns the *queried* type (membership), **not** the type
that declares it. Using it to classify inherited members mis-labels them as
"own" (this doubled EXTRA props to 701). The declaring type must be resolved from
the member's owner declaration node via `getTypeAtLocation(ownerDecl).getSymbol()`,
and compared by **symbol id** (never node identity — `NodeHandle.resolve()`
re-materializes fresh nodes each call, so `===` on nodes is unreliable; this
same trap bit the rtti injection earlier). Restored EXTRA to baseline (363) while
keeping MISSING at 8.

### Remaining Phase 2B tail (aws-cdk-lib)

- **EXTRA 363** — some struct props (e.g. `AssetStagingProps.exclude/extraHash/
  ignoreMode` from `FingerprintOptions`/`AssetOptions`) are still re-listed even
  though the base is a named `interfaces` entry. The declaring-type resolution
  handles most cases but not these (likely alias/re-export of the base type);
  needs the same treatment strada applies via its deferred base-property dedup.
- **DIFFER 138 — parameter docs (intentionally deferred).** jsii's parameter-doc
  behavior is declaration-origin dependent (inherited/overridden methods omit
  `@param` docs; own methods include them, split into summary + remarks). A naive
  `@param` derivation was net-neutral and fragile, so it is deferred; reproduce
  strada's `parseSymbolDocumentation` rules here.
- **MISSING 8 — inherited static factory methods** (`fromXxxName`,
  `fromXxxAttributes`, `isSecurityGroup`). The static-member loop only lists
  statics declared directly on the class; strada re-lists inherited static
  factories on subclasses. Extend the static loop with the same declaring-type
  logic used for instance members.
- **1 field diff — enum member strip-deprecated** (`EbsDeviceVolumeType`): ts7
  keeps deprecated aliased enum members that strada strips. Apply the strip check
  to enum members with strada's FQN form.
- **1 missing type — `aws_docdb.CaCertificate`**: a single submodule-export edge.

## The 0.3% tail on aws-cdk-lib (Phase 1 categorization, superseded by Phase 2A above)

All differences fall into a small number of enumerated categories. None indicate a
fundamental limitation of the TS7 API; each maps to a specific piece of strada's
`Assembler` logic that the Phase 1 directed port did not yet reproduce.

1. **Struct interface heritage flattening** (majority of the 25 field diffs).
   For structs whose base interfaces arrive via multi-`extends` / type-alias /
   intersection chains (e.g. many `aws_stepfunctions.*Props`,
   `aws_codebuild.*SourceProps`, `aws_apigateway.RestApiProps`), the ts7
   `_visitInterface` uses `type.getBaseTypes()` and does not flatten the heritage
   the way strada does; result: `interfaces` is empty or partial.
   → Port strada's interface-heritage collection (the `extends` walk that flattens
   through aliases/intersections), analogous to the class `collectHeritage` we
   already reproduce for classes.

2. **Intersection types → `any`** (a subset of member DIFFERs).
   `{ intersection: { types: [A, B] } }` (e.g. `cloudfront.S3OriginConfig
   .originAccessIdentity: ICloudFrontOriginAccessIdentityRef & IGrantable`) is
   emitted by ts7 as `{ primitive: 'any' }`.
   → `_typeReference` needs an intersection branch (jsii models these as a
   `spec.NamedTypeReference`/union-ish shape; match strada's `_typeReference`).

3. **`stripDeprecated` leakage on enum members.**
   `aws_ec2.EbsDeviceVolumeType` kept deprecated aliased members (COLD_HDD,
   GENERAL_PURPOSE_SSD, …) that strada stripped.
   → Apply the deprecated-strip allowlist check to enum members with the same FQN
   form strada uses.

4. **Inherited-constructor initializers.**
   `aws_cloudwatch.AlarmBase` has an empty `<init>` in ts7 but a full initializer
   in strada (constructor inherited from a base class).
   → Resolve the effective constructor signature through the base chain when the
   class itself does not declare one.

5. **Missing parameter docs on some initializers** (cosmetic; a subset of
   `<init>` DIFFERs where a param's `docs.summary` is absent on the ts7 side).
   → Doc-comment resolution for parameters declared on base/overridden signatures.

6. **1 missing type**: `aws_docdb.CaCertificate` (single type not registered;
   likely a submodule-export edge). → Investigate its export/namespace shape.

## Also deferred to Phase 2 (from README scope)

- **Diagnostics / negative-path** (`JSII_xxxx` codes) — the other half of the
  strada `Assembler`'s value; entirely out of Phase 1 scope.
- **Emit pipeline**: `getEmitOutput` + rtti post-emit pass are now wired into
  `emitTs7` (M5): the ts7 backend writes `.js`/`.d.ts` and injects the
  `Symbol.for("jsii.rtti")` marker. Still deferred to Phase 2: the
  **`.warnings.jsii.js` generation** (deprecation-warnings) and the
  `deprecated-remover` emit surgery (the `.jsii`-side strip is already done).
- **Watch mode** (snapshot `updateSnapshot({ fileChanges })`).
- **Assembly header fidelity**: `readme`, `docs`, `jsiiVersion`, `bin`,
  `dependencyClosure`, `metadata`, `usedFeatures`, `contributors`, `keywords`,
  `fingerprint` — Phase 1 emits a minimal header (this is why the raw `.jsii`
  byte sizes differ even when types/members match). Wire these from `ProjectInfo`
  for full header parity.
- **Type strategy**: replace the `any`-typed `Ts7Host`/assembler with proper type
  abstractions once parity is locked.

## Upstream API design feedback

- **Whole-project emit beats per-file emit at scale.** An early emit pipeline
  called `program.getEmitOutput(sf)` once per source file. At aws-cdk-lib scale
  (~thousands of files) this issues one RPC round-trip per file and destabilized
  the out-of-process tsgo session (observed `EPIPE` / process exit mid-run). The
  fix — and the recommended usage — is a single whole-project `getEmitOutput()`
  call (Go side emits in parallel, collects under a mutex), which collapses the
  round-trips to one. Worth surfacing to the typescript-go API designers: either
  document this clearly or make per-file emit cheaper/streamed for tools that
  legitimately want incremental emit.

## Phase 2B — performance pass (closed)

Goal: get the ts7 jsii step (already ~2.9x faster than strada) toward a ~15s
target on aws-cdk-lib. Approach: reduce out-of-process RPCs on the hot path,
proving each change does not regress parity.

### What landed (proven wins, parity 100% maintained)

- **Client-side array-type check** (`_isArrayType`): replaced
  `checker.isArrayType` (~85k RPCs on aws-cdk-lib) with a local check
  (`isTypeReference` objectFlags bit + target symbol name `Array`/`ReadonlyArray`
  from `lib.*.d.ts`). Verified byte-identical `.jsii` vs `checker.isArrayType`.
- **Per-symbol doc-read memoization** (`_jsDocTags`/`_docComment`), keyed by the
  symbol's declaration coordinate (`NodeHandle.path:index` — stable, readable
  without a `resolve()` RPC; `symbol.id` was undefined/unstable here and made an
  earlier attempt inert). ~520k logical hits on aws-cdk-lib.

Net: aws-cdk-lib RPCs **946k → 816k (−14%)** with parity unchanged.

### What did NOT work, and why (the important finding)

1. **`_typeReference` memoization by `type.id`** (implemented, measured,
   reverted: af893c7 → df4f574). Profiling showed `getTypeAtLocation` issuing
   **116,906 calls for only 20,317 distinct type ids (~5.75x)**, suggesting
   redundant type resolution. But memoizing the assembler's `_typeReference`
   results changed **neither RPC count nor wall-clock**: the redundant
   `getTypeAtLocation` RPCs do not originate from the assembler's call sites — the
   `type` objects reach `_typeReference` already resolved, and those RPCs are
   issued earlier by the client's lazy type materialization. The redundancy lives
   **below the application layer**, so an app-level cache cannot remove it.
2. **Parameter docs derivation** (Phase 2A #5, deferred): net-neutral and
   declaration-origin dependent; see the Phase 2A section.

### Where the wall-clock actually goes (measured, aws-cdk-lib, 3-run median)

`getTimingInfo()` with `collectTiming` on the ts7 emit:

- **roundTripMs ≈ 34.9s = serverTimeMs ≈ 15.3s + transportOverheadMs ≈ 19.8s**
- **bytesReceived ≈ 957 MB** across ~816k requests.

- **The Go compiler is not the bottleneck.** serverTimeMs (~15.3s, the Go-side
  type computation) is *lower* than strada's in-process checker time (~17.6s,
  measured in Phase 1). The Go port does the same semantic work as fast or faster.
- **The out-of-process type transfer is the bottleneck.** ~957 MB of type-object
  payload + transport (~19.8s), amplified by redundant type fetches, dominate the
  ~44s wall-clock. RPC *count* is not the driver (cutting 85k isArrayType RPCs
  moved wall-clock ~1s).

### Upstream feedback for microsoft/typescript-go (actionable, with repro)

1. **Client type-cache miss: same type re-fetched ~5.75x.**
   `ProjectObjectRegistry` dedupes `Type` objects by id, yet `getTypeAtLocation`
   is observed fetching the same types repeatedly: **116,906 calls resolve to only
   20,317 distinct type ids** on aws-cdk-lib. Some resolution paths (lazy
   materialization of type properties / `getTypeArguments` / union member
   expansion) appear to miss the client-side type cache's hit condition and issue
   a fresh server fetch for an already-known type id.

   *Reproduction:* monkey-patch `Client.prototype.apiRequest` to tally calls and
   the returned object's `id` per method, then run a full aws-cdk-lib assembly
   through the sync API. `getTypeAtLocation` shows calls (116,906) ≫ distinct ids
   (20,317).

2. **Type-response payload dominates at scale.** ~957 MB received for one
   aws-cdk-lib assembly. Batch APIs (`getTypeAtLocation(nodes[])`) cut round-trips
   but not this payload. What moves the needle: **lighter type responses / field
   selection / delta transfer**, plus closing the cache miss above so each type is
   serialized once rather than ~6x.

### Final numbers (Phase 1 → Phase 2 close-out, aws-cdk-lib)

| metric | value |
|---|---|
| strada jsii (reference) | ~119s |
| ts7 jsii (wall-clock, 3-run median) | **~44.3s** (~2.7x faster) |
| ts7 serverTimeMs (Go type compute) | ~15.3s (< strada checker ~17.6s) |
| ts7 transportOverheadMs | ~19.8s |
| ts7 bytesReceived | ~957 MB |
| ts7 RPC requests (Phase 1 → 2B) | 946k → **816k (−14%)** |
| `.jsii` parity — constructs | **100%** (53/53 members) |
| `.jsii` parity — synthetic consumer | **100%** (7/7) |
| `.jsii` parity — cloud-assembly-schema | **100%** (213/213) |
| `.jsii` parity — aws-cdk-lib | **99.9%** (100,234/100,380; 1 field diff) |

**Phase 2B is closed.** Every optimization reachable from the application layer
has been taken (−14% RPC, parity untouched). The remaining path to a lower
wall-clock is in the client/API layer (type-response weight + the client
type-cache miss), now quantified precisely enough for an upstream issue.

## Phase 2C — typescript-go client type-cache PoC (closed)

A follow-up PoC to the Phase 2B finding that the wall-clock is bound by
out-of-process type transfer, not the Go compute. Hypothesis: the checker-level
`getTypeAtLocation(node)` / `getTypeOfSymbolAtLocation(symbol, location)` issue an
RPC on every call (the object registry only dedupes by the *returned* type handle,
not by the *input*), so the same node/symbol is re-fetched repeatedly (~5.75x on
aws-cdk-lib: 116,906 calls -> 20,317 distinct type ids).

**Patch (client-only, no protocol change):** add input-keyed caches on the
`Checker` — `Map<nodeId, Type>` for `getTypeAtLocation` (array overload fetches
only cache misses) and `Map<symbol.id+':'+nodeId, Type>` for
`getTypeOfSymbolAtLocation`, cleared on `dispose()` (a snapshot's program is
immutable, so no stale risk). Branch: WinterYukky/typescript-go
`draft/api-client-typecache-1784799727`.

### Result (aws-cdk-lib, same c7i instance, 3-run median)

| metric | before | after (patched client) | delta |
|---|---|---|---|
| RPC requests | 816,549 | **718,548** | **-98,001 (-12%)** |
| wall-clock (median) | 41.5s | **39.3s** | -2.2s (-5%) |
| bytesReceived | 957.8 MB | 947.6 MB | -10 MB (-1%) |
| serverTimeMs | ~13.8s | ~13.6s | ~0 |
| transportOverheadMs | ~19.0s | ~16.9s | -2.1s |

**Parity (the absolute gate): PASSED.** before vs after `.jsii` were
**byte-identical (100,735 / 100,735 members, 0 diffs)** — the cache never returns
a stale type. All four gates intact: constructs 100%, cloud-assembly-schema 100%,
aws-cdk-lib 99.9% (same known tail), synthetic consumer 100%.

### Key finding: the 5.75x re-fetch was real but *cheap*; payload is the wall

Cutting 98k RPCs (-12%) moved bytesReceived by only 10 MB (-1%). The duplicate
`getType*` calls returned **small** payloads (the type was already materialized
server-side, so repeats returned lightweight references). Profiling the response
bytes **per method** (hooking `SyncRpcChannel.requestSync`) shows where the
~947 MB actually comes from:

| response bytes | calls | method |
|---|---|---|
| **344.6 MB** | **1** | **getEmitOutput** (whole-project JS + d.ts in one response) |
| 107.7 MB | 40,272 | getPropertiesOfType |
| 13.2 MB | 143,270 | getDocumentationComment |
| 12.5 MB | 159,351 | getJsDocTags |
| 12.5 MB | 52,996 | getTypesOfType |
| 9.7 MB | 107,463 | getTypeOfSymbolAtLocation |
| 8.9 MB | 20,743 | getExportsOfSymbol |
| ... | | (tail) |

Two dominant payloads: **(1) `getEmitOutput` alone is ~345 MB** — the entire
emitted JS/d.ts for aws-cdk-lib returned in a single response; **(2)
`getPropertiesOfType` ~108 MB** across 40k calls (full property/type objects for
every type). The `getType*` duplicate-fetch traffic is comparatively tiny.

### Conclusion

The client type-cache is a **correct, safe, keeper improvement** (-12% RPC, -2.2s,
parity byte-identical, client-only). But it is **not** the 5x unlock: the wall is
the **type/emit payload transfer** (getEmitOutput 345 MB + getPropertiesOfType
108 MB dominate the ~947 MB), which no client-side cache can remove. This
quantitatively confirms and sharpens the Phase 2B conclusion.

### Upstream feedback for microsoft/typescript-go (updated, with numbers)

1. **Ship the input-keyed checker cache** (this patch): -12% RPC at zero
   correctness cost, useful for any batch traversal tool.
2. **The real lever is response-payload weight, not round-trip count.** For
   full-project traversal at aws-cdk-lib scale (~947 MB received): (a)
   `getEmitOutput` should support streaming / per-file / write-to-disk on the Go
   side rather than returning ~345 MB in one JS payload; (b) type responses
   (`getPropertiesOfType`, `getType*`) would benefit from **field selection /
   lighter shapes / delta transfer** so a full assembly does not serialize every
   type object in full.

## Phase 2D — getEmitOutput writeToDisk PoC (closed) & series conclusion

Phase 2C isolated the ~947 MB payload as the suspected wall; its single largest
component was `getEmitOutput` returning the whole emitted JS/d.ts in one ~345 MB
response. Phase 2D eliminated that transfer to directly test the hypothesis
"payload down → wall-clock down".

**Patch** (typescript-go `draft/api-emit-writetodisk-1784803902`, jsii 54c0e03):
optional `writeToDisk` on `getEmitOutput` — the server writes every output via
`osvfs.FS().WriteFile` (the tsgo CLI's own emit writer: parent dirs ensured,
UTF-8, no BOM) and returns names only; jsii reads back just the class-bearing
`.js` files to append rtti. Backward compatible; write errors propagate as RPC
errors. Implementation note: the snapshot's source FS is **read-only**
(`WriteFile` panics "unimplemented") — emit must go through the real OS FS.

### Gates (all passed)

- **Emit byte-identity**: recursive diff of the emitted `lib/` (file set AND
  contents, maps included) vs the previous in-memory path — **identical**,
  rtti included. (This gate caught the sourceFS panic immediately on the first
  attempt — the invalid run was discarded.)
- `.jsii` 0-diff; constructs 100%, cloud-assembly-schema 100%, aws-cdk-lib 99.9%
  (same known tail).

### Result (aws-cdk-lib, same instance, 3-run median)

| metric | baseline (2C) | after (2D) | delta |
|---|---|---|---|
| wall-clock | 41.5s | **38.2s** | **-3.3s (-8%)** |
| bytesReceived | 947.6 MB | **603.9 MB** | **-343.7 MB (-36%)** |
| transportOverheadMs | ~17.1s | ~15.2s | -1.9s |
| serverTimeMs | ~15.1s | ~15.2s | ~0 |
| RPC requests | 718,548 | 718,548 | 0 |

### Series conclusion: the wall, identified by elimination

The 2B→2C→2D sequence eliminated the suspects one by one:

1. **2B — bytes are not the whole story**: cutting 85k RPCs (isArrayType) moved
   wall-clock ~1s; app-level caches could not reach the redundant fetches.
2. **2C — duplicate calls are cheap**: fixing the real client type-cache miss
   (-98k RPCs, -12%) moved wall-clock -2.2s; payload barely changed.
3. **2D — payload is not the whole story either**: removing **36% of all received
   bytes** (-344 MB) moved wall-clock only **-8%** (-3.3s).

What remains: roundTrip ≈ 30.5s = serverTime 15.2s + transport 15.3s, with
**transport 15.3s / 718,548 requests ≈ 21µs of fixed synchronous round-trip cost
per request**. The wall is neither Go compute (already faster than strada's
checker: 15.2s vs 17.6s) nor bytes — it is the **serialized wait for ~718k
synchronous RPCs**. Cumulative: 44.3s (2B start) → 41.5s (2C) → **38.2s (2D)**,
**3.1x faster than strada (119s)**, parity intact at every step.

### Upstream recommendation (final form)

1. **Reduce request count by orders of magnitude via batch APIs** — the array
   overloads exist; making traversal-scale consumers (and the client library's
   internal lazy materialization) use them is where the remaining ~15s lives.
2. **Break round-trip seriality in the API itself**: async pipelining /
   request coalescing / server-push of predictable follow-ups, so a traversal
   is not 718k sequential waits.
3. Ship the 2C input-keyed checker cache and the 2D `writeToDisk` emit option
   (both parity-proven here, byte-identical outputs).

Raw measurement logs are archived off-repo and available on request.

## Phase 2E — request-count batching (closed): E1 kept, E2 reverted

Phase 2D left ~718k synchronous RPCs at ~12-21µs of fixed round-trip cost each as
the dominant remaining wall. Phase 2E attacked request count with batch APIs.

### E1 — batched symbol docs (KEEPER)

New additive endpoint `getSymbolDocumentations(symbols[])` (typescript-go branch
`draft/api-batch-docs-1784812262`): one checker/langSvc setup per batch, each
element exactly equal to the individual `getJsDocTags` + `getDocumentationComment`
results (order preserved; a symbol that would fail an individual call fails the
batch — no silent per-element drops). jsii prefetches per type's members, per
enum's members and per registration pass into the existing `(path:index)`-keyed
caches; call-site logic unchanged.

| metric (aws-cdk-lib, 3-run median) | 2D baseline | E1 | delta |
|---|---|---|---|
| RPC requests | 718,548 | **500,458** | **-218,090 (-30%)** |
| wall-clock | 38.4s | **35.5-36.6s** | ~-2.5s |
| transportOverheadMs | ~15.4s | ~12.7s | **-2.7s** |
| serverTimeMs / recv | ~15.3s / 604MB | ~15.2s / 608MB | ~0 |

All gates passed (emit byte-identity, `.jsii` 0-diff, 4 parity gates). The
reduction is linear in requests (~12µs/request of transport saved), confirming
the fixed-cost model with an updated coefficient.

### E2 — member/param type batching (REVERTED, twice measured, lesson kept)

A batched `getTypeOfSymbolAtLocations(pairs[])` endpoint (same branch) plus jsii
prefetching regressed twice and was reverted per the pre-agreed retreat rule:

1. **Attempt 1 — prefetch before filtering: 47-52s (vs 38.4s), worsening run over
   run.** Prefetching declared types for ALL members eagerly materialized masses
   of types the lazy path never touched (private/internal members dominate at
   aws-cdk-lib scale): new server compute + big TypeResponses + client-side
   materialization + memory pressure. **Batching must not cross a lazy-evaluation
   boundary**: fetching things laziness would have skipped converts an RPC saving
   into a net loss.
2. **Attempt 2 — filter-once → prefetch survivors only: 38.6s median (437k
   requests)** — correct semantics, fewer requests than E1, but no wall-clock win
   over E1 (36.6s): the surviving members' types were exactly the ones the visit
   path fetches anyway (now client-cached), so the only saving was round-trip
   fixed cost, offset by batch response materialization timing. Retreat condition
   applied mechanically; both commits reverted (parity was intact throughout).
3. **Small batches lose to fixed costs**: per-signature parameter batches
   (average ~2 elements) increased total requests.

### Upstream lessons (API design data points)

- Batch endpoints pay off when (a) elements are *certain* to be needed (post-
  filter), and (b) batches are large (hundreds+). Doc-style payloads (small,
  self-contained) batch perfectly; type-graph payloads (large responses, lazy
  materialization) can regress when batching front-runs laziness.
- The remaining floor on aws-cdk-lib after E1: ~500k requests ≈ 12.7s transport +
  15.2s server. Getting materially below ~35s requires either much coarser
  traversal endpoints (e.g. "give me everything about type X in one call") or
  async pipelining — both API-side designs, consistent with the 2D conclusion.

### Cumulative series result

119s (strada) → 41s (Phase 1) → 44.3→41.5s (2C) → 38.2s (2D) → **35.5s (2E-1)**
= **3.4x faster than strada**, parity gates intact at every step.

## Performance

On aws-cdk-lib the jsii (check + assemble) step dropped from **119s → 41s (2.9x)**
using the out-of-process TS7 API — consistent with the PoC projection that the
checker/emit work speeds up ~7.5–9x while the assembler walk becomes the new
bound. Batching checker calls and caching doc-comment lookups (Phase 2 perf pass)
should reduce the assemble walk further.

## Reproduction

```sh
# one-time: provision the patched tsgo + native-preview client (S3-cached)
scripts/ts7-setup.sh

# build jsii-compiler, then in a jsii package:
JSII_COMPILER_BACKEND=ts7 JSII_TS7_DIR=/path/to/jsii-compiler/.ts7 jsii
```
