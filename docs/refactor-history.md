# Refactor History

This document records intentional architecture and cleanup changes that future maintainers should understand before changing the same area again.

It is not a changelog. Keep entries focused on why a refactor happened, which ownership boundary changed, and which verification paths should be kept alive.

## 2026-05-21 - Test Refactor Final Prune

### Why

After the workflow, static-contract, managed-storage, Playwright, and style-guardrail phases landed, the remaining risk was drift from leftover compatibility files or helper exports that no longer had a real owner. Phase 7 closed that loop without changing product behavior.

### Ownership

- Retired or merged-away suites remain deleted: `workflow-services.test.ts`, `workflow-publication.test.ts`, `phase4-static-contract.test.ts`, and `managed-backend-sql.test.ts`.
- `scripts/verify-test-style.mjs` remains the cheap guard that prevents those suite names and hidden nested test files from returning.
- Shared test helpers should keep active call sites. Do not keep an unused helper as a placeholder for possible future suites; add it back when a real second call site appears.

### Verification To Preserve

- API build: `npm --prefix wrapper/api run build`
- Default API suite: `npm --prefix wrapper/api test`
- Test style guard: `npm run verify:test-style`
- Pure web helper command: `npm run verify:web-pure`
- Repo structure guard: `npm run verify:repo-structure`
- Kubernetes render contracts when static helpers or chart-facing contracts change: `npm run verify:kubernetes`

## 2026-05-21 - Playwright Suite Review

### Why

The browser specs were useful, but a few of them mixed UI/controller contracts with real storage mutation. That made routine Playwright runs heavier and riskier, especially in managed or S3-backed environments where a UI-only assertion should not create durable workflow state.

### Ownership

- `hosted-editor-observe.spec.ts` owns the manual observable hosted-editor focus and clipboard recovery flow. It now mocks workflow tree/project load responses, then opens the real iframe editor without creating or deleting workflow storage.
- `project-settings-modal.spec.ts` is split between publish controls and published-version-history actions, so publish validation/delete ownership does not share one large scenario with history pagination, star, preview, and restore behavior.
- `run-recordings-modal.spec.ts` is split between input filter/pagination/menu-portal behavior and replay/delete behavior.
- Specs that mutate real workflow state remain limited to persistence/path contracts and must keep managed-mode mutation guards explicit.

### Verification To Preserve

- Test style guard: `npm run verify:test-style`
- Repo structure guard: `npm run verify:repo-structure`
- Browser-visible spec changes: `PLAYWRIGHT_HEADLESS=1`, `PLAYWRIGHT_SLOW_MO=0`, `node scripts/playwright-observe.mjs test`

## 2026-05-21 - Managed Publication Test Split

### Why

`managed-backend-sql.test.ts` mixed true SQL/schema invariants with source-string checks against managed publication implementation details. That made publication refactors noisy even when the managed service contract stayed correct.

### Ownership

- `managed-workflow-schema.test.ts` owns managed DDL contracts, folder-move wildcard escaping, published-version schema shape, and published/latest execution lookup query contracts.
- The schema test imports `MANAGED_WORKFLOW_SCHEMA_SQL` instead of reading `schema.ts` as text, so TypeScript template-literal escaping bugs are covered by the same SQL string the app sends to Postgres.
- `managed-publication-history.test.ts` owns managed publication behavior through a mocked transaction context: legacy history backfill, normal and legacy restore-as-new-publish, restore invalidation, star persistence, and save-target selection.
- `managed-backend-sql.test.ts` is retired and should not be reintroduced.

### Verification To Preserve

- Default API suite: `npm --prefix wrapper/api test`
- Test style guard: `npm run verify:test-style`

## 2026-05-21 - Test Style Guardrails

### Why

After the workflow and static-contract suite split, the next failure mode was command drift: a new test file could be forgotten in `wrapper/api/package.json`, Kubernetes tests could slip back into the default API suite, or a temporary `.only` could land because the repo had no cheap style check for test files.

### Ownership

- `scripts/verify-test-style.mjs` owns test command manifests and style guardrails.
- Root `npm run test` must compose the non-browser repo-local gate after the standard `pretest` dependency bootstrap: API build, default API tests, pure web tests, test-style guardrails, repo-structure guardrails, and Kubernetes launcher/chart contracts.
- The default API test command must list every non-Kubernetes API test exactly once.
- `verify:web-pure` must list every pure web test exactly once.
- `verify:kubernetes` owns `kubernetes-*.test.ts` API contract tests plus the Helm render verifier.
- Runnable API, pure web, and Playwright test files stay in their expected top-level suite folders so helper directories cannot become hidden suites.
- Retired mixed/broad suites such as `managed-backend-sql.test.ts`, `workflow-services.test.ts`, and `phase4-static-contract.test.ts` must not be reintroduced.
- Wrapper tests and helpers must not assert upstream `rivet/packages/app/src` implementation shapes beyond the approved host entry/style seam; use wrapper seams, focused helper tests, or `scripts/update-check.sh` for upstream compatibility scanning.

### Verification To Preserve

- Test style guard: `npm run verify:test-style`
- Repo structure guard: `npm run verify:repo-structure`
- Pure web helper command still proves command manifest alignment: `npm run verify:web-pure`

## 2026-05-21 - Static Contract Test Reduction

### Why

`phase4-static-contract.test.ts` had become a second implementation checklist for proxy templates, Dockerfiles, CI YAML, hosted editor seams, upstream Rivet source shapes, UI behavior, docs wording, and Helm chart contracts. That made harmless refactors noisy and kept Helm in the default API test path.

The static coverage is now split by contract boundary, with Kubernetes render checks isolated behind the Kubernetes verification command.

### Ownership

- `proxy-image-contract.test.ts` owns proxy route ownership, proxy timeout behavior, UI-gate prompt staging, API/executor image contracts, GHCR login/tag/publish behavior, and production launcher image behavior.
- `hosted-editor-seams.test.ts` owns wrapper-facing hosted editor seams: `RivetAppHost` mounting, provider injection, workspace command bridge usage, hosted file-menu policy, hosted executor URL wiring, shortcut shims, and stale override removal.
- `kubernetes-contract.test.ts` owns Helm/chart topology assertions and runs through `npm run verify:kubernetes`, not the default API test command.
- The Kubernetes contract also keeps the local image-build path honest: Rivet-dependent local K8s images must receive the filtered `rivet_source` Docker build context.
- `verify:repo-structure` owns structural guardrails such as shell-script LF normalization.
- `verify:web-pure` owns exported web helper contracts such as hosted shortcut matching, Vite override alias selection, and alignment between active module overrides and `scripts/update-check.sh`.

### Verification To Preserve

- API build: `npm --prefix wrapper/api run build`
- Focused static contract run: `npm --prefix wrapper/api exec -- tsx --test wrapper/api/src/tests/proxy-image-contract.test.ts wrapper/api/src/tests/hosted-editor-seams.test.ts`
- Web pure helpers: `npm run verify:web-pure`
- Repo structure guard: `npm run verify:repo-structure`
- Kubernetes render contracts: `npm run verify:kubernetes`

## 2026-05-21 - Workflow API Test Suite Split

### Why

`workflow-services.test.ts` had become a mixed API suite covering workflow-tree mutations, copy/import/export routes, publication state, published-version history, endpoint execution, execution-cache behavior, and recordings. That made future cleanup risky because unrelated workflow contracts lived behind one file name and one local setup block.

The workflow API tests are now split by behavior domain so a future change has an obvious home and can run a smaller focused suite before the full API test command.

### Ownership

- `workflow-filesystem-tree.test.ts` owns filesystem workflow-tree CRUD, sidecars, duplicate/upload/download flows, and their HTTP route coverage.
- `workflow-publication-filesystem.test.ts` owns filesystem publication state, endpoint reservation and uniqueness, full unpublish behavior, and published/latest source selection rules.
- `workflow-published-history-filesystem.test.ts` owns filesystem published-version history, legacy fallback, star/restore behavior, and restore cache invalidation.
- `workflow-execution-filesystem.test.ts` owns filesystem endpoint execution contracts, request context normalization, execution-cache refresh behavior, debug headers, and missing-root recovery.
- `workflow-recordings-http.test.ts` owns recording-producing endpoint runs plus recording list/filter/delete/cleanup route behavior.
- `workflow-filesystem-suite-harness.ts` owns the shared temp-root/env bootstrap, temp-root cleanup, and dynamic workflow-module import ordering for those split suites.

### Verification To Preserve

- API build: `npm --prefix wrapper/api run build`
- Focused split-suite run: `node ../../scripts/run-preserve-symlinks.mjs tsx --test src/tests/workflow-filesystem-tree.test.ts src/tests/workflow-publication-filesystem.test.ts src/tests/workflow-published-history-filesystem.test.ts src/tests/workflow-execution-filesystem.test.ts src/tests/workflow-recordings-http.test.ts` from `wrapper/api`
- Full API suite: `npm --prefix wrapper/api test`
- Repo structure guard: `npm run verify:repo-structure`

## 2026-05-19 - Published Version History

### Why

Publishing a workflow used to behave like a single mutable pointer: publishing overwrote the current stored snapshot, and unpublishing removed that snapshot. That made it impossible to inspect or recover earlier published states after repeated publishes.

The dashboard now treats each successful publish as a durable version-history entry. Project Settings exposes that history so an operator can download, preview, star, or restore notable published versions without reconnecting preview snapshots to the editable source project.

### Ownership

- Filesystem mode stores history under the workflow root's hidden `.published/` directory.
- Managed mode stores history in Postgres `workflow_published_versions`, pointing at immutable workflow revision blobs in object storage.
- The editor preview path is a wrapper-owned virtual path, not a real workflow project path.
- Published-version previews are detached and read-only; they must not become publishable workflow-tree projects.

### Important Details

- Every publish creates a new version id. The current published endpoint points at the newest version, while older versions stay in history.
- Starred state is durable server state, not browser state.
- Restore creates a new current history entry from the selected version instead of moving the current pointer back to an existing row.
- Restoring also replaces the saved live project/dataset with the selected snapshot so the project status remains coherent after restore.
- After restore, the dashboard sends `refresh-open-project-from-disk` for the restored path. If that project is active, the editor replaces the current tab from storage with `reloadFromDisk`; if it is open in a hidden tab, the editor clears that hidden tab's cached snapshot/session so switching back reloads from storage without stealing focus.
- Filesystem restore is not transactional, so the restore path backs up the live project/dataset before overwriting it and restores those bytes plus the old settings if a later published-artifact or settings write fails.
- Filesystem restore rejects a stored snapshot whose embedded project id no longer matches the history owner, which keeps a corrupt history artifact from changing the live workflow identity.
- Legacy already-published projects are backfilled into history before a later publish or unpublish can clear their only current pointer.
- In filesystem mode, the metadata filename is the authoritative version id. A mismatched internal JSON `id` is ignored so a stale metadata file cannot redirect actions to another snapshot.
- Duplicating or uploading a project creates a fresh workflow id, so published history does not copy across.
- Deleting a project deletes its published version history along with live project sidecars and recording history.

### Key Files

- `wrapper/api/src/routes/workflows/published-versions.ts`
- `wrapper/api/src/routes/workflows/workflow-mutations.ts`
- `wrapper/api/src/routes/workflows/managed/publication.ts`
- `wrapper/shared/workflow-types.ts`
- `wrapper/shared/editor-bridge.ts`
- `wrapper/web/dashboard/WorkflowPublishedVersionHistoryModal.tsx`
- `wrapper/web/io/HostedIOProvider.ts`
- `docs/workflow-publication.md`
- `docs/editor-bridge.md`

### Verification To Preserve

- API build: `npm --prefix wrapper/api run build`
- Web build: `npm --prefix wrapper/web run build`
- Filesystem history tests for multiple publishes, legacy backfill, star persistence, restore, and mismatched metadata ids
- Managed SQL/schema tests for `published_version_id`, `workflow_published_versions`, `is_starred`, and restore pointer updates
- Playwright Project Settings modal coverage for history visibility, pagination, star persistence, preview opening, and restore confirmation
