# PoC: jsii on the TypeScript 7 (tsgo) programmatic API

Reproduction scripts and measured data for the feasibility spike described in
[WinterYukky/jsii-compiler#1](https://github.com/WinterYukky/jsii-compiler/issues/1).

Environment used for the published numbers: EC2 c7i.4xlarge (16 vCPU / 32 GB), Ubuntu 24.04,
Node 22, `typescript@5.9`, `@typescript/native-preview@7.0.0-dev.20260707.2`,
`aws-cdk` main (2026-07-18) + `jsii@5.9.44`.

## Files

| file | purpose |
|---|---|
| `gen-fixture.mjs` | Generates a synthetic jsii-style library (`N` modules × 4 exported types each: props interface, behaviour interface, enum, class; shallow inheritance chains) into `fixture-large/`. |
| `walk-tsgo.mjs` | Assembler-like extraction walk implemented on `@typescript/native-preview/unstable/sync` (module exports → aliases → types/bases → members → signatures → docs → enum constants → diagnostics). Prints per-stage timings and RPC stats (`collectTiming`). |
| `walk-strada.mjs` | The identical walk implemented on the classic in-process `typescript` (strada) API, for apples-to-apples comparison. |
| `checker-profile-aws-cdk-lib.json` | Real-world profile: per-method call counts and in-checker wall time of `ts.TypeChecker` usage by jsii 5.9.44 while building `aws-cdk-lib` (captured with a `Proxy` wrapped around `program.getTypeChecker()` in `lib/assembler.js`). |
| `build-log-aws-cdk-lib.txt` | Tail of the corresponding `aws-cdk-lib` build log (per-tool build time breakdown). |

## Running

```sh
npm install @typescript/native-preview@latest typescript@5.9
node gen-fixture.mjs 2000          # 2000 modules = 8000 exported types
printf '{"type":"commonjs"}' > fixture-large/package.json
node walk-tsgo.mjs
node --max-old-space-size=8192 walk-strada.mjs
```

Note: the fixture directory must not inherit a `"type": "module"` package.json, or the
`node16` module resolution will reject the extension-less relative imports.

## Instrumentation patch (sketch)

The aws-cdk-lib profile was captured by patching the installed `jsii/lib/assembler.js`:

```js
this._typeChecker = (() => {
  const c = this.program.getTypeChecker();
  const counts = {}, times = {};
  process.on('exit', () => require('fs').writeFileSync(
    `/tmp/checker-counts-${process.pid}.json`,
    JSON.stringify({ counts, times }, null, 1)));
  return new Proxy(c, { get(t, p) {
    const v = t[p];
    if (typeof v !== 'function') return v;
    return (...a) => {
      counts[p] = (counts[p] ?? 0) + 1;
      const s = process.hrtime.bigint();
      try { return v.apply(t, a); }
      finally { times[p] = (times[p] ?? 0) + Number(process.hrtime.bigint() - s); }
    };
  }});
})();
```

## Headline results

- `aws-cdk-lib` type-check: tsgo **5.04s** vs tsc 5.9 **40.52s** (clean, zero diagnostics).
- `aws-cdk-lib` check+emit (3,758 JS + 3,758 d.ts): tsgo **7.6s** vs tsc **63.2s** vs current jsii **2m37s**.
- jsii checker usage on `aws-cdk-lib`: ~1.72M calls, only ~17.6s spent inside the checker.
- Synthetic walk RPC tax: ~18µs/call transport overhead, unbatched.
- TS7 API gaps found: `getFullyQualifiedName` (jsii's most-called API) and emit-time `CustomTransformers`.

## Full-monorepo shootout (added 2026-07-21, c7i.8xlarge)

- `compile-bench-monorepo.csv` — per-package `tsc -p --noEmit` vs `tsgo -p --noEmit` timings
  across all 63 buildable aws-cdk packages (after a full baseline build).
- Totals: tsc 424.7s vs tsgo 56.8s (**7.5x**); 61/63 clean on both.
- Full build with lint (current toolchain, concurrency=10): wall clock 10m08s; per-tool breakdown
  (from "Build times for ..." log lines): jsii 68%, eslint 25%, awslint 2%, plain tsc 2%, other 3%.

## assembler-lite prototype (added 2026-07-22)

`assembler-lite.mjs` is a minimal jsii Assembler reimplemented on the TS7 API (requires a tsgo build
with `getFullyQualifiedName` — see microsoft/typescript-go#4700). It produces a `.jsii`-style
assembly. `compare-jsii.mjs` structurally diffs it against a reference `.jsii`.

Results (structural diff vs the real jsii output, union member order normalized):

| package | types | result | assembler-lite | real jsii |
|---|---:|---|---:|---:|
| `constructs` | 12 | **identical** (0 diffs) | ~0.05s | ~1.0s |
| `@aws-cdk/cloud-assembly-schema` | 59 | **identical** (0 diffs) | ~0.13s | ~1.3s |

Features exercised: docs (summary/remarks/stability/default/deprecated), optional/variadic/immutable/
abstract/static/protected, heritage (extends/implements), erased-base member hoisting, type-alias union
resolution in declaration order with flattening, enums, `object`->json mapping, private-constructor
elision, and symbolId derivation via the new `getFullyQualifiedName` API.

Original note on the first `constructs` run: **structurally identical output**
(0 missing/extra types, 0 field diffs, 0 member diffs — docs/stability/optional/variadic/heritage/
enums/symbolId all match), assembling in ~0.05s vs ~1.0s for the real jsii on the same machine.

## aws-cdk-lib run (added 2026-07-22)

assembler-lite now handles submodules (incl. class-merged nested types and vendored submodules),
peer-dependency (external assembly) references, strip-deprecated allowlists, and per-type stability
cascading. Result on **aws-cdk-lib** (vs the real jsii 5.9.44 output, same tree):

- types: **20,743 / 20,744 matched** (1 missing re-export edge case), 0 extra
- members: **98,980 / 100,378 identical (98.6%)**
- wall clock: **~33s** (load 0.8s + assemble ~32s, unbatched naive walk, 1.25GB RSS)
  vs **2m38s** for the real jsii on the same machine (c7i.4xlarge)
