# Draft PR body — microsoft/TypeScript: align parameter JSDoc resolution with the classic services

> Paste-ready body for the PR from `WinterYukky/TypeScript:fix/jsdoc-param-resolution` to `microsoft/TypeScript:main` (two commits: fix + test, based on the `v7.1-beta` tag; rebase onto `main` before opening).
> Suggested title: `LS/API: align parameter JSDoc resolution with the classic services semantics`
> Reference the issue by URL in the first line ("Fixes <issue URL>"). Paragraphs are single lines for clean GitHub rendering.

---

Fixes <issue URL>.

## Summary

The programmatic API's parameter documentation (`Symbol.getDocumentationComment` and `Symbol.getJsDocTags`, backed by `internal/ls/jsdoc.go`) diverged from the classic services in three ways that show up as soon as a consumer documents an inheritance hierarchy. This PR ports the classic rules — `getJSDocParameterTags` for own `@param` tags and `findBaseOfDeclaration` for constructor parameters — to the Go language service so both methods return what `src/services/utilities.ts` returns for the same program.

## Behaviors fixed

| # | Scenario | Classic services | Before this PR | After this PR |
|---|---|---|---|---|
| 1 | Parameter of an overriding method whose declaration has no JSDoc; the base signature documents the parameter | `""` (parameter docs are only taken from the hosting declaration's own JSDoc) | base signature's `@param` text leaks into the override | `""` |
| 2 | Constructor parameter without its own `@param`; a super type has a same-named documented property | the property's documentation (`findBaseOfDeclaration`) | `""` | the property's documentation |
| 3 | `getJsDocTags` on any parameter symbol | the matching `@param` tag | `[]` | the matching `@param` tag (and, for case 2, the base property's tags) |

Implementation notes: `getJSDocOrTag` now resolves a parameter through `findOwnParameterTag` (the hosting declaration's own JSDoc, with the overload first-signature hop the classic code performs) and, only for constructor parameters, through `findConstructorParamBaseProperty`, which walks the class's `extends` and `implements` heritage elements in source order and stops at the first super type that has a property with the parameter's name, exactly like `findBaseOfDeclaration`. `GetSymbolJSDocTags` applies the same two rules for parameter declarations so tags and comments always agree, and therefore now takes the checker; the single API call site is updated.

## Tests

- New `TestParameterJSDocResolution` in `internal/ls` covers all three behaviors against a small program: own `@param` on a base method and on a constructor (comment and tag), no inheritance for method parameters of overrides with and without their own JSDoc, and the base-property fallback for a constructor parameter.
- One fourslash baseline is updated: `quickInfoOnParameterProperties`. Quick info on the parameter property `name` in `class Foo implements IFoo { constructor(public name: string) {} }` now includes the documentation of `IFoo.name`, which is behavior 2 (the constructor-parameter base-property fallback) surfacing through hover. This matches the classic services, whose baseline for the same test already shows the inherited documentation; the test's own source comment ("documentation should leech and work") describes that expectation.
- Everything else passes unchanged: `hereby test` (full Go suite), `hereby lint`, `hereby check:format`, and `hereby test:api` (the `packages/typescript` async, sync and generator-parity API tests), run on this branch rebased onto `main`.
- The standalone reproduction from the issue (one file, classic API vs `typescript/sync`) prints byte-identical output after the change; before it, the two reports differ in the rows listed above.
