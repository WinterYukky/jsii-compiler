# jsii-compiler → TypeScript 7 port analysis

Based on: (a) a full inventory of `ts.*` usage across `jsii-compiler/src` (aws/jsii-compiler @ main,
2026-07), (b) the assembler-lite prototype that reproduced real `.jsii` outputs at 98.6-100% fidelity,
and (c) the two TS7-side patches (checker `getFullyQualifiedName` = microsoft/typescript-go#4700, and
the `getEmitOutput` draft branch).

## 1. API usage inventory (by bucket)

### (a) Direct TS7 equivalent exists — mechanical replacement
- All 17 checker methods used by the Assembler hot path (getSymbolAtLocation, getExportsOfModule,
  getTypeAtLocation, getSignatureFromDeclaration, getConstantValue, getAliasedSymbol, ...):
  verified working via assembler-lite. `getFullyQualifiedName` requires #4700.
- `ts.SyntaxKind` (65 uses), `ts.is*` node predicates (~60 uses): `unstable/ast` + `unstable/ast/is`.
- Enums: SymbolFlags / TypeFlags / ModifierFlags / ObjectFlags / ModuleKind / ScriptTarget /
  DiagnosticCategory — exported by `unstable/sync` / ast enums.
- Type/Symbol/Signature object model reads (type.getBaseTypes, symbol.declarations, ...): verified.

### (b) Equivalent with adaptation (small, known semantic differences)
- AST shape deltas found empirically: property optionality is `postfixToken` (not `questionToken`);
  `JSDocTagInfo.text` is a string (drop `displayPartsToString`); `IndexInfo.valueType` naming;
  getter/setter pairs and parameter properties resolve as in assembler-lite.
- `NodeHandle.resolve()` indirection for `symbol.declarations` (one extra call at use sites).
- `ts.getNameOfDeclaration` (21) / `ts.getCombinedModifierFlags` (12): verify presence in
  `unstable/ast`; both are trivially reimplementable locally if absent (name property walk /
  modifier bit fold).
- node-bindings.ts (WeakMap on nodes): works as-is thanks to client-side AST materialization.
- symbol-id.ts: works via #4700 (validated — symbolIds matched on 20k types).

### (c) Requires redesign (bounded, strategies known)
1. **Program construction & lifecycle** (`compiler.ts`, 624 lines): `ts.createIncrementalProgram`,
   `ts.createWatchCompilerHost/createWatchProgram`, `ts.CompilerHost`, `ts.sys` (18 uses),
   `readConfigFile`/`parseJsonConfigFileContent` → replaced by the API session model
   (`API`, `parseConfigFile`, `updateSnapshot({ fileChanges })` for watch/incremental).
2. **Emit + CustomTransformers** (`transforms/*`, ~155 `ts.factory` uses):
   - `runtime-info.ts` (rtti injection): becomes a post-emit text/AST pass over
     `getEmitOutput()` results — already validated (rtti identical on constructs).
   - `deprecated-remover.ts`: AST surgery at emit time today; port as a post-emit pass over
     emitted `.js`/`.d.ts` (drop deprecated members) or as a pre-emit source-to-source step.
     The `.jsii` side of stripping is already reproduced in assembler-lite (allowlist support).
   - `deprecation-warnings.ts`: generates a standalone `.warnings.jsii.js` — pure code
     generation; can emit source text directly (no compiler emit hook needed).
3. **Diagnostics** (`jsii-diagnostic.ts`, 986 lines): jsii manufactures its own `ts.Diagnostic`s
   bound to nodes and pretty-prints them. Node positions/files are available client-side; needs a
   local formatter (colors/context lines) replacing `ts.formatDiagnostics*`. Self-contained.
4. **Module resolution** (`ts.resolveModuleName`, 2 uses in project-info): replace with
   `require.resolve`-based resolution (validated in assembler-lite for dependency `.jsii` loading)
   or request exposure on the API.

### (d) Unknowns / risks
- Exact diagnostic fidelity for jsii's negative-test suite (codes, spans, messages).
- Watch-mode ergonomics on the snapshot model (functionally covered, untested at jsii scale).
- The unstable API will keep moving until it stabilizes (7.1 timeframe).
- Full-fidelity tail seen in assembler-lite (~0.3% members on aws-cdk-lib): intersection-based
  heritage and misc edge cases; expected to surface again in the real port.

## 2. Recommended strategy

**Directed port with a thin adapter (not a full ts-facade shim).** Wrapping every AST node to fake
the classic object shapes would break WeakMap identity and add overhead; instead:
- Keep the Assembler's structure and port call sites mechanically (buckets a/b are ~90% of sites).
- Introduce a small `Ts7Host` adapter that owns: API session/snapshot lifecycle, config parsing,
  diagnostics collection/formatting, `getEmitOutput` + post-emit transform pipeline.
- Feature-flag the backend (`JSII_COMPILER_BACKEND=ts7`), keeping strada default until parity.

## 3. Phasing & rough effort (single engineer)

| phase | scope | est. |
|---|---|---|
| P1 | Ts7Host + compiler.ts port (compile path, no watch), assembler call-site port | 2-4 weeks |
| P2 | transforms → post-emit pipeline on `getEmitOutput` + warnings generation | 1-2 weeks |
| P3 | diagnostics formatter + negative-test parity + watch mode | 1-2 weeks |
| P4 | perf pass (batch overloads, doc-comment caching) | days |

Prereqs upstream: #4700 (merged) and a `getEmitOutput`-shaped API (draft exists). Everything else
is jsii-side.

## 4. Expected payoff (measured, not estimated)
- aws-cdk-lib `.jsii` generation: 2m38s → ~39s unbatched prototype; batching should push the
  assembler walk well below that.
- Full aws-cdk monorepo build: 10m08s → ~4min projection (jsii = 68% of build work, 7.5-9x faster).
