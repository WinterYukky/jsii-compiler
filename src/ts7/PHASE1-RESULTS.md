# TS7 backend — Phase 1 results & Phase 2 backlog

> Companion to `src/ts7/README.md` (architecture decision) and
> `poc/typescript7/PORT-ANALYSIS.md` (feasibility branch). Records the measured
> outcome of the Phase 1 spike and the concrete follow-up work.

## TL;DR

The experimental `JSII_COMPILER_BACKEND=ts7` backend generates `.jsii` assemblies
that are **100% type- and member-identical to strada on every gate, including
aws-cdk-lib (21,192 types / 102,570 members)** — see "Phase 2F" below — while
running the check+assemble step **~3.7x faster** than strada (~32s vs 119s).
Phase 1 measured 99.7% member parity; Phases 2A/2F closed the remaining tail
completely.

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

## Phase 2F — parity closure: aws-cdk-lib at 100%

Phase 2F eliminated the entire remaining tail. Final state (same gates,
compare-jsii.mjs):

| Gate | Types | Members | Field diffs | Member diffs | walltime (c7i.4xlarge) |
|---|---:|---:|---:|---:|---|
| `constructs` | 12/12 | 53/53 (100%) | 0 | 0 | — |
| `cloud-assembly-schema` | 59/59 | 213/213 (100%) | 0 | 0 | — |
| `aws-cdk-lib` | **21192/21192** | **102570/102570 (100%)** | **0** | **0** | **~32s vs strada 119s** |

The constructs emit gate was also tightened: identical emitted file set, every
`.d.ts` byte-identical to strada, and runtime-identical `Symbol.for("jsii.rtti")`
on all exported classes.

What it took (each item is a strada-semantics port, none a ts7 API limitation):

- **Inherited static members**: apply the same declaring-type / erased-base rule
  as the instance loop to the static loop; a base dropped by `--strip-deprecated`
  is NOT an erased base (DeprecatedRemover deletes the type without folding
  members into subclasses).
- **Enum members from union constituents**: strada derives enum members from
  `type.isUnion() ? type.types : [type]`, so aliased members (`COLD_HDD = SC1`)
  collapse into their canonical member. (The Phase 2B hypothesis that this was a
  strip-deprecated leak was wrong.)
- **Cross-submodule named re-exports**: strada emits a duplicate type entry for
  `export { X } from 'other-submodule'` (ExportSpecifier WITH a module
  specifier, visited in the current namespace); `import`-then-re-export aliases
  are silently dropped by its visitor, and ancestor-dir re-exports collapse into
  the canonical fqn. Reproducing this exactly fixed `aws_docdb.CaCertificate`
  without duplicating the ~3,400-type `interfaces.*` tree.
- **Member re-listing rule**: a member is re-listed only when its declaring
  declaration is the type itself or one of its erased bases; members arriving
  through a NAMED base's erased ancestors are not re-listed (fixed all 363
  EXTRA inherited struct props).
- **Parameter properties**: only listed for the EFFECTIVE constructor (own, or
  first along the erased-base chain).
- **Boxed stdlib wrapper types**: `Number`/`String`/`Boolean`/`Date` declared in
  `lib.*.d.ts` map to primitives (strada `_tryMakePrimitiveType`).
- **Promise-returning methods**: `async: true` + model the resolved type
  (`Promise<string>` -> `string`).
- **Parameter documentation** (the deferred DIFFER 138): exact port of TS5's
  services semantics, reading JSDoc from **source text** instead of the tsgo doc
  APIs: `@param` comes from the owning declaration's JSDoc only (methods never
  inherit param docs); an inline JSDoc on the parameter and a `@param` tag
  concatenate; a CONSTRUCTOR parameter with no own doc falls back
  (`findBaseOfDeclaration`) to a same-named PROPERTY on the first super type,
  recursively through empty-doc overrides. Plus an exact port of jsii's
  `splitSummary` (paragraph/first-sentence split where `;` counts as terminal
  punctuation, `- ` separators preserved, mid-line `@tag` terminates tag text).
- **Initializer docs**: parsed from the effective constructor's JSDoc block
  (`@default` etc.); strada quirk reproduced bug-for-bug: `protected` is only
  recorded on initializers that have at least one parameter.

### tsgo JSDoc behaviour gaps found (upstream PR candidates)

The parameter-doc work surfaced two tsgo checker doc-API behaviour differences
vs TS5, which the backend now works around by reading source text directly:

1. **Over-inheritance**: `getJsDocTags`/`getDocumentationComment` on a parameter
   of an overriding method returns the BASE signature's `@param` doc even when
   the override has its own (param-less) JSDoc. TS5 never inherits param docs
   for methods.
2. **Under-extraction**: some `@param`-derived docs (e.g. for parameter
   properties) and some property doc comments return empty where TS5 returns
   the documentation.

## Historical: remaining Phase 2B tail (aws-cdk-lib) — all resolved in Phase 2F

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

## Phase 3A — where the wall-clock goes on the official TypeScript 7.1 API (`typescript/sync`)

Goal: a complete, measured decomposition of the ts7 backend's wall-clock on the
**official** `typescript@7.1.0-beta` programmatic API (PR branch `feat/ts7-backend`
@ 786df41, no fork), so optimizations can be ranked by expected seconds rather than
by request counts.

**Setup.** c7i.4xlarge (16 vCPU Xeon 8488C, 30 GB), Ubuntu 24.04, Node 22.23, Go 1.27
(pprof reading only), `typescript@7.1.0-beta` + `@typescript/typescript-linux-x64`.
Input: the upstream benchmark fixture `fixtures/.tarballs/aws-cdk-lib.tgz` (the same
source snapshot `yarn projen test:benchmark` uses; L1s pre-generated, `npm ci`),
compiled with `--strip-deprecated --silence-warnings=reserved-word`, fresh copy of
the fixture and dropped page cache before every run, 3 runs per configuration.
This fixture is a slightly smaller snapshot than the real aws-cdk-lib used in the
earlier 53.8s measurement (698k vs 792k requests), so **absolute numbers below are
not comparable to earlier sections; only the classic-vs-ts7 ratio and the internal
breakdown are**. Measurement tooling lives in `perf/` on this research branch
(`rpc-hook.cjs` preload, `cpuprof-buckets.mjs`, `echo-bench.mjs`, `async-bench.mjs`,
`ts7-index-phase-marks.patch`); the PR branch is untouched. Raw logs, `rpc.json`
per run, V8 `.cpuprofile`s and Go `pprof` files are archived off-repo
(`perf/raw/ts7-perf-raw-20261023.tar.gz` in the team bucket).

Note on the classic baseline: on this fixture the classic backend exits 1 with
7×JSII3000 + 7×JSII3999 (`--strip-deprecated` erasing deprecated types that are
still referenced). It still performs the full type-check, assembler walk and
`program.emit()`; only the final `.jsii` write is skipped (~1s). The comparison is
therefore fair, if anything slightly favourable to classic.

### Baselines (wall-clock, seconds)

| configuration | run 1 | run 2 | run 3 | median |
|---|---|---|---|---|
| classic (`jsii` default backend) | 83.1 | 84.1 | 85.7 | **84.1** |
| ts7 default | 47.8 | 48.7 | 49.0 | **48.7 (1.73x)** |
| ts7 `JSII_TS7_SKIP_TYPECHECK=1` | 43.4 | 42.6 | — | 43.0 |
| ts7 `JSII_TS7_BATCH=1` | 61.4 | 68.1 | 68.2 | 68.1 |
| ts7 + memoized duplicate requests (3C below) | 50.4 | 50.2 | 48.9 | 50.2 |
| ts7 `GOGC=400` (server runtime) | 50.1 | 47.6 | — | — |
| ts7 `GOGC=off` / `GOMAXPROCS=4` / both | 49.6 / 50.9 / 47.7 | | | no effect |

The measurement preload itself costs < 1s (47.5s without it).

### The 48.7s, fully decomposed (ts7 default, phase marks + per-request hook)

| phase | wall | RPCs | notes |
|---|---|---|---|
| jsii startup before the ts7 backend | 1.2–1.9s | 0 | project-info, yargs, module loading |
| API spawn + `createSnapshot` | 0.9s | 2 | server 0.7s |
| type-check (`collectTsDiagnostics`) | **5.8s** | 4 | all of it is one `getGlobalDiagnostics` RPC (server 5.8s; `getSemanticDiagnostics` is 0.02s). Go runs the check on multiple threads: 10.7s CPU in 5.8s wall |
| **assembler walk** | **32–34s** | **698,290** | see below |
| `writeAssembly` (sort-json + sha256 + write) | 1.2s | 0 | Node only |
| `program.emit()` + rtti injection | 6.4–6.9s | 1 | server 5.6s, Node 0.8s |
| dispose/close | <0.1s | 2 | |

Where the **assembler walk's 33s** goes (V8 `--cpu-prof`, self time, default run):

| bucket | time | share |
|---|---|---|
| `readSync` on the pipe = waiting for the server to answer | **25.4s** (36.6s over the whole run, of which 11.4s are the typecheck/emit RPCs) | 77% |
| `writeSync` (request framing to the pipe) | 1.8s | 5% |
| `ts7/assembler.ts` logic | 1.8s | 5% |
| `client.js` (`apiRequest`: `JSON.stringify` params + `JSON.parse` result) | 1.5s | 5% |
| GC | 0.9s | 3% |
| AST decode / `RemoteNode` / handle materialization (`node.js`, `sync/api.js`) | 1.0s | 3% |
| msgpack framing (`syncChannel.js`), utf8 decode | 0.5s | 1% |

What the server does inside those 25.4s of waiting (Go `getServerTiming` totals, Go
`pprof` of the whole run, and sampled per-method server time):

- Total server processing time (inside `HandleRequest`, i.e. excluding JSON
  marshalling of the response and pipe I/O) = **18.1s for the whole run**, of which
  typecheck 5.8 + emit 5.6 + snapshot 0.7. **The assembler's 698k requests cost
  the Go checker only ≈ 6s.** Go pprof agrees: `Session.HandleRequest` 6.2s cum.
- Outside `HandleRequest`, per request: `MessagePackProtocol.readTuple` 1.8s +
  `writeTuple` 1.9s (incl. `json.Marshal` of the response) + `json.Unmarshal` of
  params 0.9s ≈ **4.6s of per-request framing on the Go side**.
- Go GC: `gcBgMarkWorker` 12.8s CPU (27% of Go CPU) but it runs on otherwise idle
  cores; `GOGC=400`/`GOGC=off` did not change the wall-clock (table above), so GC
  is **not** on the critical path.
- Go total CPU 47.6s over 45.5s wall = **the server is effectively single-threaded
  during the walk**; 15 of 16 cores are idle.
- `getCachedSourceFile`: 1,657 requests, **391 MB of the 618 MB received**, 1.85s
  RPC (Go `encoder.EncodeSourceFile` 1.2s). Callers: `NodeHandle.resolve()` from
  `_registerType` (1,354) and `_registerModuleExports` (285) — the first touch of
  each declaration's file materializes the whole file's AST on the client. This is
  the client's object model (whole-file binary AST), not avoidable from jsii; it
  costs ≈ 2s.

**The remaining ≈ 15s of the walk is pure synchronous round-trip latency.** The
echo microbenchmark (`perf/echo-bench.mjs`, same box) puts the floor of one
sync round trip at **15–17 µs for a 0–100 B payload** (9.9 µs for binary), with a
payload slope of ≈ 1.2 ms/MB (so the average 885 B response costs ≈ 1 µs of bytes).
698k × 16 µs ≈ **11s** is the irreducible cost of the current one-request-at-a-time
design at this request count, independent of payload size.

Per-method top 10 (default run; `rpc` = wall inside `requestBytesSync`, `srv` =
sampled server processing time extrapolated):

| method | calls | rpc | avg | srv (est.) | recv | notes |
|---|---|---|---|---|---|---|
| getGlobalDiagnostics | 1 | 5.84s | — | 5.8s | 2 B | the typecheck |
| emit | 1 | 5.6–6.1s | — | 5.6s | 0.3 MB | writeToDisk emit |
| getJsDocTags | 133,686 | 3.85s | 29 µs | 0.59s | 12 MB | server avg 4.4 µs |
| getTypeAtLocation | 125,317 | 3.27s | 26 µs | 0.31s | 20 MB | |
| getTypeOfSymbolAtLocation | 105,012 | 3.08s | 29 µs | 0.61s | 13 MB | |
| getDocumentationComment | 116,694 | 3.00s | 26 µs | 0.44s | 12 MB | |
| getCachedSourceFile | 1,657 | 1.85s | 1.1 ms | 0.95s | **391 MB** | whole-file AST |
| getAliasedSymbol | 7,301 | 1.49s | 204 µs | 0.44s | 4 MB | |
| getPropertiesOfType | 22,720 | 1.49s | 65 µs | 0.57s | 105 MB | |
| getExportsOfModule | 614 | 1.40s | 2.3 ms | 2.2s* | 8 MB | *first-touch module resolution |
| getTypeFromTypeNode | 47,147 | 1.13s | 24 µs | 0.09s | 6 MB | |

### 3B — the `JSII_TS7_BATCH=1` regression, dissected (hypothesis "big responses are slow to decode on the Node side": **rejected**)

Default vs batch, same box, V8 cpu-prof and per-method hook on both:

- Node-side **non-waiting** CPU is unchanged: 13.5s (default) vs 15.3s (batch);
  GC 0.9s vs 0.8s; `JSON.parse`/utf8 decode of the 33 MB of batch responses is
  ≈ 0.5s. The entire +14s is **more time waiting in `readSync`** (36.6s → 49.3s).
- The batch requests themselves are cheap (19,876 × 118 µs = 2.4s). What gets
  slow is **every other request**: getTypeAtLocation 26 → 60 µs, getTypeOfSymbolAtLocation
  29 → 75 µs, getTypeFromTypeNode 24 → 72 µs, getFullyQualifiedName 30 → 53 µs —
  a uniform ≈ 2x latency inflation on ~460k requests ≈ +13s.
- Go CPU inside `HandleRequest` rose only 6.2 → 7.8s (`json.Unmarshal` of the
  87 MB of batch params +0.8s, `handleBatchRequests` 1.2s); `getServerTiming`
  totals 18.1 → 20.2s. So ≈ 2s of the +14s is server compute; **≈ 11s is added
  latency per round trip that shows up as CPU on neither side.**
- Go GC is not it: `GOGC=400` with batch gave 70.9s (worse), and GOGC does nothing
  in default mode either.

Open question (not resolved in this phase, hypothesis only): something about
handling large messages on the Go side makes subsequent small round trips wake up
~30 µs slower (scheduler/`sysmon` hand-off after long blocking pipe writes, or
pipe-buffer effects). A `GODEBUG=schedtrace`/`perf sched` run on the server is the
next step if batching is to be rescued. Until then: **on 7.1, batching is a net
loss for this workload** and the default (no batch) is correct.

### 3C — input-keyed cache: real duplicates, small win (parity byte-identical)

Distinct request parameters per method (`JSII_PERF_DEDUP=1`):

| method | calls | distinct inputs | duplicates |
|---|---|---|---|
| getTypeAtLocation | 125,317 | 25,340 | **99,977 (80%)** |
| getTypeArguments | 9,602 | 2,338 | 7,264 (76%) |
| getPropertyOfType | 3,043 | 1,388 | 1,655 (54%) |
| getAliasedSymbol | 7,301 | 5,364 | 1,937 (27%) |
| getSymbolAtLocation | 11,249 | 8,963 | 2,286 (20%) |
| getJsDocTags / getDocumentationComment / getPropertiesOfType / getExportsOfSymbol / getTypeFromTypeNode | — | — | **0%** (the existing `(path:index)` doc cache works; the rest are already unique) |

Memoizing the raw response of those five methods by `(method, params)` in the
preload (valid: a snapshot's program is immutable) removed **113,119 requests
(−16%, 698k → 585k)** with a **byte-identical `.jsii`** — and moved wall-clock by
nothing measurable (50.2s median vs 48.7s; run-to-run spread is ±1.5s). Total
server processing time was unchanged (18.6s vs 18.1s): the duplicated answers were
already cached in the Go checker (server avg 2.5 µs for getTypeAtLocation), so the
only saving is the round-trip floor, ≈ 113k × 16 µs ≈ 1.8s — real, but inside the
noise of a single 3-run series. Consistent with Phase 2C (−98k requests → −2.2s).

### 3D — async API (`typescript/async`) pipelining, microbenchmark

`perf/async-bench.mjs`: 2,713 exported symbols from 220 fixture files, 5 dependent
checker calls per symbol (getTypeOfSymbol → getFullyQualifiedName → getJsDocTags →
getDocumentationComment → getPropertiesOfType), fresh server process per
configuration (no warm checker):

| client | in-flight symbols | wire requests | throughput |
|---|---|---|---|
| sync (`typescript/sync`) | 1 | 11,957 | **6,276 symbols/s** (36 µs/req) |
| async, sequential (`await` each) | 1 | 11,957 | 425 symbols/s (**15x slower** than sync: vscode-jsonrpc + event loop per request) |
| async, `Promise.all` chunks of 16 | 16 | 827 | 3,700 symbols/s |
| async, chunks of 64 | 64 | 211 | 7,923 symbols/s |
| async, chunks of 256 | 256 | 55 | **10,200 symbols/s (1.6x sync)** |
| async, chunks of 1024 | 1024 | 15 | 10,049 symbols/s |

The async client coalesces every request issued in the same macrotask into one
`batchRequests` message (so the per-request round trip is amortized), but the
server handles a batch sequentially in one goroutine — there is **no server-side
parallelism**, which is why it saturates at ≈ 1.6x. Interestingly these async
batches did **not** show the 3B latency inflation (nothing else was in flight to
be inflated), which is consistent with 3B being an interaction effect rather than
batch cost per se.

### Conclusions (measured → inferred)

1. **The Go checker is not the bottleneck** (≈ 6s of 33s walk) and neither is
   payload decoding on the Node side (≈ 2.5s). **≈ 60% of the walk is the
   per-request tax of a synchronous one-at-a-time RPC design**: ≈ 16 µs
   wake-up/syscall floor + ≈ 7 µs Go framing/JSON + ≈ 7 µs Node client overhead,
   × 698k requests ≈ 21s. This is inferred from the echo floor and the Go/Node
   profiles; the three components are each measured, their sum matches the walk
   within ≈ 2s.
2. The **floor** of this backend on this fixture, if the per-request tax went to
   zero, is ≈ 48.7 − 21 ≈ **27s** (typecheck 5.8 + emit 6.5 + Go walk compute 6 +
   source-file transfer 2 + Node assembler/write 4 + startup 2.5). That would be
   ≈ 3.1x over classic; the earlier "3.7x" (fork, no typecheck) is **not reachable
   on the official API by request-shaving alone** — the typecheck (5.8s) and emit
   (6.5s) are now first-class costs that the fork-era numbers excluded.
3. Request **count** reduction only pays when it does not cross a laziness
   boundary (2E) and does not trigger the 3B latency effect; both of jsii's
   cheap options (input-keyed cache; doc batching) are now measured at ≤ 2s and
   −14s respectively.

### Candidate optimizations, ranked by expected seconds on this fixture

| # | candidate | expected | cost | where | status |
|---|---|---|---|---|---|
| 1 | **Async client with wide fan-out (≥ 256 types in flight) for the assembler walk** — restructure `assemble()` so independent type visits (`_visitNode` per registered type; member visits inside a type) run as concurrent promise chains over `typescript/async`, after the registration pass | walk 33s → ≈ 20s (1.6x on the walk, from 3D), **≈ −13s** (48.7 → ≈ 36s, ≈ 2.3x) | **high**: every accessor in the 1,850-line assembler becomes `await`-able; must respect the 2E laziness lesson (do not prefetch what the visit would skip) | jsii only (API exists) | microbenchmark only; a chunked-async spike on `_visitMembers` for one submodule is the next experiment |
| 2 | **Server-side concurrency for batched requests** (goroutine-per-item inside `batchRequests`, or the async conn not coalescing) — the server has 15 idle cores during the walk | if the checker tolerates it: walk could approach the ≈ 6s Go compute + transfer, **−15…−20s** (toward ≈ 28s, ≈ 3x); if not, nothing | medium–high, **TypeScript side** (checker thread-safety is the question) | typescript-go | hypothesis; needs a Go-side experiment |
| 3 | **Fix the 3B latency inflation** (large messages making subsequent small round trips ≈ 2x slower) | unlocks E1-style doc batching: −218k requests ≈ **−3…−5s** instead of +14s; also a precondition for #1's larger batches to stay cheap | medium, **TypeScript side** (Go scheduler/pipe investigation) | typescript-go | open question with repro |
| 4 | **Input-keyed cache for getTypeAtLocation/getTypeArguments/getPropertyOfType/getAliasedSymbol/getSymbolAtLocation** (in jsii, or in the client's `Checker` as in 2C) | −113k requests, **≈ −1.8s** (in noise for one series) | low (a `Map` per method, keyed by handle ids; parity byte-identical here) | jsii or typescript client | measured |
| 5 | Lighter `getCachedSourceFile` (lazy/partial AST, or not materializing files whose declarations are only name-checked) | ≈ −1…−2s (391 MB, 1.85s) | medium, TypeScript side | typescript-go | sized, not tried |
| 6 | Skip `getGlobalDiagnostics` when the caller already ran `tsc` (e.g. `jsii --no-typecheck` opt-in, mirroring `JSII_TS7_SKIP_TYPECHECK`) | **−5.8s**, but changes semantics (type errors no longer fail the build) | trivial | jsii | measured; policy question, not an optimization |

Not worth pursuing (measured): `GOGC`/`GOMAXPROCS` tuning (no effect); shrinking
response payloads (bytes cost ≈ 1 µs per request at the observed sizes); Node-side
JSON/decoding work (≈ 2.5s total).

## Phase 3E — spike: pipelined assembler on `typescript/async` (closed, retreated)

Hypothesis from 3D: visiting independent types concurrently on the async client
(which coalesces same-tick requests into one `batchRequests`) could remove the
~13s of serialized round-trip wait. Branch `spike/async-fanout-1792738229`:
a mechanical `await` port of `assembler.ts` (`assembler-async.ts`, opt-in via
`JSII_TS7_ASYNC=1`), type-level fan-out (every registered type is visited
anyway, so no laziness boundary is crossed), per-visit stability in an
`AsyncLocalStorage`, in-flight doc promises coalesced in the existing caches.

Parity gate: `.jsii` identical to the sync backend (fingerprint aside) on
constructs and on the aws-cdk-lib fixture (20,221 types / 97,071 members), for
both iterations below.

| run (fixture, same c7i.4xlarge, 3-run median) | wall | wire requests | roundTrip | server | recv |
|---|---|---|---|---|---|
| ts7 sync (default) | **45.4s** | 698k | 36.4s | 19.1s | 618 MB |
| async v1: chunked `Promise.all`, width 256 | 74.5s | 69.5k | 57.9s | 23.5s | 796 MB |
| async v1, width 64 / 1024 | 94.5s / 68.0s | | | | |
| async v2: sliding window + registration prefetch | **59.6s** | 22.1k | 41.4s | 23.7s | 1,508 MB |
| async v2, width 64 / 1024 | 66.9s / 62.2s | | | | |

Batch-size histogram (preload `perf/async-batch-hook.cjs`, by phase):

- v1: 69,554 batches for 699,636 requests = **10.1 requests/batch**, 51,983
  (75%) of them single-request round-trips. At ~0.5 ms per async round-trip
  (vscode-jsonrpc; same figure as the 3D microbenchmark) that is ~35s, which
  matches the measured transport overhead (34.4s).
- v2: the visit phase batches well — 2,845 batches, **avg 229 requests/batch**,
  652k requests in 10.1s of round-trip time (the sync backend waits ~25s for the
  same traversal). The registration pass does not: 19,222 batches, 53k
  requests, avg 2.8, 18.8k singles, **23.4s**. The submodule recursion
  (`collect`, 614 modules) and the nested-exports walk in `_registerType` are
  order-dependent and stayed sequential; the prefetch only covered alias
  resolution and the docs/declaration reads.

Costs specific to the async client (measured): received bytes 618 MB → 1,508 MB
(batch responses are JSON-wrapped), server time +4.5s, Node-side CPU up
(materialization 6.3s, jsonrpc framing 2.7s, GC 2.2s) — roughly +8s of fixed
cost that a fully parallel traversal would still carry.

Decision: **retreated** per the pre-agreed rule (needed ≥3s faster than default;
got 14s slower). Extrapolation, not a measurement: parallelizing the registration
pass to the visit phase's density would put the async path at ~38–40s (−6s vs
default, ~2.1x classic), at a parity risk (canonical-first registration order)
and 0.5–1 day of work; it would not reach the 1.6x-of-sync (~28s) the
microbenchmark suggested because of the fixed costs above. Finding kept: the
async API's ~0.5 ms round-trip floor makes it 2.5x faster than sync where a
traversal batches densely (visit), and slower wherever it cannot (order-dependent
registration), so at jsii's traversal granularity it loses overall.

Raw logs archived off-repo (`ts7-spike-async-raw-20261023.tar.gz`).

## Phase 4 — where the TypeScript side could help (code reading + measurements)

Goal: before proposing anything upstream, find the *cause* of the three
remaining TypeScript-side suspects from Phase 3 and bring each to a fix
candidate with a measured or extrapolated saving. Code read:
microsoft/TypeScript main a91e938, `tsc/internal/{ipc,api,project,checker}`;
client `typescript@7.1.0-beta` `dist/api/syncChannel.js`. Measurements:
aws-cdk-lib fixture on the same c7i.4xlarge class as Phase 3; the "real
aws-cdk-lib" column is a ratio conversion (×1.13, 792k/698k requests), not a
measurement.

### 4A — "all round trips get ~2x slower after a big message" (Phase 3B)

What the code says: the sync connection handles each request inline on the
read loop (no goroutine per request); the batch handler is a sequential `for`
plus a sequential `json.Marshal` per element. Nothing in the request path
changes shape after a large message.

Decisive experiment — the thread-handoff hypothesis is **rejected**:

| fixture, same box | wall | server | transport |
|---|---|---|---|
| default | 46.1s / 48.6s | 19.6s | 15.1s |
| batch (chunk 1000) | 49.6s / 57.3s | 19.6s | 18.9s |
| batch + `GOMAXPROCS=1` | 119.5s / 113.0s | **46.2s** | 56.9s |
| batch + `GOMAXPROCS=2` | 69.6s | 28.6s | 28.4s |
| default + `GOMAXPROCS=1` | 110.5s | 45.5s | 50.4s |

Restricting the Go runtime to one P makes everything 2.4x slower: the request
loop is single-goroutine, but the background GC mark workers (27% of Go CPU in
the Phase 3 pprof) run on the other cores; with one P they serialize onto the
request path. `schedtrace`: 69 threads, 15 idle Ps, run queue 0 throughout.
Per-thread context switches / migrations do not differ between modes.

Echo time series (one big echo, then the latency of the following small echoes,
by distance k; 5 repetitions; median / p90):

| big message | k=1..10 | k=11..100 | k>100 |
|---|---|---|---|
| 0.3 MB | 13.1 / 18.7 µs | 8.3 / 16.8 | 8.1 / 9.2 (= floor) |
| 1 MB | 29.1 / 355 µs | 8.5 / 16.4 | floor |
| 10 MB | 30.4 / 380 µs | 11.6 / 16.6 | floor |
| 43 MB | 29.9 / 455 µs | 15.7 / 28.6 | floor |

The penalty is **transient** (≈1–2 ms in total per big message, gone after
~100 requests) and **direction-dependent**: a 0.89 MB *response* alone
(`getSourceFile`) costs 9.2 µs at k=1..10, i.e. nothing. That resolves the
Phase 3 contradiction (1,657 × 43 MB source-file *responses* in default mode
are harmless; the batch path sends large *requests*). Frequency sweep (300 KB
request every F small ones): F=30 → mean 14.7 µs (+70%), F=100 → 10.7,
F=400 → 9.2, F=2000 → 8.7. Threshold for a steady-state penalty: about one
large request per 100.

Quantitative check (candidate "bound the batch request size"): chunk 1000 →
100 / 50 symbols per batched docs request, 2 interleaved rounds:

| fixture | wall | transport |
|---|---|---|
| default | 47.8s / 47.7s | 17.7s |
| batch chunk 1000 | 65.6s / 61.4s | 31.9s / 28.0s |
| batch chunk 100 | 63.4s / 62.7s | 29.4s / 29.3s |
| batch chunk 50 | 61.1s / 60.5s | 28.4s / 27.1s |

`.jsii` identical. Smaller requests recover ~1–4s of the ~14–18s regression —
consistent with the echo-derived ~3s for the transient stall — and **leave
~10s unexplained**. What is known about the remainder: it is wait time outside
Go's `processingTime` and outside Node's CPU (Phase 3 cpu-prof), it is not Go
GC (`GOGC=off` unchanged, Phase 3), not scheduler handoff (above), and it
scales the per-request cost of *every* non-batch request (26 → 60 µs) rather
than the batch requests themselves. Its magnitude varies between sessions
(+4s to +20s on identical inputs). Next instrument, not run here: a Go
`runtime/trace` of the server during a batch run to see where the request
goroutine sits between `read` returning and `write` being issued.

### 4B — the synchronous round-trip floor

Static count per round trip (code): 4 syscalls (Node `writeSync`, Go `read`
into a 4 KB bufio, Go `write` + `Flush`, Node `readSync` into a 64 KB
read-ahead), ~8 Go allocations (method bytes, payload, `string(method)`,
`Message`, params via json/v2, `sync.OnceFunc` closure in
`getPersistentChecker`, the 17-field `TypeResponse`, the marshal buffer),
2 mutex + 1 channel + 1 RLock acquisitions, ~3 Node allocations
(`allocUnsafeSlow` + copy, `toString('utf-8')`, `JSON.parse`).
`binary.Read/Write` (reflection) only for payloads ≥ 256 B.

Measured (echo, 20k samples): **median 8.1 µs** for 100 B, 7.4 µs for 0 B,
p90 8.9 µs. The Phase 3 "16 µs" was a mean over a short warm-up window and is
superseded. `strace -c` on the server during a steady run: read 32.9k, write
34.1k, futex 869, nanosleep 9.1k (sysmon) per 5 s — matching the static count
(one read + one write per request); each read/write syscall ≈ 2 µs.

CPU placement (`taskset`, both processes): same CPU → **5.0 µs** (−38%), SMT
siblings → 7.5 µs, two physical cores → 8.7 µs, unpinned → 8.1 µs. The
cross-CPU wake-up accounts for ~3 µs of the floor.

So, reconciled with the static estimate: floor 8 µs ≈ 4 syscalls (~2–3 µs) +
two cross-CPU wake-ups (~3–4 µs) + framing; the static guess of "14 µs of
wake-up" was too high. The real API's 26 µs/request leaves **~18 µs of per-
request CPU work** (Go dispatch/handle/marshal + Node decode), which is where
the Go allocations and GC pressure (27% of server CPU) live — not in the pipe.

### 4C — server-side parallelism for `batchRequests`

Constraint, confirmed in code and now treated as fixed: the API session uses a
single persistent checker (`project/checkerpool.go`: "A single checker for API
operations, providing stable instance identity for reference equality on
type/symbol handles"); `checker.newType` assigns `t.id = TypeId(c.TypeCount)`
from a per-checker, non-atomic counter, and the checker carries 45 cache maps
behind the pool's mutex. Read-style API calls still instantiate types lazily,
so (a) concurrent use of one checker races the id counter and the caches, and
(b) a second checker gives the same type a different id. jsii's
`typeFqnBySymbolId` and doc caches depend on those ids being stable. Any
parallelism must therefore keep **one checker, one goroutine** for checker
work.

### Candidates (ranked; savings on the fixture, real aws-cdk-lib by ×1.13 ratio)

1. **Coarse-grained endpoints (TypeScript side, the main proposal).** Replace
   the per-member round trips with a few per-type calls (table below). Keeps
   one checker; the handler just does more work per request. Expected: 698k →
   ~60–80k requests, **−9 to −12s** on the fixture (−10 to −14s real), i.e.
   most of the ~13s round-trip tax. Medium change on both sides.
2. **Per-request allocation / GC reduction in the Go server** (TypeResponse
   object per call, json/v2 marshal buffers, `make([]byte, size)` per message,
   `sync.OnceFunc` per checker acquisition). GC is 27% of server CPU (~5s);
   with `GOMAXPROCS=1` it becomes 25s of serialized work. Expected −2 to −4s
   (−2.5 to −4.5s real). Safe for id identity. Medium effort.
3. **Explain the remaining ~10s of the batch regression** (4A) before any
   further batching work; the 1-in-100 request-size threshold is a usable rule
   today (jsii: chunk ≤ 50–100 only recovers 1–4s, not enough on its own).
4. **CPU affinity from the server** (`sched_setaffinity` to the parent's CPU):
   floor −3 µs × 698k ≈ **−2s**, one-liner, but fragile (the Node process
   migrates) — a possible default for the sync API server, not a jsii concern.
5. Hand-written length headers / payload buffer reuse: ≈ −1 µs per round trip,
   ≈ −0.7s. Low priority.
Not worth pursuing (measured): `GOMAXPROCS` limits, `LockOSThread`-style
pinning of the request goroutine, response-payload reduction, Node-side JSON.

### Coarse-endpoint mapping (what each jsii traversal would collapse into)

Per-type request counts are from the Phase 3 per-method table (fixture:
20,221 types, 97k members, 698k requests). "Today" counts the sync RPCs the
traversal issues; "proposed" is one request unless noted. All proposals return
handles produced by the single API checker, so ids stay identical.

| jsii traversal | today (RPCs) | proposed endpoint | saving |
|---|---|---|---|
| per member: `getJsDocTags` + `getDocumentationComment` (after jsii's own cache) | 134k + 117k | `getSymbolDocumentations(symbols[])` per type (= Phase 2E E1, which was a win on the fork; the 7.1 `batchRequests` equivalent regresses, see 4A) | ~250k → ~20k |
| per member: `getTypeOfSymbolAtLocation(member, decl)` + `getTypeAtLocation(owner)` for the declaring type | 105k + 125k | `getMembersOfType(type)`: properties with declaring-type symbol id, declared type, first declaration handle, flags | ~230k → ~20k |
| per type: `getTypeAtLocation(decl)`, `getPropertiesOfType`, `getTypeOfSymbol(static side)`, `getPropertiesOfType(static)`, `getBaseTypes`, `getFullyQualifiedName` | ~6 × 20k = 120k | `describeType(decl)` returning the above in one response | 120k → 20k |
| per method: `getSignatureFromDeclaration` + `getReturnTypeOfSignature` + parameters' `getTypeOfSymbolAtLocation` + `getTypeArguments` (Promise unwrap) | 14k + 12k + ~30k + 10k | `getSignatureDetails(decl)`: return type, parameter types, resolved Promise argument | ~66k → 14k |
| per type reference: `getTypeFromTypeNode` on union constituents, `getIndexInfosOfType`, `getTypeArguments` on arrays | 47k + 0.5k + ~10k | fold into the type responses above (`elementType` / `indexValueType` / `unionConstituents` fields on `TypeResponse`) | ~57k → ~0 |
| registration pass: `getExportsOfModule` recursion, `getAliasedSymbol`, `resolve()` of each type declaration (the 391 MB of source files) | 0.6k + 7k + 1.7k | `getExportedTypes(module)` recursive, alias-resolved, with declaration kind/path — avoids fetching whole source files just to read the declaration | ~9k → ~0.6k and −390 MB |

Total: ~698k → roughly 60–80k requests. The round-trip tax (Phase 3: ~13s) and
most of the 391 MB source-file transfer would go; the ~18 µs of per-request CPU
work does not disappear but is amortized (one handler, one marshal per type
instead of per member). The risk is in laziness (Phase 2E): `getMembersOfType`
must return declared types only for members the caller will use, so the
endpoint should take the filtered member list, not materialize every member.

Raw logs archived off-repo (`ts7-stepb-raw-20261023.tar.gz`,
`ts7-batchchunk-raw-20261023.tar.gz`).

## Phase 5A — the unexplained ~10s of the batch regression: CPU deep idle (C6) exit latency (closed, root cause found)

Setup: TypeScript fork branch `perf/api-runtime-trace-1792804258` (upstream main
8d9b6da + 30 lines: `TSGO_API_TRACE` records a Go execution trace with
`ipc.read` / `ipc.handle` / `ipc.write` regions on the sync connection). Both the
default and the batched (`JSII_TS7_BATCH=1`) jsii runs use this one fork build
(stock 7.1.0-beta default: 45.6s, fork default: 44.4s — same within noise).
aws-cdk-lib fixture, c7i.4xlarge, 16 vCPU.

Where the server goroutine spends its time (trace, region x goroutine state):

| region | default | batch | delta |
|---|---|---|---|
| `ipc.read` (blocked in `read`, waiting for the client's next request) | 24.3s | **27.9s** | **+3.6s** |
| `ipc.handle` (handler; 12s of it is waiting on the parallel checker/emit goroutines) | 18.5s | 18.9s | +0.4s |
| `ipc.write` | 3.5s | 3.2s | -0.3s |

The regression lives entirely in the client turnaround, and it is a tail, not a
shift: `ipc.read` p50 19 → 21 us, **p90 31 → 82 us, with a ~200 us plateau** on
the type-materialising methods (`getTypeOfSymbolAtLocation` p90 33 → 193 us,
`getTypeFromTypeNode` 24 → 204 us, `getPropertiesOfType` 128 → 202 us). Node's
non-wait CPU is identical (14.5s vs 14.6s, cpu-prof), V8 GC is identical
(258 vs 265 scavenges, 745 vs 726 ms of pauses; `--max-semi-space-size=64`
changes nothing), Go GC cycles are identical (17 vs 17, STW 7 ms). So the extra
time is spent with *both* processes off-CPU: it is wake-up latency.

The quantum is the CPU's deep idle state. On this instance `intel_idle` exposes
C6 with a **190 us exit latency** (`/sys/devices/system/cpu/cpu0/cpuidle/state3`).
C6 entries during the run: default 267k, batch **409k**. Batch mode makes the
gaps between consecutive requests longer (a 1000-symbol batch takes the server
26–330 us and the client ~1 ms to parse), long enough for the menu governor to
park the waiting CPU in C6 instead of C1E (2 us); each wake-up then costs ~190 us.
This explains every earlier observation: the uniform ~200 us tail, the
run-to-run variance (+4s to +20s: governor prediction history), the direction
dependence (large *requests* lengthen the server's handling, i.e. the client's
wait), the 1-in-100 frequency threshold, and why GOMAXPROCS / LockOSThread /
GOGC / Node GC experiments all changed nothing.

Decisive test — C6 disabled at runtime (`echo 1 > .../cpuidle/state3/disable`
on all CPUs), same build, same box, 2 runs each:

| run | C6 enabled | **C6 disabled** |
|---|---|---|
| ts7 default | 44.4 / 44.6s (transport 16.6s) | **40.9 / 41.1s** (transport 13.2s) |
| ts7 batch (docs, 1000/chunk) | 49.2 / 49.5s (transport 19.4s) | **38.6 / 38.1s** (transport 9.9s) |

With C6 off the "regression" inverts: batching is **2.7s faster than default**,
i.e. the request-count saving (698k → 486k) finally shows up in wall-clock. The
Phase 2E / 3B conclusion "batching is slower on the official API" was a C-state
artifact, not a property of the API. Real aws-cdk-lib (×1.13 ratio from the
fixture, not measured): default ≈ -4s, batch ≈ -12s.

Fix candidates (ranked), all compatible with the single API checker:

1. **Spin-poll before blocking in the sync channel, both sides** (TS: Node
   `syncChannel` + Go `conn_sync`): poll the pipe non-blocking for up to ~100 us
   before parking. Keeps the waiting CPU in C1E; costs one otherwise-idle core.
   Expected: the "C6 disabled" numbers above (fixture default -3.6s, batch -11s)
   without touching the host. Small change; measurable with the fork build.
2. **Build-host configuration** (operational, no code): `intel_idle.max_cstate=1`
   or `cpu_dma_latency` on CI runners. Same gain, zero code, but outside jsii's
   control.
3. Re-enable E1-style docs batching in jsii once (1) or (2) is in place: it is a
   -2.7s win, not a loss.

Raw logs archived off-repo (`ts7-trace-raw-20261024.tar.gz`,
`ts7-trace-cstate-raw-20261024.tar.gz`); the trace summariser is
`perf/tracereg` on the spike branch.

## Phase 5B — spike: spin-poll before blocking reads on the sync channel (closed, success)

Fix candidate 1 from Phase 5A, implemented on the TypeScript fork branch
`perf/api-sync-spin-1792807669` (on top of the trace branch, +~90 lines):
`TSGO_SYNC_SPIN_US=<us>` (default off) makes both ends of the sync channel poll
the pipe for up to that budget before parking — Go side wraps stdin in a
`poll(2)`-with-zero-timeout loop (`ipc.NewSpinReadCloser`, unix only), Node side
switches the read fd to non-blocking and retries `readSync` on EAGAIN until the
deadline, then takes one blocking read. No protocol change, no checker change.

Same fork build, same c7i.4xlarge, aws-cdk-lib fixture, 2 runs per cell:

| cell | ts7 default | ts7 batch (docs) | transport default / batch |
|---|---|---|---|
| C6 on, spin 0 (today's status quo) | 41.8 / 41.0s | 48.2 / 46.5s | 14.9s / 20.2s |
| C6 on, **spin 100us** | **34.8 / 34.6s** | **34.6 / 34.9s** | 8.6s / 7.9s |
| C6 off, spin 0 | 38.2 / 38.3s | 35.5 / 35.4s | 12.7s / 9.6s |
| C6 off, spin 100us | **32.0 / 32.4s** | **31.5 / 31.5s** | 7.3s / 5.9s |

- Spin-poll alone (C6 on) beats disabling C6 outright: -7s on default, -12s on
  batch; the batch-mode regression disappears (batch == default within noise).
  So the spin is doing more than keeping the core out of C6: it also removes the
  futex/pipe wake-up (two `read`-blocked context switches per round trip) when
  the reply arrives within the budget, which is the common case (~20 us).
- No double-fix penalty: with C6 already off, spin still gives another -6s, and
  nothing regresses.
- `.jsii` identical across cells (parity gate).
- CPU cost, measured 25s into the run via `/proc/<pid>/stat`: node 6.3 → 11.9s,
  tsgo 21.2 → 25.4s (default). About +0.2 core per process, i.e. roughly 0.4
  of one otherwise idle core — not a full core, because each side only spins
  while the other is working.
- Echo microbenchmark: the small-echo floor rises 7.8 → 9.0 us (the extra
  `poll` syscall), but the 1-big-every-30 penalty disappears (p90 17.4 → 10.5 us).
  The spin trades ~1 us per round trip for immunity to the idle-state tail.

C-state exposure survey (Ubuntu 24.04, kernel 7.0.0-1014-aws, `cpuidle` sysfs),
one line each, to scope the environment dependence:

| instance | driver | deepest state exposed |
|---|---|---|
| c7i / m7i (Sapphire Rapids) | intel_idle | **C6, 190 us exit latency** |
| m8i (Granite Rapids) | intel_idle | C6 170 us, **C6P 210 us** |
| c5, c6i, c6a, c7g | none | no idle driver: the guest has no deep idle states (HLT only) |

So the tail only exists on 7th/8th-generation Intel Nitro instances (and
presumably bare metal); on older Intel, AMD and Graviton instances the status
quo already behaves like "C6 off". The build host of a CDK release is unknown,
hence the environment dependence must be stated with any number quoted from
c7i. With spin-poll on, the host no longer matters (no deep idle entry during
the compile, and the pipe wake-up is skipped on every host).

Cumulative on the fork build (fixture): classic ≈ 84s → ts7 sync 41s (2.0x) →
ts7 + spin 34.7s (2.4x) → ts7 + spin + docs batching 34.7s (no further gain:
with the wake-up gone, the 212k saved round trips are worth only ~0.1s). Real
aws-cdk-lib, by fixture ratio (not measured): 53.8s → ≈ 44s with spin.

Open questions for a TypeScript-side change (not resolved here): the right
default budget (100 us was the only value tested at scale; 20 us gave the same
floor in the microbenchmark), whether to enable by default or opt in, a Windows
equivalent (named pipes have no `poll`), and whether the Node side should use a
tighter mechanism than EAGAIN retries (e.g. a native `poll`). Branch kept for
the eventual upstream proposal; no PR/issue filed.

Raw logs archived off-repo (`ts7-spin-raw-20261024.tar.gz`, `cstate/*.txt`).

## Phase 5C — coarse-grained checker endpoints (closed, gate passed)

Fix candidate 1 of Phase 4, limited to the two endpoints with the largest
round-trip savings. TypeScript fork branch `api/coarse-endpoints-1792810368`
(on top of the spin-poll branch; Go handlers + proto + generated sync/async
clients + 3 Go tests; the api test package passes):

- `getSymbolDocumentations(symbols[])` — JSDoc tags and documentation comment
  of many symbols in one round trip, element-wise equal to `getJsDocTags` /
  `getDocumentationComment`.
- `getMembersOfType(type, filter)` — the properties of a type that pass the
  filter, each with its documentation, the symbol of its declaring type and
  (optionally) its declared type. The filter (`excludeInternal`,
  `excludePrivate`, `excludeDeprecated`, `excludeNames`, `ownerSymbols`,
  `parameterPropertyOwner`, `includeDeclaredType`) describes exactly the members
  jsii's `_visitMembers` keeps, so nothing a lazy traversal would skip is
  materialized (the Phase 2E lesson). Both run on the single API checker and
  return the same symbol/type handles as the fine-grained methods, so id
  identity (`typeFqnBySymbolId`) is untouched.

jsii side (spike branch `spike/async-fanout-1792738229`, `dbba419`):
feature-detected use of both endpoints in `_prefetchDocs` and `_visitMembers`;
`JSII_TS7_COARSE=0` forces the fine-grained path for A/B runs.

### Parity

- constructs: identical. aws-cdk-lib fixture (20,221 types / 97,071 members):
  identical **after one fix** — the first run leaked four ECMAScript private
  fields of `aws_cloudwatch.Metric` (`#accountOverride`, ...): the server tested
  "internal name starts with `_`" on the checker's internal name (`\xFE#4@#x`)
  while the client tests the wire name (`__#4@#x`). The 0-diff gate caught the
  divergence exactly as intended; the server now matches on
  `ast.EscapeSymbolName` (regression test added, `5a21924`).
- Real aws-cdk-lib (aws-cdk main, 22,706 types): identical. The
  `cloud-assembly-schema` package no longer lives in the aws-cdk monorepo
  (consumed from npm), so its parity gate is the Phase 2F result, not re-run.

### Numbers (same fork build, c7i.4xlarge, spin-poll on unless stated)

aws-cdk-lib fixture, 3 runs each:

| | fine-grained | coarse | delta |
|---|---|---|---|
| C6 on | 35.0 / 34.3 / 34.5 → **34.5s** | 29.4 / 29.9 / 29.2 → **29.4s** | **-5.1s** |
| C6 off (2 runs) | 32.4 / 32.0 | 26.9 / 26.9 | -5.3s |
| C6 off, spin off | 37.9 | 29.4 | -8.5s |
| requests / transport / sent | 698k / 8.6s / 131 MB | **304k / 5.4s / 52 MB** | -56% / -3.2s / -60% |

Real aws-cdk-lib (lerna-built aws-cdk main, in place, `--strip-deprecated`,
C6 on, 2 runs each; classic 120.8s on the same box):

| | fine-grained | coarse | delta |
|---|---|---|---|
| spin on | 43.2 / 43.1s | **37.8 / 38.2s** | -5.2s |
| spin off (stock-like) | 51.4s | 42.6s | -8.8s |
| requests / transport / sent | 783k / 10.2s / 168 MB | 340k / 6.8s / 65 MB | -57% / -3.4s / -61% |

The pre-fixed gate (coarse at least 5s faster than fine on the fixture) passes
at -5.1s; it is a narrow pass because the spin-poll had already removed most of
the per-round-trip wait the endpoints were designed to save (Phase 4 estimated
-9 to -12s against a 13s round-trip tax; with spin that tax is ~8s).

Not done, by decision: the third endpoint of the plan (type-argument / union /
index-signature data folded into `TypeResponse`) would remove ~70k of the
remaining 304k requests, worth ≈1.3s at the measured 18 us per request — noise
level. What is left on the fixture after coarse: `getTypeFromTypeNode` 47k,
`getTypeAtLocation` 46k (owner/heritage types), `getMembersOfType` 22.7k,
`getTypeOfSymbolAtLocation` 22k (parameters), `getFullyQualifiedName` 20k,
`getExportsOfSymbol` 20k; the next foldable group is the per-signature trio
(`getSignatureFromDeclaration` + `getParametersOfSignature` + parameter types,
≈50k) into one `describeSignature`, again ≈1s.

### Cumulative (what each step is worth, both baselines)

| step | fixture (c7i.4xlarge) | real aws-cdk-lib |
|---|---|---|
| classic jsii | 84.1s | 125.2s (Phase 1) / 120.8s (today) |
| ts7 sync, stock 7.1.0-beta, C6 on | 48.7s (1.73x) | 53.8s (2.3x) |
| ts7 sync on the fork build, spin off | 41–44s | 51.4s |
| + spin-poll (`TSGO_SYNC_SPIN_US=100`) | 34.5s (2.4x) | 43.1s (2.8x) |
| + coarse endpoints | **29.4s (2.9x)** | **38.0s (3.2x)** |

Of the 29.4s left on the fixture: emit 5.4s, typecheck 5.3s (both single Go
calls), source-file transfer 1.6s, ≈5s of round trips, ≈9s of Node-side
assembler/decode/write work, the rest startup.

### Proposal package for microsoft/TypeScript (not filed; for the maintainers' decision)

1. Spin-poll before blocking reads on both ends of the sync channel
   (`perf/api-sync-spin-1792807669`): -7s fixture / -8s real on a 7th-gen Intel
   host, no protocol change, ≈0.4 core while active; open points: default budget
   (100 us tested, 20 us equivalent in the microbenchmark), opt-in vs default,
   Windows path.
2. `getSymbolDocumentations` + `getMembersOfType`
   (`api/coarse-endpoints-1792810368`): -5s on both baselines, -56% requests,
   -60% bytes sent; checker identity preserved; tests included.

Raw logs archived off-repo (`ts7-coarse-raw-20261024.tar.gz`,
`ts7-cdklib-coarse-raw-20261024.tar.gz`).

### Phase 5C addendum — `getMembersOfType` filter generalised into neutral predicates

The first filter (Phase 5C) baked jsii's member policy into switches
(`excludeInternal`, `excludeDeprecated`, `excludePrivate`, `excludeNames`,
`ownerSymbols`, `parameterPropertyOwner`): unusable by other tools and, as the
ECMAScript-private-field leak showed, a server/client judgement mismatch waiting
to happen. Branch `api/coarse-endpoints-generic-filter-1792824451` replaces it
with predicates the caller combines like a WHERE clause; the response shape is
unchanged.

| old switch (jsii-specific) | new predicate | other uses |
|---|---|---|
| `excludeInternal` (@internal or `_` prefix) | `excludeJsDocTags: ["internal"]` + `excludeNamePattern: "^_"` | TypeDoc `["hidden"]`, API extractor `["alpha","beta"]` |
| `excludeDeprecated` | `excludeJsDocTags: [..., "deprecated"]` | any "current API only" view |
| `excludePrivate` | `visibility: ["public","protected"]` (ECMAScript `#x` counts as private) | public-surface docs: `["public"]` |
| `excludeNames: ["prototype"]` | `excludeNamePattern: "^(_\|prototype$)"` | any naming convention (RE2) |
| `ownerSymbols` | `includeInheritedFrom: { declaringTypes: [...] }` (`{}` = own only, omitted = all) | flattened vs. per-type member listings |
| `parameterPropertyOwner` (effective-ctor rule) | removed — jsii re-judges on the client from the member's `owner` reference | — |
| — | `kinds: ["property"\|"accessor"\|"method"\|"parameterProperty"]` | method-only / data-only views |

jsii's whole policy becomes `{ visibility: ['public','protected'],
excludeJsDocTags: ['internal' (+ 'deprecated' when stripping without an
allow-list)], excludeNamePattern: '^_' (static side `'^(_|prototype$)'`),
includeInheritedFrom: { declaringTypes: erasedBases }, includeDeclaredType: true }`
(jsii spike 7a8221f). Two client-side judgements stay in jsii by design:
allow-listed deprecation stripping (per-fqn) and the effective-constructor rule
for parameter properties (over-return, then filter — cheaper than a parity bug).

Verification on the fork build (c7i.xlarge, 4 vCPU, spin on, C6 on): fixture
`.jsii` identical to the fine-grained path (20,221 types); constructs identical.
Wall 2 runs: fine 42.8 / 43.8s, coarse (generic filter) **37.3 / 37.2s**
(−5.7s), requests 698k → 304k, sent 131 → 46 MB — the same gain as the
jsii-specific filter (Phase 5C: −5.1s on the 16 vCPU box), so the
generalisation costs nothing measurable. Go tests: 3 (predicate combination,
inherited-from + kinds + invalid pattern, docs equivalence); `go test
./internal/api/` passes.

## Phase 5D — spin-poll on small hosts and quiet workloads (closed)

Question before proposing the spin-poll upstream: does it hurt when the two
processes compete for cores, or when requests are sparse? Same fork build
(generic-filter branch, which includes the adaptive variant), fixture, spin
budget 100 us, C6 on.

**Cores.** c7i.xlarge (4 vCPU) and the same box with both processes pinned to
2 CPUs (`taskset -c 0,1`; c7i.large itself cannot run the fixture — 3.8 GB RAM,
OOM-killed on every run). CPU seconds are per process at end of run.

| box | mode | coarse wall (2 runs) | node / tsgo CPU s | fine wall |
|---|---|---|---|---|
| 4 vCPU | spin off | 39.1 / 38.6 | 14.3 / 56.0 | — |
| 4 vCPU | spin 100 | **37.3 / 37.2** | 18.0 / 57.7 | 42.8 / 43.8 |
| 4 vCPU | adaptive | 37.5 / 37.3 | 18.0 / 57.6 | — |
| 2 CPUs (pinned) | spin off | 41.9 / 41.4 | 12.7 / 40.6 | 50.0 |
| 2 CPUs (pinned) | spin 100 | **40.8 / 40.9** | 16.2 / 45.0 | 47.0 |
| 2 CPUs (pinned) | adaptive | 41.2 / 40.5 | 16.6 / 45.1 | — |

Spin never loses: −1.9s on 4 vCPU, −1.0s (coarse) / −3.0s (fine) with only
two CPUs for both processes. The gain shrinks as cores shrink because the Go
server's background work (GC, parallel checker/emit) already keeps the second
core busy, so there is less idle to wake up from — but the extra CPU
(+4s node, +2–4s tsgo) is paid back in wall-clock even there.

**Quiet workloads** (echo bench, 4 vCPU; node / tsgo CPU seconds):

| workload | spin off | spin 100 | adaptive |
|---|---|---|---|
| 20k back-to-back echoes | 0.17s wall, 0.12 / 0.08 | 0.21s, 0.23 / 0.21 | 0.21s, 0.23 / 0.20 |
| client idle 10 ms between 300 requests | 3.08s, 0.02 / 0.02 | 3.13s, **0.05 / 0.09** | 3.13s, 0.06 / 0.04 |
| ~ms of server work per request ×100 | 0.07s, 0.00 / 0.26 | 0.12s, 0.01 / 0.39 | 0.04s, 0.01 / 0.04 |
| 50 fast then 1 slow ×40 | 0.03s, 0.03 / 0.03 | 0.14s, 0.07 / 0.46 | 0.05s, 0.04 / 0.04 |

The only measurable cost of always-on spin is on sparse traffic: one wasted
100 us budget per message (≈ +0.1 ms CPU per request, here +0.1s over 3s of
mostly idle time), and on mixed traffic the server spins its budget after each
slow reply. The adaptive variant (suspend after 3 consecutive waits > 1 ms,
resume after 3 waits < 1 ms; `TSGO_SYNC_SPIN_ADAPTIVE=1`) removes that cost
(0.04 vs 0.46 tsgo CPU s on the mixed workload) while keeping the dense-traffic
gain within noise of always-on (37.5 vs 37.3s). Note the first adaptive cut used
the spin budget itself as the "peer is idle" criterion and was useless on hosts
with deep idle states (a blocked read returns after ~200 us even when the peer
answered immediately); the 1 ms threshold fixed that.

**Recommendation for the upstream proposal:** adaptive spin, enabled by default
on Unix, budget 100 us, with `TSGO_SYNC_SPIN_US=0` as the off switch. No case
measured here gets slower; the worst case (sparse traffic) costs ~0.1 ms CPU per
message before adaptation kicks in. Windows is **unverified** (named pipes have
no `poll`; the current code is a no-op there). Not measured: hosts with fewer
than 2 physical cores available to the pair, and containers with CPU quotas
(cgroup throttling could turn spin time into throttled time — worth one run
before the PR).

Raw logs archived off-repo (`ts7-5d-4vcpu-raw-20261024.tar.gz`,
`ts7-5d-pin2cpu-raw-20261024.tar.gz`, `ts7-5d-2vcpu-raw-20261024.tar.gz` — the
last one is the OOM evidence only).

## Phase 5E — spin-poll on Graviton (no deep idle state exposed)

Question: on a host without a C6-class idle state, does the spin-poll still
help (by skipping the pipe wake-up), or is it pure overhead? c7g.4xlarge
(16 vCPU Graviton3, Ubuntu 24.04 arm64), fork branch
`api/coarse-endpoints-generic-filter-1792824451` built from source on the box,
aws-cdk-lib fixture, two runs per cell, `.jsii` identical across cells.
`cpuidle` sysfs: no idle driver at all (`current_driver=none`), i.e. the
guest has no deep idle state to enter.

| path | spin off | spin 100 µs | adaptive | CPU-s node / tsgo (off → spin) |
|---|---|---|---|---|
| fine-grained | 60.5 / 60.7 s | **55.2 / 55.3 s** | 55.6 / 56.8 s | 34 / 60 → 37 / 78 |
| coarse endpoints | 46.1 s | **44.7 s** | — | 22 / 56 → 26 / 66 |

Transport overhead (fine): 16.9 s → 14.6 s. Echo floor (median, 100 B):
17.1 µs without spin, 18.5 µs with spin (Graviton's floor is about 2x the x86
floor of 8 µs either way).

Reading: without a deep idle state the gain is smaller than on c7i (-5.3 s vs
-7 s on the fine path, -1.4 s vs -5 s on the coarse path) but still present
and never inverted; what remains is the pipe wake-up (two context switches per
round trip) that the spin skips when the reply arrives within the budget. The
CPU cost is higher here than on x86 (tsgo +18 CPU-s over a 55 s run, about
+0.3 core) because the Go side's poll loop is more expensive per iteration on
this platform; the adaptive variant costs the same as the fixed budget on this
dense workload, as expected. Graviton is also simply slower for this workload
(fine 60.5 s vs 41.8 s on c7i).

Raw logs archived off-repo (`ts7-5e-graviton-raw-20261027.tar.gz`).

### Phase 5D addendum — fine-grained traversal on 4 vCPU and 2 CPUs

The 4 vCPU / 2 CPU cells above used the coarse-endpoint traversal; re-measured
with the fine-grained (default) traversal so the rows are comparable with the
c7i.4xlarge benchmark row. c7i.xlarge, same fork build, two runs per cell,
`.jsii` identical across cells, CPU seconds node / tsgo:

| host | spin off | spin 100 µs | adaptive |
|---|---|---|---|
| 4 vCPU | 49.0 / 48.5 s (20 / 60) | **44.3 / 45.0 s** (25 / 69) | 44.1 / 45.1 s (26 / 67) |
| 2 CPUs (`taskset -c 0,1`) | 51.1 / 51.9 s (18 / 45) | **48.6 / 48.9 s** (24 / 53) | 48.5 / 48.8 s (24 / 53) |

Gain -4.2 s on 4 vCPU and -2.8 s on 2 CPUs (vs -7 s on 16 vCPU), never
inverted; adaptive equals the fixed budget on this dense workload. Raw logs
archived off-repo (`ts7-5d-fine-4vcpu-2cpu-raw-20261027.tar.gz`).
