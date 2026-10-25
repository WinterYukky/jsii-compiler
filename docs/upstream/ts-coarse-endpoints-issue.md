# Draft issue for microsoft/TypeScript — API: coarse-grained checker queries for bulk-extraction tools (`getSymbolDocumentations`, `getMembersOfType`)

> Target: https://github.com/microsoft/TypeScript (`tsc/internal/api`, `typescript/sync` and `typescript/async` clients). Template: Feature request. Reference implementation: fork branch `WinterYukky/TypeScript` `api/coarse-endpoints-generic-filter-1792824451` (Go handlers, proto, generated client, unit tests). Consumer: `WinterYukky/jsii-compiler` branch `spike/async-fanout-1792738229` (feature-detected use in the jsii TypeScript 7 backend). Measurement history: `src/ts7/PHASE1-RESULTS.md` Phases 4–5C in `WinterYukky/jsii-compiler` branch `feat/ts7-backend-1784773376`.

## Summary

Tools that extract an API surface from a whole program (jsii, TypeDoc, API Extractor, documentation generators) walk every exported type and, for every member, ask the checker for its properties, its declared type, the type that declares it and its JSDoc. On the out-of-process API each of those is a round trip, so the walk is bound by round-trip count rather than by checker work: jsii issues ~700k requests for aws-cdk-lib while the server spends only ~6 s computing types for them. I propose two additive methods that return, in one round trip, what such a traversal needs for a symbol list or for the members of one type, with a filter made of neutral predicates so no type is materialised for a member the caller would have skipped.

## The problem, measured

jsii's TypeScript 7 backend over aws-cdk-lib (jsii's benchmark fixture: 20,221 types, 97,071 members), c7i.4xlarge, TypeScript at upstream main 8d9b6da built from source, request mix by count: `getJsDocTags` 134k, `getTypeAtLocation` 125k, `getDocumentationComment` 117k, `getTypeOfSymbolAtLocation` 105k, `getTypeFromTypeNode` 47k, `getPropertiesOfType` 23k, `getExportsOfSymbol` 20k, `getFullyQualifiedName` 20k.

A Go execution trace of the server shows the handler time for those per-member methods is 1.6–5 µs each; the round trip the client observes is 26 µs, and the server goroutine spends 24 s of a 45 s run blocked waiting for the next request. In other words the traversal is dominated by the number of synchronous messages, not by the checker.

The existing `batchRequests` does not help this pattern: the requests of a member walk are dependent (the type's properties are needed before their declared types can be asked for), and in a separate measurement a 1000-symbol documentation batch made the run slower on hosts with deep CPU idle states (reported separately with a proposed fix in the sync channel). Client-side input caches do not help either: on this traversal the duplicate-request rate of the hot methods is 0% for documentation reads and `getPropertiesOfType`, and memoising the 80%-duplicate `getTypeAtLocation` saved 113k requests but no measurable wall clock, because repeated requests are cheap on the server and the cost is the message itself.

## Proposal

Two additive checker methods, both operating on the persistent API checker and returning the same symbol and type handles the fine-grained methods return (so handle identity, which consumers rely on to correlate types across calls, is preserved).

`getSymbolDocumentations(symbols: Symbol[]): { tags: JSDocTagInfo[]; comment: string }[]` returns, per symbol, exactly what `getJsDocTags` and `getDocumentationComment` return. One request per type's member list instead of two per member.

`getMembersOfType(type: Type, filter: MemberFilter): TypeMember[]` returns the properties of a type that pass the filter, each with its symbol, the symbol of the type declaring it, whether it is a method or a constructor parameter property, its documentation, and (on request) its declared type (`getTypeOfSymbolAtLocation` at its first declaration). The response shape is the union of what a member-rendering loop asks for today.

The filter is deliberately a set of neutral predicates combined by the caller, like a `WHERE` clause, rather than a tool's policy encoded in the server:

| predicate | meaning | jsii uses it as | other tools |
|---|---|---|---|
| `visibility: ("public"\|"protected"\|"private")[]` | include these visibilities; ECMAScript private names count as private | `["public","protected"]` | a public-API extractor passes `["public"]` |
| `kinds: ("property"\|"accessor"\|"method"\|"parameterProperty")[]` | include these member kinds | all | a documentation tool rendering accessors separately |
| `excludeJsDocTags: string[]` | drop members whose JSDoc carries any of these tags | `["internal"]`, plus `"deprecated"` when stripping | TypeDoc's `@hidden`, API Extractor's `@internal`/`@alpha` |
| `excludeNamePattern: string` (RE2) | drop members whose wire-form name matches | `^_`, and `^(_\|prototype$)` on the static side | any naming convention |
| `includeInheritedFrom: { all } \| { declaringTypes: Symbol[] }` | which declaring types contribute members; the queried type always does | the type's erased (unexported) bases | `all` for a flattened view, `{}` for own members only |
| `includeDeclaredType: boolean` | attach the declared type of non-method members | true | false for a name-only listing |

The point of the filter is laziness: a traversal that renders only the surviving members must not pay for types of members it skips. An earlier spike that prefetched declared types for all members before filtering was slower than the fine-grained walk because it materialised types for the private and internal members that dominate at aws-cdk-lib scale; the filter lets the server skip them.

An earlier iteration of this filter had jsii-shaped switches (`excludeInternal`, `excludeDeprecated`, `parameterPropertyOwner`). I replaced them with the predicates above because a server-side copy of a tool's policy is both unusable by other tools and a parity hazard: the first version dropped ECMAScript private fields differently from the client and the difference showed up as four extra members on one type. Matching names in their wire form (`__#1@#x`) on both sides fixed it, and the policy itself now lives in the caller.

## Results

Same fork build, c7i.4xlarge, aws-cdk-lib fixture, spin-poll enabled on the channel (the separate proposal), `.jsii` output byte-identical between the fine-grained and coarse paths, 3 runs each:

| path | wall (median) | requests | transport overhead | bytes sent |
|---|---|---|---|---|
| fine-grained (today's methods) | 34.5 s | 698k | 8.6 s | 131 MB |
| `getSymbolDocumentations` + `getMembersOfType` | 29.4 s | 304k | 5.4 s | 52 MB |

Real aws-cdk-lib (aws-cdk main built with lerna, `--strip-deprecated`, two runs): 43.2/43.1 s → 37.8/38.2 s, requests 783k → 340k, bytes sent 168 MB → 65 MB, server time unchanged (22.1 → 21.5 s). With the neutral-predicate filter the numbers are the same as with the earlier jsii-shaped one (4 vCPU host: 42.8/43.8 → 37.3/37.2 s), i.e. generality cost nothing.

Remaining requests after the change are dominated by `getTypeFromTypeNode` (47k), `getTypeAtLocation` (46k), `getTypeOfSymbolAtLocation` for parameters (22k) and `getFullyQualifiedName` (20k); folding type arguments / union constituents / index types into `TypeResponse` would remove ~70k more but at ~1.3 s is below the noise of these runs, so I left it out.

## Design notes

Both handlers resolve handles through `setupChecker` and build responses with the existing `newSymbolResponse` / `newTypeResponse`, so no new id space is introduced and a `declaredType` handle equals what `getTypeOfSymbol` returns for the same symbol (asserted in the unit tests). The filter's `excludeNamePattern` is compiled with Go's RE2 and an invalid pattern is a client error. `includeInheritedFrom` determines the declaring type as the type at the declaration's owner node (its parent, or grandparent for a constructor parameter property); when it is `nil` the method degrades to `getPropertiesOfType` semantics. Unit tests cover the predicate combination a traversal uses, declaring-type admission, kinds, the empty filter equivalence with `getPropertiesOfType`, and that `getSymbolDocumentations` matches the individual methods element by element.

## Reproduction

Build the fork branch (`npx hereby build && npx hereby build:api`, `go test ./internal/api/ -run 'TestGetMembersOfType|TestGetSymbolDocumentations'`), then run the jsii spike branch against it with `JSII_COMPILER_BACKEND=ts7 JSII_TS7_TYPESCRIPT=<package dir>`; `JSII_TS7_COARSE=0` forces the fine-grained path for an A/B on the same build, and `api.getTimingInfo()` reports request count, round-trip and server time.
