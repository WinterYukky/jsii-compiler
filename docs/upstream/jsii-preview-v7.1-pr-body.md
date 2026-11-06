# Draft PR body — aws/jsii-compiler: compile with the TypeScript 7 programmatic API (follow-up to the preview/v7.1 dependency bump)

> Paste-ready body for the PR from `WinterYukky/jsii-compiler:feat/ts7-backend-preview-1793929812` to `aws/jsii-compiler:preview/v7.1`.
> Head at the time of writing: `54bf754` (nine commits on top of `c50a54c`). Reference the dependency-bump PR by URL, not by number. Paragraphs are single lines for clean GitHub rendering.
> Suggested title: `feat: compile with the TypeScript 7 programmatic API`

---

## Summary

The `preview/v7.1` branch pins `typescript@7.1.0-beta`, whose package no longer ships the in-process compiler API (`ts.Program`, `TypeChecker`, transformers) the compiler was built on; `yarn compile` fails with 936 type errors there and the follow-up was left to a separate change. This is that change: the compiler now drives the TypeScript 7 programmatic API (`typescript/sync`, an out-of-process compiler the client talks to over handles) and it is the only way the compiler works. There is no mode switch and no fallback to the classic API.

The result builds (`npx projen compile` reports 0 errors), produces assemblies identical to the classic compiler on the packages I compared, and passes the parts of the test suite that do not depend on the three features deferred to follow-up changes (listed under "Not in this PR").

## What changes

**Removed (13 source files, about 7,700 lines).** Everything that walked the TypeScript AST or type checker in-process: `src/assembler.ts`, `src/validator.ts`, `src/emitter.ts`, `src/node-bindings.ts`, `src/type-tracker.ts`, `src/directives.ts`, `src/docs.ts`, `src/reserved-words.ts`, `src/sets.ts`, and the emit transforms (`src/transforms/deprecated-remover.ts`, `deprecation-warnings.ts`, `runtime-info.ts`, `utils.ts`). The two test files that exercised only that code (`test/directives.test.ts`, `test/transforms/runtime-info.test.ts`) go with them.

**Added (about 3,500 lines).**
- `src/ts7/` — the TypeScript 7 host (`ts7-host.ts`, `ts7-api.ts`: locating and loading the package, opening the project), the assembler (`assembler.ts`, a structured port of the classic one, method by method, over the TypeScript 7 checker), the emit pipeline (`ts7-emit.ts`: `.js`/`.d.ts` emit through the server plus the jsii runtime-type-info injection as a post-emit pass) and the orchestration (`index.ts`). This code existed on my experimental branch behind an environment variable and is now the compiler.
- `src/diagnostic.ts` — the compiler's own minimal `Diagnostic` model and renderer. TypeScript 7 does not export `ts.Diagnostic`; categories keep the classic numeric values so `jsii.diagnostics` configuration keeps its meaning, and the renderer reproduces the `file:line:col - error TSxxxx:` layout with source context.
- `src/tsconfig/read.ts` — reading a user-provided `tsconfig.json` with its `extends` chain resolved (TypeScript 7 parses the file on the server; the validator still needs the effective JSON).
- `test/ts-jest-transformer.js` — a 20-line shim so ts-jest keeps working (see "Known issues on preview/v7.1 itself").

**Modified.** `src/compiler.ts` keeps the tsconfig generation/validation and project-reference discovery and delegates compilation to `ts7Emit` (+91/−354). `src/jsii-diagnostic.ts`, `src/utils.ts`, `src/warnings.ts`, `src/project-info.ts` and `src/tsconfig/*` are retyped from `ts.*` to the compiler's own types; tsconfig handling works on the JSON form end to end, with the case-insensitive option values and `lib` names normalized the way the classic parser did implicitly. `src/common/symbol-id.ts` keeps `symbolIdentifier` with structural parameter types (see "Breaking").

Net against `preview/v7.1`: 62 files, +4,451/−8,675.

## Parity

I compared the `.jsii` produced by this branch against the one produced by the classic compiler for the same sources, field by field over the whole assembly. Four fields are excluded because they legitimately differ between any two builds or compiler versions: `jsiiVersion`, `fingerprint`, `locationInModule` (positions in the TypeScript 7 declarations differ by a few lines for some nodes) and `metadata.tscOutDir` (recorded by jsii 6.x and this branch, not by 5.7.5). `metadata.jsii.compiledWithDeprecationWarnings` is also excluded for aws-cdk-lib, since `--add-deprecation-warnings` is not part of this change.

| Package | Classic reference | Result |
|---|---|---|
| `constructs` (12 types, 53 members) | jsii 6.0.18, built from source | Identical. Emitted `.js`/`.d.ts` file set identical, every `.d.ts` byte-identical, runtime type info (`Symbol.for('jsii.rtti')`) identical. |
| `@aws-cdk/cloud-assembly-schema` (59 types, 213 members) | jsii 5.7.5, built from source | Identical except one field in category (a) below. |
| jsii-calc fixtures of this repository (`@scope/jsii-calc-base-of-base`, `@scope/jsii-calc-base`, `@scope/jsii-calc-lib`, `jsii-calc`: 297 types, 728 members in `jsii-calc` alone) | jsii 6.0.20 from npm | Three packages identical; `jsii-calc` identical except three fields in category (a). |
| `aws-cdk-lib` from source (aws/aws-cdk `main` at `42913b76`, 23,131 types, built with `--strip-deprecated --compress-assembly` as `lerna run build` does) | jsii 6.0.20 as pinned by the monorepo, the actual `lerna run build` artifact | 60 differing leaf fields out of the whole assembly, all in the two categories below; 0 others. |

The two remaining categories, with the complete field lists in [`strict-exclusions-aws-cdk-lib-54bf754.json`](strict-exclusions-aws-cdk-lib-54bf754.json):

| Category | aws-cdk-lib | Other packages | What it is |
|---|---|---|---|
| (a) Order of the constituents of a union type; the set of constituents is identical | 6 fields (`CfnResource.obtainDependencies` return element type, `aws_cloudwatch_actions.LambdaAction` initializer parameter `lambdaFunction`, `aws_mediatailor.CfnPlaybackConfiguration[Props].configurationAliases`, `aws_sam.CfnFunction.EventSourceProperty.properties`, `aws_sam.CfnStateMachine.EventSourceProperty.properties`) | `cloud-assembly-schema.MetadataEntry.data`; `jsii-calc.AllTypes.unionProperty`, `jsii-calc.ClassWithNestedUnion.unionProperty` (property and initializer parameter) | The classic compiler emitted the constituents in the checker's order, which is the order of the checker's internal type ids (creation order). That order is not observable through the TypeScript 7 API. This branch orders constituents by declaration (intrinsic primitives, then arrays of primitives, then named types by program file order and position, then other collections), which reproduces the classic order everywhere else in these packages. The order of union constituents is carried into the generated bindings by jsii-pacmak, so these fields can change the member order in generated code. |
| (b) `@`-prefixed words inside documentation text | 54 fields on 27 members (`tags` properties of 20 L1 `*Props` structs, `masterUserPassword`/`adminPassword` of two L1 structs, and the five `aws_s3tables` L1 classes) | none | The TypeScript 6 JSDoc parser used by the classic compiler treats `@.` (in "`... symbols: _ . : / = + - @.`") and `@aws-cdk/aws-s3tables-alpha` in the middle of a sentence as the start of a tag: the remarks are cut off there and the rest ends up in `docs.custom` under the key `""` or `aws-cdk`. The TypeScript 7 parser keeps the text as text. The classic output is the broken one here. |

Along the way the comparison surfaced, and this PR fixes, these divergences the earlier type-space comparison had not shown: member ordering (classic `_sortMembers`: static, immutable, required, name); the documentation tags `@stable`/`@experimental`/`@subclassable`/`@defaultValue`/`@return`/`@see`/`@enum` and custom tags, with tag values kept verbatim; `{@link ...}` references in documentation text (the TypeScript 7 checker renders them as plain text, the classic language service kept the braces, with a trailing space for unresolved names); documentation inherited by undocumented members from base classes and implemented interfaces, and by parameter properties from the constructor's `@param`; `overrides` and `usedFeatures` (previously produced by the validator's inheritance pass; its data-producing half is ported); `namespace` on types in submodules and the registration of nested submodules; the initializer of a class without its own constructor (the base type's, or an erased base class's); the ordering of `implements` and the erasure of non-exported interfaces; the resolution of types that live in a dependency's submodule or behind a symlinked package (previously emitted as `any`); submodule `.jsiirc.json` targets / READMEs / namespace-conflict warnings; `metadata.tscRootDir` inferred from the sources when `rootDir` is not configured (TypeScript 7 no longer infers it, TS5011); and the details of `--strip-deprecated` on the assembly (empty member lists kept, interface list re-sorted when a stripped type is replaced).

Compile time for the three small packages is well under a second of server time. `aws-cdk-lib` compiles in 60 to 63 s wall-clock on a c7i.4xlarge (4 runs during this comparison, type check and emit included); the earlier experiment measured about 54 s on this path against about 106 s for the classic compiler on a c7i.8xlarge.

## Not in this PR

These three areas are intentionally left out so the compiler becomes usable on `preview/v7.1` first. Each behaves explicitly rather than silently, and its tests are kept with `describe.skip`/`test.skip` and a `TODO(ts7)` comment rather than deleted.

| Area | Current behaviour on this branch | Skipped tests | Proposed follow-up |
|---|---|---|---|
| A. jsii validation diagnostics (`JSII_xxxx` codes from the classic validator: visibility/type/optionality changes in overrides, intersection-type restrictions, exported-but-hidden types, enum value duplicates, naming rules, inline `@jsii suppress` directives, …) | The assembly is produced without these checks; TypeScript's own diagnostics are reported as before. The `overrides` data the same pass produced is included. | 136 (`negatives` 92, `type-intersections` 22, `warnings` 13, `class-covariant-overrides` 8, `enums` 1) | First follow-up: port the validator over `@jsii/spec` (it is mostly spec-level already; the AST-bound parts need positions from the TypeScript 7 declarations). |
| B. `--add-deprecation-warnings` (generation of `.warnings.jsii.js` and the call injection) | Fails with an explicit error. | 29 (`deprecation-warnings` 28, `integration` 1) | Second follow-up; the generator needs a TypeScript 7 replacement for the transformer-based injection. |
| C. `--strip-deprecated` on the emitted `.js`/`.d.ts` | The assembly is stripped (members, types, allow-list honoured); the emitted JavaScript and declarations still contain the deprecated members. | 3 (`deprecated-remover`) | Third follow-up, together with B, since both are emit-side transforms. |

One smaller difference I am aware of and did not address: the `symbolIdentifier`-based resolution of foreign types needs the dependency's assembly to carry `symbolId`s (assemblies without them fall back to matching top-level type names, as before).

## Breaking

- `--watch` is rejected with an explicit error. The TypeScript 7 API supports snapshot updates, so watch mode can be rebuilt, but it is not part of this change.
- `--add-deprecation-warnings` is rejected with an explicit error (see above).
- The experimental switches of my earlier branch are gone: `JSII_COMPILER_BACKEND`, the `typescript7` alias package, `JSII_TS7_BATCH` and `JSII_TS7_SKIP_TYPECHECK`. `JSII_TS7_TYPESCRIPT` (explicit path to a `typescript` >= 7.1 package) is kept as a development aid.
- Programmatic API: `Compiler.emit()` returns the compiler's own `EmitResult` (`emitSkipped`, `diagnostics`, `emittedFiles`) and diagnostics are the compiler's own `Diagnostic` (`messageText` is always a string; `file` is `{ fileName, text? }`) instead of `ts.EmitResult`/`ts.Diagnostic`. `compileJsiiForTest` and the other helpers in `jsii` keep their signatures and stay synchronous (the TypeScript 7 API is an ES module and is loaded with `require(esm)`, hence the Node >= 22.12 floor the branch already has).
- `jsii/common` still exports `symbolIdentifier` and `normalizePath`. `symbolIdentifier`'s first two parameters are now structural (`{ getAliasedSymbol, getFullyQualifiedName }` and `{ flags }`) instead of `ts.TypeChecker`/`ts.Symbol`; a classic checker and symbol still satisfy them, so jsii-rosetta's `symbolIdentifier(typeChecker, declSym, { assembly })` (`src/jsii/jsii-utils.ts`) type-checks unchanged. Rosetta itself pins `jsii: ~6.0.0` and the classic `typescript: ~6.0`, so nothing changes for it until it moves to TypeScript 7, at which point it needs its own port of the classic API usage anyway.
- Packages that import other internals of the `jsii` package (`src/assembler.ts`, the transforms, the validator) lose them; `package.json` only exported `.`, `./bin/jsii`, `./package.json` and `./common`, so I expect no supported consumer to be affected.

## Known issues on preview/v7.1 itself

Neither is introduced by this PR; both come from tooling that `require('typescript')`s the classic API by name and gets the TypeScript 7 package, whose main entry only exports `version`.

- `eslint` cannot start on the branch: `@typescript-eslint/typescript-estree` fails at load time (`Cannot read properties of undefined (reading 'Cjs')`). I did not change this; the same redirection trick used for ts-jest would work, or a TypeScript 6 install for lint only.
- ts-jest needs the classic API from several of its own modules, so its `compiler` option alone is not enough and yarn `packageExtensions` cannot help (the peer dependency on the root `typescript` wins). `test/ts-jest-transformer.js` redirects `require('typescript')` issued from inside ts-jest to a tooling-only `typescript6` devDependency; the compiler itself is built with the TypeScript 7 package. It can be removed when ts-jest supports TypeScript 7.

## Tests

`npx projen compile`: 0 errors (from 936 on the branch). `npx jest --ci`: 30 of 32 suites run, 257 tests pass, 168 are skipped with `TODO(ts7)` comments as itemised above, 0 fail. `tsc -p test/tsconfig.json --noEmit` passes. The parity comparison above is a field-by-field diff of the whole assembly JSON (not the type-space comparison script of the earlier experiment) against classic reference assemblies built from the same sources.

I used an AI assistant (Claude, through an agent) as a tool for the port, the comparisons and the drafting; the scope, the design decisions and the review of every change are mine.
