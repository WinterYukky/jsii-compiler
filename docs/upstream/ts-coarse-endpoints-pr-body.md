# Draft PR body for microsoft/TypeScript — api: getSymbolDocumentations and getMembersOfType, coarse-grained checker queries for traversal tools

> Target: https://github.com/microsoft/TypeScript, branch `WinterYukky/TypeScript` `api/coarse-checker-queries` (on top of upstream `main`). Fixes https://github.com/microsoft/TypeScript/issues/65051. Measurement log: `src/ts7/PHASE1-RESULTS.md`, Phases 4–5C, in `WinterYukky/jsii-compiler` branch `feat/ts7-backend-1784773376`.

---

Fixes https://github.com/microsoft/TypeScript/issues/65051

## Summary

Tools that extract an API surface from a whole program (binding generators such as jsii, documentation generators, API extractors) walk every exported type and, for every member, ask the checker for its properties, its declared type, the type that declares it and its JSDoc. Over the out-of-process API each of those is a round trip, so the walk is bound by the number of synchronous messages rather than by checker work: jsii issues ~700k requests for aws-cdk-lib while the server spends about 6 s computing types for them, and most members are looked at only to be skipped.

This PR adds two checker methods that return, in one round trip, what such a traversal needs for a list of symbols or for the members of one type. `getMembersOfType` takes a filter made of neutral predicates so that the server never materializes a type for a member the caller would have skipped. Both methods return the same symbol and type handles the existing fine-grained methods return, so handle identity across calls is preserved; the generated output of the workload I used to measure is byte-identical between the two paths.

## What changes

- `tsc/internal/api/proto.go`: `getSymbolDocumentations` (params: a list of symbol references; result: per symbol, `tags` and `comment`) and `getMembersOfType` (params: a type and a `MemberFilter`; result: a list of `MemberResponse`). `MemberResponse` carries the member's `SymbolResponse`, the `SymbolResponse` of the declaring type (`owner`), `isMethod`, `isParameterProperty`, `tags`, `comment` and, on request, `declaredType`.
- `tsc/internal/api/session.go`: the two handlers. `getSymbolDocumentations` is element for element what `getJsDocTags` and `getDocumentationComment` return. `getMembersOfType` iterates `GetPropertiesOfType` in order, applies the predicates cheapest first (name pattern, visibility and kind from the first declaration, then JSDoc tags, then the declaring type) and only then reads documentation and the declared type (`GetTypeOfSymbolAtLocation` at the first declaration) for the survivors. An invalid `excludeNamePattern` is a client error.
- `packages/typescript/src/api/proto.generated.ts`: regenerated (`hereby generate:api`).
- `packages/typescript/src/api/async/api.ts` → `sync/api.ts` (generated): `Checker.getSymbolDocumentations(symbols)` and `Checker.getMembersOfType(type, filter?)`. The client exposes `MemberFilterInput` (string-literal unions for `visibility` and `kinds`, `Symbol`s for `declaringTypes`), `TypeMember` (`symbol`, `owner`, `isMethod`, `isParameterProperty`, `tags`, `comment`, `declaredType`) and `SymbolDocumentation` (`tags`, `comment`, both required), interning symbols and types through the object registry so they are the same objects `getPropertiesOfType` and `getTypeOfSymbol` return.

No existing method, message or type changes.

## Filter options

The filter is a set of neutral predicates the caller combines, like a `WHERE` clause. A tool's own policy (jsii's `@internal`/underscore convention, TypeDoc's `@hidden`, API Extractor's release tags) stays in the tool.

| Predicate | Meaning | Default |
|---|---|---|
| `visibility: ("public" \| "protected" \| "private")[]` | Include these visibilities, read from the first declaration's modifiers; ECMAScript private names count as private. | all |
| `kinds: ("property" \| "accessor" \| "method" \| "parameterProperty")[]` | Include these member kinds; `parameterProperty` is a constructor parameter property. | all |
| `excludeJsDocTags: string[]` | Drop members whose JSDoc carries any of these tags, e.g. `["internal", "deprecated"]`. | none |
| `excludeNamePattern: string` | Drop members whose name, in its wire form (`__#1@#x` for an ECMAScript private field), matches this RE2 pattern, e.g. `^_`. | none |
| `includeInheritedFrom: { all?: boolean; declaringTypes?: Symbol[] }` | Which declaring types contribute members; the queried type always does. `undefined` means every base (plain `getPropertiesOfType` semantics), `{}` means own members only, `{ declaringTypes }` adds members declared on those types. The declaring type is the type at the declaration's owner node (its parent, or grandparent for a parameter property). | all |
| `includeDeclaredType: boolean` | Attach `getTypeOfSymbolAtLocation(symbol, firstDeclaration)` to each non-method member. | `false` |

With no filter and no declared types, `getMembersOfType(type)` returns the same symbols as `getPropertiesOfType(type)` in the same order, plus each member's documentation.

## Tests

- `tsc/internal/api/session_members_test.go`: the predicate combination a traversal uses (visibility + excluded tags + name pattern + own members only + declared types), declaring-type admission, each `kinds` value including `accessor`, `isMethod` agreeing with the `method` kind for every member, the empty filter equalling `getPropertiesOfType`, an invalid pattern, and `getSymbolDocumentations` matching the individual methods element by element.
- `tsc/internal/api/session_members_differential_test.go`: a differential fixture. A class hierarchy with an overridden method, an overloaded method, getter/setter pairs on both the base and the derived class, public/protected/private members, an ECMAScript private field, a public and a private constructor parameter property, `@internal` and `@deprecated` members, an underscore-prefixed member and a static member is traversed with the fine-grained path (`getPropertiesOfType`, then per member `getTypeOfSymbolAtLocation` at the first declaration, `getJsDocTags`, `getDocumentationComment`) and with `getMembersOfType`. For every member the test asserts the same symbol handle, the same declared type handle, the same tags and comment, the expected visibility and kind (each predicate on its own partitions the members exactly as a hand-written table predicts), the expected declaring type (an override is attributed to the derived class, inherited members to the base, and the owner equals the member symbol's parent), and the same order. The combined filter a binding generator uses yields exactly the predicted survivors with the same per-member data as the unfiltered call.
- `packages/typescript/test/async/api.test.ts` → `test/sync/api.test.ts` (generated): through the client, `getMembersOfType` returns the surviving members as the same `Symbol` objects `getPropertiesOfType` returns, with `owner` identical to the class symbol, `declaredType` identical to `getTypeOfSymbol`, accessors and methods classified as expected, `{}` restricting to own members and no filter equalling `getPropertiesOfType`; `getSymbolDocumentations` equals `getJsDocTagsOfSymbol` and `getDocumentationCommentOfSymbol` per symbol and returns `[]` for `[]`.
- Repo checks on the branch: `npx hereby generate` leaves the tree clean; `npx hereby test:tsc`, `npx hereby test:api`, `npx hereby lint` and `npx hereby check:format` pass.

## Numbers

Same fork build, c7i.4xlarge, jsii's TypeScript 7 backend over the aws-cdk-lib snapshot jsii-compiler uses for its benchmark (20,221 types, 97,071 members), `.jsii` output byte-identical between the two paths, 3 runs each, spin-poll on the channel enabled in both (https://github.com/microsoft/TypeScript/issues/65049):

| Path | Wall (median) | Requests | Transport overhead | Bytes sent |
|---|---|---|---|---|
| Fine-grained (today's methods) | 34.5 s | 698k | 8.6 s | 131 MB |
| `getSymbolDocumentations` + `getMembersOfType` | 29.4 s | 304k | 5.4 s | 52 MB |

Current aws-cdk-lib built from source (two runs): 43.2 / 43.1 s → 37.8 / 38.2 s; requests 783k → 340k; bytes sent 168 MB → 65 MB; server time unchanged (22.1 → 21.5 s). The neutral-predicate filter measures the same as an earlier tool-specific one (4 vCPU host: 42.8 / 43.8 → 37.3 / 37.2 s), so the generality costs nothing.

Why a filter rather than a bulk fetch: an earlier spike that returned declared types for all members and filtered on the client was slower than the fine-grained walk, because at this scale most members are private or internal and their types were materialized for nothing.

## Not covered

The remaining requests of the traversal are dominated by `getTypeFromTypeNode`, `getTypeAtLocation`, `getTypeOfSymbolAtLocation` for parameters and `getFullyQualifiedName`; folding type arguments, union constituents or index types into `TypeResponse` would remove about 70k more but is worth about 1.3 s here, below the noise of these runs, so it is left out. The filter reads visibility and kind from a member's first declaration; a member declared with different modifiers across merged declarations is classified by the first one.
