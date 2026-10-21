# Draft PR body — aws/jsii-compiler: experimental TypeScript 7 backend

> Paste-ready body for the draft PR from `WinterYukky/jsii-compiler:feat/ts7-backend` to `aws/jsii-compiler:main`.
> Suggested title: `feat: experimental TypeScript 7 compiler backend (typescript/sync API)`
> Mark as **Draft**. Paragraphs are single lines for clean GitHub rendering.

---

## Summary

This PR adds an opt-in, experimental compiler backend that runs jsii's type analysis and emit on TypeScript 7 (the native Go compiler) through the `typescript/sync` programmatic API that ships in the `typescript` package since 7.1. It is the draft follow-up to the investigation discussed in issue 1853 (see my comment there for the full measurement series).

On `aws-cdk-lib`, the check+assemble step drops from ~125s to ~55-67s on the same machine (including a full semantic diagnostics pass), while producing a `.jsii` type space with zero differences against the classic backend's output across 22,682 types and 110,232 members. No Go toolchain or source build is involved: the backend runs on the stock `typescript@7.1.0-beta` npm package.

## How it works

The backend is selected with an environment variable and is off by default: `JSII_COMPILER_BACKEND=ts7 jsii ...`. When the variable is unset, nothing on the classic TypeScript path changes — the ts7 backend lives in a separate `Compiler.emitTs7()` method, and the TS7 package is only loaded when the flag is set (`main.ts` consults a dependency-free env probe).

Because jsii itself depends on the current TypeScript release line, the 7.x package is installed alongside it under an alias (`typescript7@npm:typescript@7.1.0-beta`, declared as a devDependency of this repository). The loader in `src/ts7/ts7-api.ts` resolves the package in this order and fails with a one-line install hint when nothing suitable is found: `JSII_TS7_TYPESCRIPT` (explicit package directory) → the `typescript7` alias, from the compiled project and then from jsii's own install → the project's regular `typescript` package when it is >= 7.1.

The TS7 API is out-of-process (a Node client talking to the native compiler over JSON-RPC with object handles), so the backend does not try to make it look like `ts.Program` / `ts.TypeChecker`. Wrapping every AST node to imitate the classic object shapes would break WeakMap identity assumptions and add per-node overhead. Instead, `src/ts7/` contains a TS7-native implementation with three parts:

- `ts7-host.ts` — API session/snapshot lifecycle (`createSnapshot` / `getConfiguredProject`, program + checker handles).
- `assembler.ts` — a TS7-native assembler that walks module exports and produces the `spec.Assembly`, porting the classic assembler's semantics exactly (submodule attribution, member re-listing across erased bases, enum members from union constituents, parameter documentation incl. TS5's `findBaseOfDeclaration` fallback, jsii's `splitSummary`, deprecation handling with `--strip-deprecated` allowlists, the `isInterfaceName` datatype rule, etc.). Symbol documentation reads are grouped with the official `api.batch(all(...))` combinator so a class's members go out in one round-trip. The assembly header (name/version/targets/metadata/readme/dependency closure/...) is populated from the same `ProjectInfo` the classic path uses; `jsiiVersion` is stamped with the real compiler version plus an `(ts7 experimental)` marker.
- `ts7-emit.ts` — post-emit pipeline: whole-project `program.emit()` through the API (the server writes outputs to disk and returns file names, so the multi-hundred-MB emit payload never crosses the RPC channel), then jsii rtti injection into the class-bearing `.js` files.

TypeScript compilation errors are surfaced before assembling and fail the build, same as the classic backend. The API returns diagnostics in a wire shape (`{fileName, pos, end, code, category, text}`); the backend maps them onto real `ts.Diagnostic` objects with a `ts.createSourceFile`-backed source file, so they render through jsii's existing formatter exactly like classic output (`src/bad.ts:1:14 - error TS2322: ...` with source context). An emit failure fails the build with a synthetic diagnostic.

## Parity results

Parity is verified with a structural diff of the `.jsii` type space, comparing the ts7 backend against the classic backend on the same source tree (`scripts/ts7-compare-jsii.mjs`, included in this PR). Compared per type: kind, base, interfaces, abstract/datatype flags, symbolId, enum members, and every property/method/initializer signature including parameter documentation and the stability/deprecated/default doc tags. Numbers are matched/total:

| Package | Types | Members | Differences |
|---|---:|---:|---:|
| `constructs` | 12/12 | 53/53 | 0 |
| `cloud-assembly-schema` | 59/59 | 213/213 | 0 |
| `aws-cdk-lib` (`--strip-deprecated`) | 22682/22682 | 110232/110232 | 0 |

The `aws-cdk-lib` gate was run with both the batched and the per-symbol (`JSII_TS7_NO_BATCH=1`) documentation paths, with identical results.

For `constructs`, the emit side is additionally verified: identical emitted file set, byte-identical `.d.ts` output, and runtime-identical `Symbol.for("jsii.rtti")` on every exported class.

## Performance

Measured on a c7i.4xlarge (16 vCPU, Node 22, `typescript@7.1.0-beta`), `aws-cdk-lib` with `--strip-deprecated`, wall clock for check+assemble, median of 3 runs per configuration:

| Backend / configuration | Wall clock | RPC requests | Round-trip time | Server time |
|---|---:|---:|---:|---:|
| classic (TypeScript 5, in-process) | ~125s | — | — | — |
| ts7, batched docs (default) | 66.8s | 552k | 54.2s | 26.0s |
| ts7, per-symbol docs (`JSII_TS7_NO_BATCH=1`) | 54.9s | 792k | 44.4s | 24.1s |
| ts7, batched, no diagnostics pass (`JSII_TS7_SKIP_TYPECHECK=1`) | 63.8s | 552k | 50.5s | 18.5s |
| ts7, per-symbol, no diagnostics pass | 48.7s | 792k | 37.8s | 16.6s |

Two observations worth flagging. First, the full semantic diagnostics pass (run by default so that TypeScript errors reject the build exactly like the classic path) costs ~7.5s of server time but only ~3-6s of wall clock, so it is not where the time goes. Second, on 7.1.0-beta the `api.batch(all(...))` path is *slower* than issuing per-symbol requests even though it cuts the request count by 30%: round-trip time goes up, not down, which points at the per-request cost being dominated by payload encoding/decoding rather than by the number of messages. The per-symbol path is therefore the better default on this release and the switch may flip before this PR leaves draft.

Either way the dominant remaining cost is transport: 38-54s of the 49-67s wall clock is spent waiting on synchronous RPC round-trips while the server itself is busy for 17-26s. The measurement series in issue 1853 discusses which API-side changes (cheaper serialization, async pipelining) would unlock further gains; the earlier Go-pinned prototype of this backend reached ~48s with a hand-rolled batched documentation endpoint, so there is known headroom in the API layer.

## What this PR is NOT

- It is not a proposal to switch jsii to TypeScript 7, nor to change the default backend. The classic path remains the default and is untouched when the flag is unset.
- jsii's own `JSII_xxxx` diagnostics (the error/warning suite from `src/jsii-diagnostic.ts`) are not produced on this path — it targets valid jsii libraries and normal-path parity only. TypeScript compile errors do fail the build.
- Known divergences from the classic assembler, documented in `src/ts7/README.md`: symbolId remapping through `tscRootDir`/`tscOutDir` for out-of-source layouts consumed as dependencies; `--watch` is rejected with an explicit error; `--add-deprecation-warnings` (`.warnings.jsii.js`) and the deprecated-remover emit surgery are not implemented.
- TypeScript 7.1.0-beta's documentation APIs still differ from the classic ones in three JSDoc parameter edge cases (parameter symbols report no `getJsDocTags`, method parameters over-inherit documentation from an unrelated base, constructor parameters miss the base-property fallback). The assembler works around all three (which is how the `aws-cdk-lib` gate reaches 0 differences); a standalone repro is being filed against `microsoft/TypeScript`, and the workarounds can be removed once it is fixed.
- Multi-language generation (pacmak) on a ts7-produced assembly has not been exercised yet.
- The `typescript/sync` API is still marked unstable upstream; the backend reads it through loose typings on purpose and will track API changes until it stabilizes.

## Try it

```sh
# install TypeScript 7.1 next to your existing TypeScript (no Go, no source build)
npm i -D typescript7@npm:typescript@beta

# then, in any jsii package:
JSII_COMPILER_BACKEND=ts7 npx jsii

# parity check against the classic backend:
npx jsii                                   # produces the reference .jsii
JSII_COMPILER_BACKEND=ts7 npx jsii         # produces the ts7 .jsii
node scripts/ts7-compare-jsii.mjs ref.jsii ts7.jsii

# measurement switches (see src/ts7/README.md):
#   JSII_TS7_TIMING=1          print RPC request counts / round-trip / server time
#   JSII_TS7_NO_BATCH=1        per-symbol documentation requests instead of api.batch
#   JSII_TS7_SKIP_TYPECHECK=1  skip the diagnostics pass (type errors are NOT detected)
```

## Feedback wanted

- Is an environment-variable opt-in (`JSII_COMPILER_BACKEND=ts7`) the right shape for an experimental backend, or would you prefer a CLI flag / package.json setting?
- Is the `typescript7` alias devDependency acceptable while jsii's own TypeScript dependency stays on the current release line, or would you rather have consumers install the 7.x package themselves (the loader already supports both)?
- Is a separate TS7-native assembler acceptable as the integration strategy while the TS7 API stabilizes, or should the effort go into abstracting `src/assembler.ts` over both object models from the start? (The trade-offs are documented in `src/ts7/README.md`.)
- What parity/verification gates would you want to see before this could graduate from experimental (e.g. pacmak round-trip on a ts7 assembly, the full jsii-calc fixture suite, additional real-world libraries)?

## Testing done

- Full existing test suite plus new unit tests for the backend's pure logic — package resolution rules of the loader and the diagnostics mapping — (`npx jest`: 461 tests) and `eslint` — all passing with the flag unset, so the classic path is regression-free. No native binary is needed for the test suite.
- Parity gates as described above on `constructs`, `cloud-assembly-schema`, and `aws-cdk-lib` (current `main`), rebuilt from this branch against `typescript@7.1.0-beta`, with both the batched and the per-symbol documentation paths.
- Emit verification on `constructs` (file set, `.d.ts` bytes, runtime rtti).
- The 4-configuration x 3-run performance matrix above, collected with `JSII_TS7_TIMING=1`.
