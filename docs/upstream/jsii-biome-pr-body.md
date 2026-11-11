# Draft PR body — aws/jsii-compiler: lint and format with Biome on preview/v7.1

> Paste-ready body for the PR from `WinterYukky/jsii-compiler:chore/biome-1794399052` to `aws/jsii-compiler:preview/v7.1`.
> Head at the time of writing: `de1503a` (three commits on top of `c50a54c`; independent of the TypeScript 7 compiler change). Reference other PRs by URL, not by number. Paragraphs are single lines for clean GitHub rendering.
> Suggested title: `chore: lint and format with Biome instead of ESLint and Prettier`

---

## Summary

On `preview/v7.1` the lint task cannot start: `@typescript-eslint/typescript-estree` does `require('typescript')` and expects the in-process compiler API, and the `typescript@7.1.0-beta` package this branch depends on no longer ships it (its main entry only exports `version`). Keeping ESLint would mean installing a second, TypeScript 6 copy of the package for the linter alone. As agreed with the maintainers, this change replaces ESLint and Prettier with Biome, which does not depend on the TypeScript package, accepting that a few rules without a Biome equivalent are dropped. Biome checks the 94 files in scope in about half a second.

This is a tooling-only change. Apart from the one-time reformat (its own commit, see below), no source file changes behaviour.

## What changes

- `.projenrc.ts`: `eslint: false, prettier: false, biome: true` with the configuration described under "Rule mapping"; projen 0.104's `Biome` component generates `biome.jsonc`, the `biome` task (`biome check --no-errors-on-unmatched --write`, spawned by `test` the way `eslint` was) and the `@biomejs/biome@^2.6` devDependency, and removes `.eslintrc.json`, `.prettierrc.json`, the `eslint` task and the nine ESLint/Prettier devDependencies.
- VS Code settings recommend `biomejs.biome` and format on save with it instead of `dbaeumer.vscode-eslint`.
- The Biome scope is the same as ESLint's: `src/**`, `test/**`, `build-tools/**`, `projenrc/**`, `.projenrc.ts`, minus `test/negatives`, `*.generated.ts`, snapshots and Markdown.
- The six `eslint-disable-next-line` comments that suppressed a rule Biome also reports (`no-require-imports` at four `require()` sites, `no-control-regex` at the two ANSI-escape regexes) become `biome-ignore` comments with a reason.
- Second commit, `chore: reformat with Biome`: the output of `biome check --write`, 27 files, +117/−94. Formatter differences to Prettier 2.8 (constructor parameter properties one per line, parentheses around `??` inside a ternary, long `reduce()` calls broken up) and the import organizer (specifiers sorted inside an import, `export *` declarations sorted in `src/index.ts`).
- Third commit, `chore: remove the eslint-disable comments that no longer have a linter`: the remaining 40 suppression comments (`no-await-in-loop`, `complexity`, `member-ordering`, `explicit-member-accessibility`, `no-bitwise`, ...) are deleted; the rules they addressed either have no Biome equivalent or are not enabled.

## Rule mapping

| ESLint rule (`.eslintrc.json`) | Biome | Notes |
|---|---|---|
| `prettier/prettier` with `.prettierrc.json` | `formatter` + `javascript.formatter` | `indentStyle: space`, `indentWidth: 2`, `lineWidth: 120`, `quoteStyle: single`, `trailingCommas: all`, `semicolons: always`, `bracketSpacing: true`. Prettier's `quoteProps: consistent` has no equivalent; `quoteProperties: preserve` keeps the existing quoting. |
| `quotes` [single, avoidEscape, allowTemplateLiterals] | formatter `quoteStyle: single` | The Biome formatter also keeps the quote that avoids escaping. |
| `@typescript-eslint/no-require-imports` | `style/noCommonJs` (error) | Off for `.projenrc.ts` as before (override). |
| `import/no-extraneous-dependencies` [devDependencies globs] | `correctness/noUndeclaredDependencies` (error) | `devDependencies: ['**/test/**', '**/build-tools/**', '**/projenrc/**', '.projenrc.ts']`, `optionalDependencies: false`, `peerDependencies: true`; off for `.projenrc.ts` as before. |
| `import/order` (warn) + `import/no-duplicates` | `assist.actions.source.organizeImports` (recommended) | Biome also sorts the specifiers inside an import and merges duplicates; applied once in the reformat commit. |
| `dot-notation` | `complexity/useLiteralKeys` (error) | |
| `unicorn/prefer-node-protocol` | `style/useNodejsImportProtocol` (error) | |
| `unicorn/no-array-for-each` | `complexity/noForEach` (error) | |
| `@typescript-eslint/no-shadow` | `suspicious/noShadow` **off** | Biome's rule also reports a type parameter of a static method that shadows the class's, and the key of an index signature (`[name: string]`), which typescript-eslint did not. 8 of its 9 findings on this code base are of that kind; the one real shadow was already suppressed. Left off rather than adding nine `biome-ignore` comments. |
| `curly` [multi-line, consistent] | `style/useBlockStatements` **off** | Biome's rule requires braces on every body; the ESLint configuration allowed `if (x) return;` on one line, which the code base uses. |
| `import/no-unresolved` | dropped | `correctness/noUnresolvedImports` exists but reports `chalk` (package `exports` map) and `case` (types from `@types`) as unresolved, and the `typescript` imports that are broken on this branch anyway. `tsc` reports unresolved imports (TS2307). |
| `@typescript-eslint/no-floating-promises` | dropped | Biome's `nursery/noFloatingPromises` needs type inference (`project` domain) and is not stable; not enabled. |
| `@typescript-eslint/return-await` | dropped | No equivalent. |
| `@typescript-eslint/member-ordering` | dropped | No equivalent. |
| `unicorn/no-unnecessary-await` | dropped | `nursery/noUselessAwait` is the equivalent (0 findings here) but is a nursery rule; worth enabling once it is promoted. |
| `no-bitwise: off` | n/a | Biome has no such rule. |
| `no-return-await: off`, `no-shadow: off` | n/a | Were only turned off in favour of their typescript-eslint variants. |

## Rules of Biome's recommended set turned off

Biome's recommended preset enables rules ESLint did not run here. Those the code base does not follow are turned off in `.projenrc.ts`, each with the number of findings at the time, so that this change does not modify any source file. Each can be enabled in its own change, with the corresponding code fix.

| Rule | Findings | Why off for now |
|---|---|---|
| `style/noNonNullAssertion` | 207 | Style; the code base uses `!` deliberately. |
| `suspicious/noExplicitAny` | 99 | Style. |
| `suspicious/noTemplateCurlyInString` | 82 | False positives: the code base emits TypeScript/JavaScript source text that contains `${...}` on purpose (codegen, tests). |
| `style/useImportType` | 59 | Style; needs `verbatimModuleSyntax`-style decisions. |
| `style/useArrayLiterals` | 28 | Style (`new Array<T>()`). |
| `complexity/useArrowFunction` | 11 | Style. |
| `complexity/noThisInStatic` | 10 | Style (`this` in static factory methods of the diagnostic codes). |
| `suspicious/noDoubleEquals` | 8 | Two sites in the tsconfig validator rely on loose equality on purpose; the others are `==` on numbers/strings. ESLint's `eqeqeq` was not enabled. |
| `suspicious/noImplicitAnyLet` | 8 | `let x;` whose type TypeScript infers from the later assignments (control-flow typing); not an implicit `any` under `noImplicitAny`. |
| `style/useTemplate` | 5 | Style. |
| `style/useConst`, `complexity/useOptionalChain` | 4 each | Style. |
| `performance/noAccumulatingSpread`, `suspicious/noGlobalIsNan` | 3 each | Small code changes; separate. |
| `complexity/noBannedTypes`, `complexity/noStaticOnlyClass` | 2 each | Style. |
| `correctness/noSwitchDeclarations` | 1 | A `const` inside a `case` without a block (`src/directives.ts`); not used from another clause. One-line fix, separate. |
| `suspicious/noShadowRestrictedNames` | 1 | A local named `constructor` in the assembler. One rename, separate. |
| `suspicious/noConstEnum`, `suspicious/noIdenticalTestTitle`, `complexity/noUselessContinue`, `noUselessSwitchCase`, `noUselessTernary`, `noUselessTypeConstraint` | 1 each | Small; separate. (`noIdenticalTestTitle` points at a real duplicate test name in `test/symbol-identifiers.test.ts`.) |

With this configuration `biome check` reports nothing on the branch.

## Known limitations

- `projen build` still fails on this branch at `compile`: the TypeScript 7 package does not provide the compiler API the current source uses (920 errors on `c50a54c` with or without this change). That is what the TypeScript 7 compiler change addresses; this change only makes `yarn biome` (and the `test` task up to the lint step) work. `tsc` is not needed by Biome, so the lint result does not depend on the compile state.
- `biome check --write` rewrites files like `eslint --fix` did; run `yarn biome` before committing.
- Biome reads `.gitignore` (`vcs.useIgnoreFile`), so ignored build output is not scanned; the `files.includes` list in `biome.jsonc` also carries the projen-generated files as negations (generated by the projen component).
- The import organizer orders `export *` declarations alphabetically (`src/index.ts`); the names re-exported from `./common/symbol-id`, `./helpers` and `./jsii-diagnostic` do not overlap, so the public API is unchanged.
