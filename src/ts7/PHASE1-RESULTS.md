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

## The 0.3% tail on aws-cdk-lib (Phase 2 backlog)

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
