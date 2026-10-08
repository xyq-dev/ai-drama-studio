# Creator UI refresh

Date: 2026-10-08

## Scope

Base: `ba56b8ded313314f81d9867470f73779371d23cb` (main, PR #53).
Branch: `feat/creator-ui-refresh`.

This implements the approved warm-white/coral creator interface on the existing beginner routes: `/studio`, `/create`, and the five steps at `/projects/[projectId]/create`.

- Desktop sidebar; mobile navigation drawer with focus trapping, Escape close, focus restoration, and resize/unmount cleanup.
- Real project cards with decorative, title-based covers explicitly labeled `文字封面`. No generated cover or example project is inserted into API results.
- A guided creation form, five-step overview, episode tabs, visible step status markers, and a mobile primary action with content clearance.
- Consistent editor, revision/review, writing-assistant, media, and composition surfaces. Shared editor CSS is scoped to `.beginner`; advanced editing keeps its existing layout.

Existing requests, drafts, If-Match, conflict confirmation, idempotency, review, polling, capability gates, retry, costs, and export eligibility remain in place. No backend, database structure, environment variables, dependencies, lockfile, fixtures, or workflow changes. No migration, SQL draft execution, or paid calls.

Claude Code's separate state-recovery PR #55 was open at the start and was not incorporated or modified.

## Local verification

Runtime: Node 24.21.0, pnpm 10.17.0; engine checks remain enabled.

| Check | Result |
| --- | --- |
| Web unit/component suite | 30 files, 264 tests passed (happy-dom and mocked fetch) |
| Web lint / typecheck | Passed |
| Web production build | Passed, including the final cover sizing fix |
| `m3-av-e2e:check` | Passed |
| `m3-av-e2e:outcome` | 23 passed |
| Python media-worker tests | 9 passed on Linux |
| `git diff --check` | Passed |
| Full `pnpm verify` | Did not pass locally: two existing Qwen CLI subprocess tests fail because this execution environment denies the `tsx` Unix IPC pipe (`listen EPERM`). Full lint (9 packages) and typecheck (14 packages) passed first. No test or product rule was weakened. GitHub CI is required before merge. |

Three new shell regressions cover mobile focus/inert handling, desktop resize, and unmount cleanup. Existing web regressions remain unchanged.

## Browser verification and review

The UI was served from a real Next production build and viewed with Chromium at 1440px and 390px. API reads used explicit test fixtures; writes were blocked. This is visual/interaction verification, not a real backend or media-generation acceptance run. A Chinese font was injected only into the screenshot harness because the execution environment lacks a system CJK font.

Coverage: My Works, Start, and all five creator steps; horizontal overflow, mobile navigation, step status visibility, bottom-action clearance, draft restoration, and card geometry. The first visual pass found a feature-card cover overlapping its body; the CSS was corrected to constrain the cover to its grid column.

Independent agent review found a mobile status visibility issue, fixed by keeping status symbols visible while reducing the text at narrow widths. Follow-up review reported no remaining P0/P1/P2 findings.

## Delivery boundary

Git/CI/merge status is recorded on the associated PR. A successful CI run does not prove the server has changed.

This execution environment has no configured SSH identity, server host entry, or deployment connector for `drama.playhubs.cn`. Deployment is therefore blocked here. The server agent must use the final verified merge SHA, build in an isolated release directory, switch services only after the build succeeds, and verify health, the actual running revision, desktop/390px pages, and the existing data. Do not rebuild `.next` in the directory used by the running web service. Preserve the prior release for rollback; do not execute migrations or SQL drafts.
