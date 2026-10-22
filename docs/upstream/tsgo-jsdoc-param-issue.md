# Draft: microsoft/TypeScript issue — parameter JSDoc resolution in the TypeScript 7.1 API diverges from the classic services

> Paste-ready body following the microsoft/TypeScript "Bug report" template. File the issue first, then open the PR from `WinterYukky/TypeScript:fix/jsdoc-param-resolution` (body in `tsgo-jsdoc-param-pr-body.md`) referencing it.
> Suggested title: `API: parameter documentation (getDocumentationComment / getJsDocTags) diverges from the classic services in TypeScript 7.1`
> Paragraphs are single lines for clean GitHub rendering. Do not write literal issue/PR numbers in the body; link by URL if needed.

---

### 🔎 Search Terms

typescript 7.1 api getDocumentationComment getJsDocTags parameter jsdoc inherit override constructor parameter base property findBaseOfDeclaration typescript/sync

### 🕗 Version & Regression Information

- This is the behavior of the programmatic API shipped in `typescript@7.1.0-beta` (`typescript/sync` and `typescript/async`); I also reproduced it on the final typescript-go staging commit before that repository closed.
- The classic compiler behaves as expected on every version I checked (5.9.x and 6.0.x), so this is a divergence of the native implementation from the long-standing services semantics rather than a regression within a release line.

### ⏯ Playground Link

Not applicable: the behavior is only observable through the programmatic API, not through type checking or emit. A self-contained reproduction (one TypeScript file plus two small Node scripts that print the same report from the classic API and from `typescript/sync`) is included below and needs only `npm i typescript@6 typescript7@npm:typescript@7.1.0-beta`.

### 💻 Code

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

/** Subclass constructor without JSDoc. */
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

For every parameter symbol (from `checker.getSignatureFromDeclaration(decl).getParameters()`), I compare `symbol.getDocumentationComment(checker)` and `symbol.getJsDocTags(checker)` between the classic API (`ts.createProgram`, `ts.displayPartsToString`) and the 7.1 API (`new API({ cwd }).createSnapshot({ openProjects: [tsconfig] })`, `snapshot.getConfiguredProject(tsconfig).checker`).

```sh
npm i typescript@6 typescript7@npm:typescript@7.1.0-beta
node tsgo-jsdoc-param-run-classic.mjs ./tsgo-jsdoc-param-repro.ts > classic.txt
node tsgo-jsdoc-param-run-ts71.mjs . > ts71.txt      # a tsconfig.json in . must include tsgo-jsdoc-param-repro.ts
diff classic.txt ts71.txt
```

### 🙁 Actual behavior

| Symbol | 7.1 API returns |
|---|---|
| `PlainCapture.test` parameter `actual`, documentation comment | `"the target to match"` — inherited from `MatcherBase.test` even though the override has no JSDoc |
| `Counted` constructor parameter `count`, documentation comment | `""` |
| `Tagged` constructor parameter `key`, tags | `[]` |
| `MatcherBase.test` parameter `actual`, tags | `[]` |

In other words: method parameters inherit `@param` text from base signatures, constructor parameters do not fall back to a same-named base property, and `getJsDocTags` is always empty for parameter symbols.

### 🙂 Expected behavior

The same values the classic services produce for the same program:

| Symbol | classic API returns |
|---|---|
| `PlainCapture.test` parameter `actual`, documentation comment | `""` — `getJSDocParameterTags` only consults the hosting declaration's own JSDoc, so overrides never inherit parameter docs |
| `Counted` constructor parameter `count`, documentation comment | `"How many widgets there are."` — `findBaseOfDeclaration` resolves a constructor parameter against the class's super types and takes the documentation of the same-named property |
| `Tagged` constructor parameter `key`, tags | `[{ name: "param", text: "key The string key for the tag." }]` |
| `MatcherBase.test` parameter `actual`, tags | `[{ name: "param", text: "actual the target to match" }]` |

The relevant classic code is `getDocumentationComment` / `findBaseOfDeclaration` in `src/services/utilities.ts` (for a declaration whose parent is a constructor, the base search runs over the class's heritage clauses and looks up a property named like the parameter; for a method parameter the "class or interface declaration" resolves to the method itself, which has no super types, hence no inheritance) and `getJSDocParameterTags` in `src/compiler/utilities.ts`.

### Additional information about the issue

I ran into this while experimenting with running jsii (the AWS CDK's multi-language binding generator) on the TypeScript 7 programmatic API. jsii derives the parameter documentation in its `.jsii` assemblies from these two methods, and the divergence produced hundreds of member-level differences against the classic output on `aws-cdk-lib`, in both directions (documentation appearing on overridden methods that should have none, and constructor parameter documentation missing). I currently work around it by reading `@param` text from the source text instead of the documentation APIs.

I have a fix ready on a fork branch (`fix/jsdoc-param-resolution` on WinterYukky/TypeScript, based on the `v7.1-beta` tag) that restricts parameter `@param` lookup to the hosting declaration's own JSDoc (with the overload first-signature hop), adds the `findBaseOfDeclaration` fallback for constructor parameters, and makes `getJsDocTags` return parameter tags. With it the reproduction above prints byte-identical reports from the classic API and from `typescript/sync`, the Go test suites for `internal/ls` and `internal/api` pass, and the full `packages/typescript` API test suite passes unchanged. I am happy to open it as a PR once this issue is triaged.
