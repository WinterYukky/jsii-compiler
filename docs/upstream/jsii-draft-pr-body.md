# Draft PR body — aws/jsii-compiler: experimental TypeScript 7 (tsgo) backend

> Paste-ready body for the draft PR from `WinterYukky/jsii-compiler:feat/ts7-backend` to `aws/jsii-compiler:main`.
> Suggested title: `feat: experimental TypeScript 7 (tsgo) compiler backend`
> Mark as **Draft**. Paragraphs are single lines for clean GitHub rendering.

---

## Summary

This PR adds an opt-in, experimental compiler backend that runs jsii's type analysis and emit on TypeScript 7 (typescript-go) through the `@typescript/native-preview` programmatic API. It is the draft follow-up to the investigation discussed in issue 1853 (see my comment there for the full measurement series).

The headline result: on `aws-cdk-lib`, the check+assemble step drops from ~119s to ~32s (about 3.7x) while producing an assembly that is 100% identical to the classic backend's output — every type, member, parameter and doc field (21,192 types / 102,570 members).

## How it works

The backend is selected with an environment variable and is off by default: `JSII_COMPILER_BACKEND=ts7 jsii ...`. Nothing on the classic TypeScript 5 path changes; when the variable is unset, the code path is byte-for-byte the one that exists today.

The TS7 API is out-of-process (a Node client talking to the tsgo Go server over JSON-RPC with object handles), so the backend does not try to make tsgo look like `ts.Program` / `ts.TypeChecker`. Wrapping every AST node to imitate the classic object shapes would break WeakMap identity assumptions and add per-node overhead. Instead, `src/ts7/` contains a TS7-native implementation with three parts:

- `ts7-host.ts` — API session/snapshot lifecycle (open project, obtain program + checker handles).
- `assembler.ts` — a TS7-native assembler that walks module exports and produces the `spec.Assembly`, porting strada's semantics exactly (submodule attribution, member re-listing across erased bases, enum members from union constituents, parameter documentation incl. TS5's `findBaseOfDeclaration` fallback, jsii's `splitSummary`, deprecation handling with `--strip-deprecated` allowlists, etc.).
- `ts7-emit.ts` — post-emit pipeline: declaration emit, jsii rtti injection into the emitted `.js`, and `.jsii.tabl.json` generation.

The tsgo build the backend runs against needs a few API additions that are not yet in `@typescript/native-preview` releases (checker-side batching and doc APIs). Those are being proposed upstream to microsoft/typescript-go separately; `scripts/ts7-setup.sh` builds the pinned toolchain in the meantime. This is the main reason the PR is a draft: the backend cannot run against a stock npm release yet.

## Parity results

Parity is verified with a structural diff over the full `.jsii` output (every type, every member, every parameter, every doc field), comparing the ts7 backend against the classic backend on the same source tree:

| Package | Types | Members | Field diffs |
|---|---:|---:|---:|
| `constructs` | 12/12 | 53/53 | 0 |
| `cloud-assembly-schema` | 59/59 | 213/213 | 0 |
| `aws-cdk-lib` (`--strip-deprecated`) | 21192/21192 | 102570/102570 | 0 |

For `constructs`, the emit side is additionally verified: identical emitted file set, byte-identical `.d.ts` output, and runtime-identical `Symbol.for("jsii.rtti")` on every exported class.

## Performance

Measured on a c7i.4xlarge (16 vCPU), `aws-cdk-lib` with `--strip-deprecated`, 3-run median: classic backend ~119s for check+assemble; ts7 backend ~32-34s wall clock (~472k RPC requests, ~13.5s tsgo server time, remainder split between transport overhead and Node-side assembly).

The dominant remaining cost is the synchronous request-per-symbol RPC pattern; the measurement series in issue 1853 discusses which API-side changes (batching, async pipelining) would unlock further gains.

## What this PR is NOT

- It is not a proposal to switch jsii to TypeScript 7, nor to change the default backend. The classic path remains the default and is untouched.
- It is not a language-feature upgrade: the ts7 backend intentionally compiles with the same target/lib semantics the classic backend uses today.
- It does not (yet) implement `.warnings.jsii.js` generation (deprecation warnings injection) or the deprecated-remover emit surgery; packages using those flags still need the classic backend.
- It does not run against a stock `@typescript/native-preview` release; it needs the pinned toolchain until the API additions land upstream.

## Testing done

- Full existing test suite (`npx jest` + `eslint`) passes with the backend code merged and the flag unset — the classic path is regression-free.
- Parity gates as described above on `constructs`, `cloud-assembly-schema`, and `aws-cdk-lib`, rebuilt from this branch.
- Emit byte-identity gate on `constructs` (file set, `.d.ts` bytes, runtime rtti).
- The typescript-go API additions the backend depends on carry their own Go tests and the `@typescript/native-preview` npm suite in the upstream proposals.
