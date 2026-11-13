# Draft PR body — aws/jsii-compiler: port the jsii validation diagnostics to the TypeScript 7 compiler

> Paste-ready body for the PR from `WinterYukky/jsii-compiler:feat/ts7-validator-1794493579` to `aws/jsii-compiler:preview/v7.1`.
> Head at the time of writing: `d72808d` (9 commits on top of `preview/v7.1` at `5f49f41`). Reference other PRs by URL, not by number. Paragraphs are single lines for clean GitHub rendering.
> Suggested title: `feat: jsii validation diagnostics on the TypeScript 7 compiler`

---

## Summary

The TypeScript 7 compiler (https://github.com/aws/jsii-compiler/pull/2867) produced the assembly without the jsii validation diagnostics: the `JSII_xxxx` checks the classic compiler ran while visiting the program (unsupported TypeScript constructs, references to hidden types, naming rules, struct rules, inline `@jsii` directives) and in `src/validator.ts` afterwards (override and implementation contracts, reserved words, static/instance conflicts, submodule namespaces). Inputs the classic compiler rejected compiled silently. This change restores all of them on the TypeScript 7 compiler, so the `negatives` test suite passes against its unchanged snapshots and the compiler can replace the classic one in a build that uses `--Werr`.

The assembly is unchanged: on aws-cdk-lib (23,131 types) the `.jsii` produced with and without this change is identical, and the diagnostics match the classic compiler on the same source (see "Numbers").

## What changes

**`src/validator.ts` is back**, as it was in the classic compiler, with the TypeScript dependency removed: the validations work on `@jsii/spec` objects and only need source positions for their messages. The `ts.Node` bindings became the client-side declaration nodes of the TypeScript 7 AST (`#typescript/ast`), `ts.SyntaxKind` is read from the loaded TypeScript package, and the one AST detail that differs (`?` is `postfixToken` on the TypeScript 7 nodes) is behind a helper.

**`src/node-bindings.ts`** associates assembly elements with the declaration nodes they were produced from, through a `WeakMap`, like before. The assembler records the node of every type, member, parameter and initializer it emits.

**`src/directives.ts`** parses the `@jsii` directives (`ignore`, `suppress`, and the `JSII2000`/`JSII2999` diagnostics for missing or unknown arguments) from the JSDoc data every declaration node carries (`jsDoc[].tags`, tag names, comment parts). It no longer depends on TypeScript's node classes, so the parser-level tests that build their input with TypeScript 6's `createSourceFile` run unchanged against it. `JsiiDiagnostic` keeps the node a diagnostic was created from, and the inline `@jsii suppress` check in `src/warnings.ts` walks up from that node, as before.

**The assembler runs the inline checks** at the places the classic `Assembler` ran them: while visiting a type (`JSII1000`, `JSII1004`, `JSII1006`, `JSII1012`, `JSII3003`, `JSII3004`, `JSII5011`, `JSII7001`, `JSII8000`, `JSII8004`, `JSII9996`, `JSII1999` for index signatures), a member (`JSII1005`, `JSII3009`, `JSII5016`, `JSII5018`, `JSII5019`, `JSII7000`, `JSII8005`, `JSII8006`), a type reference (`JSII1001`, `JSII1002`, `JSII1003`, `JSII1007`, `JSII1999` for tuples, `JSII3001`, `JSII3002`), and once all types are known (`JSII1008`–`JSII1011` for intersection types, `JSII3005`–`JSII3008`, `JSII3999` for types removed by `--strip-deprecated`, `JSII5013`–`JSII5015`, `JSII5017`, `JSII8007`). The source positions come from the declaration nodes; the type-level information from the same checker requests the assembler already makes.

**The diagnostic renderer** (`src/diagnostic.ts`) follows TypeScript's `formatDiagnosticsWithColorAndContext` so the output matches the classic one byte for byte: related information, the `...` elision of spans longer than five lines, the trailing newline rules. Diagnostics are sorted and deduplicated like `ts.sortAndDeduplicateDiagnostics` did. As in the classic compiler, the type model is still analyzed when the program has TypeScript errors (so that jsii diagnostics are reported alongside them), the assembly is not written in that case, and `--fail-on-warnings` ignores silenced warnings.

## Tests

The test suites that were skipped with `@TODO(ts7)` for the validation diagnostics run again: `negatives` (93, snapshots unchanged), `type-intersections`, `warnings` (including the inline `@jsii suppress` cases), `directives` (parser-level tests and directive diagnostics), `class-covariant-overrides`, `enums`. 149 tests come back; the remaining 31 skips are the `--add-deprecation-warnings` and `--strip-deprecated`-in-emitted-code tests, which are a separate follow-up. `npx projen test`: 422 passed, 31 skipped, 0 failed; ESLint passes.

One note for running the `negatives` suite locally: its snapshots have always been recorded from colored output and sorted as such (the sort order of two diagnostics on the same file depends on the ANSI codes that are stripped afterwards). This is unchanged from the classic compiler; the suite passes with `FORCE_COLOR=1`, as it does in CI.

## Numbers

Measured on aws-cdk-lib built from source (aws/aws-cdk `main` at `42913b76`, 23,131 types, `--strip-deprecated --compress-assembly` as `lerna run build` does, plus `--Wno=JSII5018 --Wno=JSII6` as `cdk-build` passes), c7i.4xlarge (16 vCPU), Node 26.13, TypeScript 7.1 (`@typescript/native`). The `.jsii` is identical before and after this change (excluding `jsiiVersion` and `fingerprint`). The scripts are in `scripts/ts7-strict-compare.mjs`.

**Diagnostics on aws-cdk-lib (without `--Wno`):** the classic compiler (jsii 6.0.20, TypeScript 6.0.3) reports `JSII5018` 1,110 times and nothing else; this branch reports `JSII5018` 1,107 times and nothing else. The three missing warnings are on members of `@deprecated` types that `--strip-deprecated` removes, whose names the classic compiler validated before removing the type. No false positives.

**Compile time**, alternating runs, three each, median wall clock, CPU seconds from cgroup accounting (TypeScript 7 server process included):

| | `preview/v7.1` (no validation) | this branch | validation cost |
|---|---|---|---|
| wall clock | 61.3 s | 66.6 s | +5.3 s (+9 %) |
| CPU | 98.9 s | 103.6 s | +4.7 s (+5 %) |

The validation itself makes fewer checker requests than the compiler made before it: 806,381 against 917,910 (-111,529, -12 %). The port initially added 72,000 requests; three commits brought the total under the baseline by resolving each heritage clause symbol once and reusing it for the supertype check, deciding literal enum initializers without the checker, skipping the getter/setter write-type comparison when both annotations have the same text, and, the largest item, looking a member's declaring type up once per declaration and only when the `@internal`/`_` naming rules can apply (`getTypeAtLocation` 196,996 → 104,319). What remains of the cost is round-trip latency (the server spends about the same time; the client-side wait grew by 5.5 s) plus the spec-level validation passes in JavaScript, which are a few hundred milliseconds each. The small packages (`constructs`, the `jsii-calc` fixtures) compile in well under a second of server time either way.

## Also fixed

Two differences from the classic compiler that showed up while comparing diagnostics on aws-cdk-lib, both in the assembler and both producing the classic assembly now:

- ECMAScript `#private` members (the TypeScript 7 checker names their symbols `__#n@#name`) were treated as public API members. They are private.
- A type of a dependency's submodule could not be resolved when the dependency's assembly has no `symbolId`s (the `test/submodules.test.ts` case that strips them); the name-based fallback now also looks through the submodules when the name is unique.

## Not in this PR

- `--add-deprecation-warnings` (the deprecation-warnings emit transform) and the removal of `--strip-deprecated` members from the emitted `.js`/`.d.ts`: separate follow-ups, tracked by the remaining `@TODO(ts7)` skips.
- Watch mode.
