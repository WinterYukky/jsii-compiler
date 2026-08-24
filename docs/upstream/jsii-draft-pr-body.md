# Draft PR body — aws/jsii-compiler: experimental TypeScript 7 (tsgo) backend

> Paste-ready body for the draft PR from `WinterYukky/jsii-compiler:feat/ts7-backend` to `aws/jsii-compiler:main`.
> Suggested title: `feat: experimental TypeScript 7 (tsgo) compiler backend`
> Mark as **Draft**. Paragraphs are single lines for clean GitHub rendering.

---

## Summary

This PR adds an opt-in, experimental compiler backend that runs jsii's type analysis and emit on TypeScript 7 (typescript-go) through the `@typescript/native-preview` programmatic API. It is the draft follow-up to the investigation discussed in issue 1853 (see my comment there for the full measurement series).

On `aws-cdk-lib`, the check+assemble step drops from ~119s to ~48s on the same machine (including a full semantic diagnostics pass; ~33s without it), while producing a `.jsii` type space with zero differences against the classic backend's output across 21,192 types and 102,572 members.

## How it works

The backend is selected with an environment variable and is off by default: `JSII_COMPILER_BACKEND=ts7 jsii ...`. When the variable is unset, nothing on the classic TypeScript 5 path changes — the ts7 backend lives in a separate `Compiler.emitTs7()` method, and the toolchain is only loaded when the flag is set (`main.ts` consults a dependency-free env probe).

The TS7 API is out-of-process (a Node client talking to the tsgo Go server over JSON-RPC with object handles), so the backend does not try to make tsgo look like `ts.Program` / `ts.TypeChecker`. Wrapping every AST node to imitate the classic object shapes would break WeakMap identity assumptions and add per-node overhead. Instead, `src/ts7/` contains a TS7-native implementation with three parts:

- `ts7-host.ts` — API session/snapshot lifecycle (open project, obtain program + checker handles).
- `assembler.ts` — a TS7-native assembler that walks module exports and produces the `spec.Assembly`, porting the classic assembler's semantics exactly (submodule attribution, member re-listing across erased bases, enum members from union constituents, parameter documentation incl. TS5's `findBaseOfDeclaration` fallback, jsii's `splitSummary`, deprecation handling with `--strip-deprecated` allowlists, the `isInterfaceName` datatype rule, etc.). The assembly header (name/version/targets/metadata/readme/dependency closure/...) is populated from the same `ProjectInfo` the classic path uses; `jsiiVersion` is stamped with the real compiler version plus an `(ts7 experimental)` marker.
- `ts7-emit.ts` — post-emit pipeline: whole-project emit through the API (the server writes outputs to disk and returns file names, so the multi-hundred-MB emit payload never crosses the RPC channel), then jsii rtti injection into the class-bearing `.js` files.

TypeScript compilation errors are surfaced before assembling and fail the build, same as the classic backend. An emit failure fails the build with a synthetic diagnostic.

The backend runs against a tsgo toolchain built from `microsoft/typescript-go`, pinned to the final commit of that staging repo (which was closed in August 2026 when the TypeScript 7 native port moved back into `microsoft/TypeScript`). Every API the backend requires is in that pin, including `checker.getFullyQualifiedName` (upstreamed as part of this work) and the whole-project `emit()`. `scripts/ts7-setup.sh` builds the toolchain. A fork ref with a proposed batched symbol-documentation API also works; without it the backend transparently falls back to per-symbol documentation requests, and the measured difference is negligible (~48s vs ~49s on aws-cdk-lib), so there is no fork dependency in practice.

## Parity results

Parity is verified with a structural diff of the `.jsii` type space, comparing the ts7 backend against the classic backend on the same source tree (`scripts/ts7-compare-jsii.mjs`, included in this PR). Compared per type: kind, base, interfaces, abstract/datatype flags, symbolId, enum members, and every property/method/initializer signature including parameter documentation and the stability/deprecated/default doc tags. Numbers are matched/total:

| Package | Types | Members | Differences |
|---|---:|---:|---:|
| `constructs` | 12/12 | 53/53 | 0 |
| `cloud-assembly-schema` | 59/59 | 213/213 | 0 |
| `aws-cdk-lib` (`--strip-deprecated`) | 21192/21192 | 102572/102572 | 0 |

All three gates were run twice — once with the pinned upstream toolchain (per-symbol documentation path) and once with the batched-API fork toolchain — with identical results.

For `constructs`, the emit side is additionally verified: identical emitted file set, byte-identical `.d.ts` output, and runtime-identical `Symbol.for("jsii.rtti")` on every exported class.

## Performance

Measured on a c7i.4xlarge (16 vCPU), `aws-cdk-lib` with `--strip-deprecated`: the classic backend takes ~119s for check+assemble; the ts7 backend takes ~48s wall clock, of which ~15s is the full semantic diagnostics pass (the backend runs it by default so that TypeScript errors reject the build exactly like the classic path). The type analysis itself issues ~472k RPC requests (roughly 13.5s tsgo server time, the remainder split between transport overhead and Node-side assembly).

The dominant remaining cost is the synchronous request-per-symbol RPC pattern; the measurement series in issue 1853 discusses which API-side changes (batching, async pipelining) would unlock further gains.

## What this PR is NOT

- It is not a proposal to switch jsii to TypeScript 7, nor to change the default backend. The classic path remains the default and is untouched when the flag is unset.
- jsii's own `JSII_xxxx` diagnostics (the error/warning suite from `src/jsii-diagnostic.ts`) are not produced on this path — it targets valid jsii libraries and normal-path parity only. TypeScript compile errors do fail the build.
- Known divergences from the classic assembler, documented in `src/ts7/README.md`: the `@struct` doc-tag override and datatype propagation from base interfaces; symbolId remapping through `tscRootDir`/`tscOutDir` for out-of-source layouts consumed as dependencies; submodule entries are declared but not yet enriched (readme/symbolId/locationInModule/targets).
- Multi-language generation (pacmak) on a ts7-produced assembly has not been exercised yet.
- `--watch` is rejected with an explicit error; `--add-deprecation-warnings` (`.warnings.jsii.js`) and the deprecated-remover emit surgery are not implemented.
- It does not run against a stock `@typescript/native-preview` npm release; the programmatic API is not shipped in a stable form yet, so the toolchain is built from typescript-go source.

## Try it

```sh
# one-time toolchain build (Go >= 1.24 and git required; set S3_CACHE=s3://... to reuse prebuilt tarballs)
./scripts/ts7-setup.sh

# then, in any jsii package:
JSII_COMPILER_BACKEND=ts7 npx jsii

# parity check against the classic backend:
npx jsii                                   # produces the reference .jsii
JSII_COMPILER_BACKEND=ts7 npx jsii         # produces the ts7 .jsii
node scripts/ts7-compare-jsii.mjs ref.jsii ts7.jsii
```

## Feedback wanted

- Is an environment-variable opt-in (`JSII_COMPILER_BACKEND=ts7`) the right shape for an experimental backend, or would you prefer a CLI flag / package.json setting?
- Is a separate TS7-native assembler acceptable as the integration strategy while the TS7 API stabilizes, or should the effort go into abstracting `src/assembler.ts` over both object models from the start? (The trade-offs are documented in `src/ts7/README.md`.)
- What parity/verification gates would you want to see before this could graduate from experimental (e.g. pacmak round-trip on a ts7 assembly, the full jsii-calc fixture suite, additional real-world libraries)?

## Testing done

- Full existing test suite plus new toolchain-free unit tests for the backend's pure logic (`npx jest`: 453 tests) and `eslint` — all passing with the flag unset, so the classic path is regression-free.
- Parity gates as described above on `constructs`, `cloud-assembly-schema`, and `aws-cdk-lib`, rebuilt from this branch, with both the upstream-main toolchain (per-symbol documentation fallback path) and the batched-API fork toolchain.
- Emit verification on `constructs` (file set, `.d.ts` bytes, runtime rtti).
- The typescript-go API additions the backend can take advantage of carry their own Go tests and the `@typescript/native-preview` npm suite in the upstream proposals.
