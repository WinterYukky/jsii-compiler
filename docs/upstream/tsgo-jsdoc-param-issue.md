# Draft: microsoft/typescript-go issue — parameter JSDoc resolution diverges from TypeScript 5 services

> Paste-ready issue body. File as a bug against microsoft/typescript-go, then
> follow up with the fix PR (branch `fix/jsdoc-param-inheritance-1787119427` on
> WinterYukky/typescript-go). Keep issue-first order.

---

**Title:** API/LS: parameter JSDoc resolution diverges from TypeScript 5 services (`getDocumentationComment` / `getJsDocTags`)

## Summary

The Go implementation resolves parameter documentation differently from
TypeScript 5's services layer in three ways:

1. **Method parameters inherit `@param` docs from base signatures.** In TS5,
   a parameter's documentation only comes from the hosting declaration's own
   JSDoc (`getJSDocParameterTags`); an overriding method's parameters never
   inherit `@param` text from the base class/interface signature, even when the
   override has no JSDoc at all. typescript-go walks base-class members while
   resolving the hosting method's JSDoc, so the base signature's `@param` leaks
   into the override's parameters.
2. **Constructor parameters do not get TS5's base-property fallback.** In TS5,
   services `getDocumentationComment` applies `findBaseOfDeclaration` to a
   constructor parameter with no own `@param`: the documentation of a
   same-named PROPERTY on the first super type that has one is inherited
   (recursing through undocumented overrides). typescript-go returns an empty
   comment for these parameters.
3. **`Symbol.getJsDocTags` returns no tags for parameter symbols.** In TS5 it
   returns the parameter's matching `@param` tag.

## Reproduction

`repro.ts`:

```ts
export abstract class MatcherBase {
  /**
   * Tests the value.
   * @param actual the target to match
   */
  public abstract test(actual: string): void;
}

/** Overrides test with NO JSDoc at all. */
export class PlainCapture extends MatcherBase {
  public test(actual: string): void { void actual; }
}

/** Base class with a documented property. */
export class WithCount {
  /** How many widgets there are. */
  public readonly count: number = 0;
}

/** Subclass ctor without JSDoc. */
export class Counted extends WithCount {
  constructor(count: number) { super(); void count; }
}

export class Tagged {
  /**
   * Creates a tag.
   * @param key The string key for the tag.
   */
  constructor(key: string) { void key; }
}
```

For each parameter symbol (obtained from
`checker.getSignatureFromDeclaration(...).getParameters()`), compare
`getDocumentationComment(checker)` and `getJsDocTags(checker)` between
TypeScript 5.x and `@typescript/native-preview`'s API:

| Symbol | TS 5 (expected) | typescript-go (actual) |
|---|---|---|
| `PlainCapture.test` param `actual` — doc | `""` | `"the target to match"` (inherited from `MatcherBase.test`) |
| `Counted` ctor param `count` — doc | `"How many widgets there are."` (from base property `WithCount.count`) | `""` |
| `Tagged` ctor param `key` — tags | `[param: "key The string key for the tag."]` | `[]` |
| `MatcherBase.test` param `actual` — tags | `[param: "actual the target to match"]` | `[]` |

(TS5 side measured with `ts.createProgram` + `ts.displayPartsToString(sym.getDocumentationComment(checker))`;
Go side via the `@typescript/native-preview` synchronous API. A paste-ready
side-by-side runner is included in the linked PR discussion.)

## Where this bites in practice

We are experimenting with running jsii (the AWS CDK's multi-language binding
generator) on the typescript-go API. jsii derives `.jsii` assembly parameter
documentation from these APIs, and this divergence produced hundreds of
member-level differences against the TypeScript-5-based output on aws-cdk-lib
(both directions: docs appearing on overridden methods that should have none,
and constructor parameter docs missing). We currently work around it by reading
`@param` text directly from source text instead of the doc APIs.

## Relevant TS5 semantics (for reference)

- `services/utilities.ts` `getDocumentationComment` /
  `findBaseOfDeclaration`: for a declaration whose parent is a
  `ConstructorDeclaration`, the base search runs against the CLASS's super
  types and looks up a property named like the declaration's symbol; for a
  method's parameter, the "class or interface declaration" resolves to the
  method itself, which has no super type nodes — hence no inheritance.
- `getJSDocParameterTags` only consults the hosting declaration's own JSDoc.

## Proposed fix

See the follow-up PR: parameter `@param` lookup restricted to the hosting
declaration's own JSDoc (with the overload first-signature hop), a
`findBaseOfDeclaration`-equivalent fallback for constructor parameters, and
`Symbol.getJsDocTags` support for parameter symbols. All existing Go tests and
the `@typescript/native-preview` npm suite pass unchanged, and the repro above
becomes byte-identical between TS5 and typescript-go.
