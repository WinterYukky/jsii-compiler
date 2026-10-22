# Patches for the server-side batched documentation experiment (TypeScript 7.1)

Measurement setup for deciding whether a dedicated server-side
`checker.getSymbolDocumentations` endpoint is worth proposing to
microsoft/TypeScript, after the client-side `api.batch(all(...))` path turned
out slower than per-symbol requests on `typescript@7.1.0-beta`.

- `typescript-7.1-batched-symbol-docs.patch` — `git am`-able commit on top of the
  `v7.1-beta` tag of microsoft/TypeScript (3e9236361). Adds the
  `getSymbolDocumentations` method (Go server handler + proto, async client,
  regenerated sync client and proto typings, tests). Mirrors the earlier
  typescript-go branch `feat/api-batched-symbol-docs`, adapted to the 7.1
  `SymbolReference` handles and the generated sync API.
- `jsii-ts7-batched-docs-feature-detect.patch` — local-only change to
  `src/ts7/assembler.ts` on `feat/ts7-backend`: with `JSII_TS7_BATCH=1`, use the
  server-side endpoint when the loaded TypeScript package has it, otherwise the
  client-side `api.batch` combinator. Not pushed to the PR branch until the
  measurement decides whether it is worth keeping.

Build the patched toolchain from a `v7.1-beta` checkout with
`npx hereby build && npx hereby build:api` and point jsii at the result with
`JSII_TS7_TYPESCRIPT=<path to built npm package dir>`.

## Parameter JSDoc resolution fix (TypeScript 7.1)

- `typescript-7.1-jsdoc-param-fix.patch` — two `git am`-able commits (fix + test) on top of the `v7.1-beta` tag of microsoft/TypeScript, porting the classic `getJSDocParameterTags` / `findBaseOfDeclaration` semantics to `internal/ls/jsdoc.go`. Also pushed as `fix/jsdoc-param-resolution` on WinterYukky/TypeScript. Issue and PR drafts: `../tsgo-jsdoc-param-issue.md`, `../tsgo-jsdoc-param-pr-body.md`.
