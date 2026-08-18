<!--
PR topology proposal for upstreaming the typescript-go patches
(and the jsii-compiler branch tidy-up). For maintainer/papa review.
-->

# Upstream PR topology proposal

## Current fork state (WinterYukky/typescript-go)

One linear stack, all on top of `draft/api-emit-1784711177`
(= upstream main + #4700 cherry-pick + draft `getEmitOutput`):

```
main (upstream)
 └─ draft/api-emit-1784711177        getFullyQualifiedName (#4700) + getEmitOutput
     └─ ee579abf                     input-keyed checker cache        (2C)
         └─ 21fd26fb + 6571a5e9      getEmitOutput writeToDisk        (2D)
             └─ 332e9bbc             batched getSymbolDocumentations  (2E-1, keeper)
                 └─ b0baeffd         batched getTypeOfSymbolAtLocations (2E-2)*
```
\* 2E-2 is parity-correct but was a wall-clock wash for jsii; the endpoint itself
is still a legitimate API addition.

## Proposed PR split (dependency-ordered)

| # | PR | contents | depends on | notes |
|---|---|---|---|---|
| 0 | **#4700** | `checker.getFullyQualifiedName` | — | **MERGED 2026-08-17.** Done. |
| 1 | **Checker input-keyed cache** | ee579abf, rebased onto upstream main | none | **Fully independent of everything else** — touches only the client (`api.ts`); pure perf, zero behaviour change; easiest merge. Submit first. |
| 2 | ~~**`getEmitOutput` API**~~ | ~~draft emit + writeToDisk + osvfs fix~~ | — | **WITHDRAWN 2026-08-18: superseded by upstream #4699 "API emit"** (merged 2026-07-24), which is functionally equivalent-or-better (server-side write via projectSession.FS(), names-only response, plus emitToString variants). `feat/api-get-emit-output` stays frozen on the fork as the record; jsii's ts7 backend should switch to upstream `emit()` on the next native-preview release. |
| 3 | **Batched `getSymbolDocumentations`** | 332e9bbc rebased onto main | none (independent of 1) | Additive endpoint + client method. Motivated by the −30%-requests measurement. |
| 4 | *(optional)* Batched `getTypeOfSymbolAtLocations` | b0baeffd | 1 (shares the input-keyed cache) | Hold back initially; offer in the perf issue and submit only if maintainers want it. |

Notes:
- 1–3 are **mutually independent** after rebasing onto upstream main (they touch
  disjoint code): they can be reviewed/merged in any order, no stacked PRs needed.
- Each rebased branch should carry its measurement summary in the PR body
  (numbers already in `PHASE1-RESULTS.md` / the perf issue draft).
- Suggested branch names: `feat/checker-input-cache`, `feat/api-get-emit-output`,
  `feat/api-batched-symbol-docs` (fresh branches cut from upstream `main`,
  cherry-picking the commits above).

## jsii-compiler side (`feat/ts7-backend-1784773376`)

- History is meaningful as-is (the phase-by-phase story, including honest
  reverts). **Recommendation: keep the branch intact as the record**, and if/when
  an upstream PR to aws/jsii-compiler is wanted, cut a *new* squashed branch
  (`feat/ts7-backend`) with 3-4 logical commits (scaffolding+toolchain / ts7
  backend / emit pipeline / docs) rather than rebasing this one.
- Not blocking anything today: the #1853 comment links the branch as evidence;
  an actual jsii PR only makes sense after maintainer buy-in on direction.

## Suggested submission order

1. Post the **#1853 comment** (jsii side visibility, links everything).
2. File the **typescript-go perf issue** (context for all PRs).
3. Submit PR 1 (cache) → PR 3 (batch docs), referencing the issue.
   (PR 2 withdrawn — superseded by upstream #4699.)
