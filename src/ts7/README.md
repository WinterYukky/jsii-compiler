# Experimental TypeScript 7 (tsgo) backend — Phase 1

> This document records the architecture decision behind `src/ts7/`. It complements
> `poc/typescript7/PORT-ANALYSIS.md` (on the feasibility branch), and should be
> folded back into it when the two branches are reconciled.

## What this is

An **experimental**, opt-in jsii backend that generates the `.jsii` assembly using
the out-of-process TypeScript 7 API (`@typescript/native-preview` / `tsgo`) instead
of the classic in-process "Strada" compiler (`typescript`).

Enable it with:

```sh
JSII_COMPILER_BACKEND=ts7 jsii
```

The default (strada) backend is **completely unaffected** — the ts7 path is a
separate `Compiler.emitTs7()` method and lazily loads the toolchain.

## Toolchain

The backend needs a patched `tsgo` + `@typescript/native-preview` client that adds
two APIs jsii depends on:

- `checker.getFullyQualifiedName` (upstream PR microsoft/typescript-go#4700)
- `program.getEmitOutput` (Strada-compatible `EmitOutput`/`OutputFile`)

Provision it with [`scripts/ts7-setup.sh`](../../scripts/ts7-setup.sh), which builds
the patched fork (or pulls a prebuilt tarball from an S3 cache) into `.ts7/`
(gitignored). Override locations with `JSII_TS7_DIR` / `JSII_TS7_NATIVE_PREVIEW` /
`TSGO_PATH`.

## Architecture decision (Phase 1)

**Chosen: a directed, TS7-native re-implementation of the Assembler (`ts7/assembler.ts`),
NOT a facade over the 3500-line strada `Assembler`.**

Rationale:

1. **Goal of Phase 1 is to *prove* `.jsii` parity on the TS7 API**, as fast and
   reliably as possible — not to unify the two compilers. Unification is a Phase 2
   decision that should be made from parity data.
2. **A facade over the strada `Assembler` leaks everywhere.** The strada code assumes
   the classic `ts.Program`/`ts.TypeChecker`/AST object model (e.g. `questionToken`
   vs the TS7 `postfixToken`, `JSDocTagInfo.text` object vs string, synchronous
   `symbol.declarations` vs `NodeHandle.resolve()`). Faking those shapes would be
   only partially correct and would break `node-bindings` WeakMap identity.
3. **The "shim is NG" warning in PORT-ANALYSIS is specifically about wrapping AST
   nodes** (which destroys WeakMap identity). A thin *checker/program facade* whose
   methods keep strada-compatible signatures but return the raw TS7 objects is a
   different thing and is fine — that is what `Ts7Host` provides.
4. The prototype `poc/typescript7/assembler-lite.mjs` already reproduced real `.jsii`
   output at **98.6–100% fidelity** on aws-cdk-lib (~20k types). `ts7/assembler.ts`
   is a structured port of it.

To keep the eventual Phase 2 comparison tractable, `ts7/assembler.ts` mirrors the
strada `Assembler`'s method structure and names (`_visitClass`, `_visitInterface`,
`_visitEnum`, `_visitMethod`, `_visitProperty`, `_visitDocumentation`, …).

### Type strategy

Phase 1 favours a working `.jsii` over precise typings: `Ts7Host` returns the raw
TS7 objects and the assembler reads them with loose (`any`) typings under an
experimental flag. Proper type abstraction is deferred to Phase 2.

## Out of scope for Phase 1

- **Diagnostics / negative-path handling.** Half the value of the strada `Assembler`
  is the `JSII_xxxx` error/warning suite it manufactures for invalid input
  (`src/jsii-diagnostic.ts`). The ts7 backend does **not** reproduce these in
  Phase 1; it targets normal-path parity only.
- Watch mode.
- Full emit-transform parity beyond the rtti post-emit pass (Phase 2, `getEmitOutput`).

## Verification gate

Build `constructs` → `cloud-assembly-schema` with both backends and diff the `.jsii`
via `poc/typescript7/compare-jsii.mjs` (target: 0 differences). Stretch goal:
aws-cdk-lib.
