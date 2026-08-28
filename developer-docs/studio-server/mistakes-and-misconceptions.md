# Mistakes and Misconceptions

This document is for substantial mistakes caused by the wrong mental model of how the app works.

Treat it as a policy document, not incident history. Each entry should improve future decisions about:

- where code belongs
- how behavior is verified
- how regressions are debugged
- which layer owns a fix

Do add entries for:

- incorrect assumptions about architecture, build flow, runtime behavior, or ownership boundaries
- failures that can recur unless the team remembers the corrected model
- bugs where the fix matters less than the lesson

Do not add entries for:

- small coding mistakes
- one-off typos
- narrow implementation gaps with no broader lesson

## 1. One repository does not mean one ownership boundary

### Wrong assumption

Because Rivet and Studio Server now share a repository, any convenient package
is an acceptable home for a fix.

### Reality

- the monorepo owns both the Rivet packages and the Studio Server packages
- generally useful editor/runtime behavior belongs in the relevant Rivet package
- deployment, hosted auth, workflow publication, browser hosting, and other
  Studio-specific behavior belongs in the relevant Studio Server package
- hosted overrides remain valid when no public upstream seam can express the
  behavior, but they must stay importer-scoped and covered by contract tests
- sharing a lockfile and commit removes integration machinery; it does not
  erase product and package responsibilities

### What this broke

- published-project save status updates in production
- hosted save toast duplication fixes
- hosted clipboard and focus behavior

### Correct rule

Put behavior in the package that owns its contract. Hosted behavior commonly
belongs in:

- `packages/studio-server-web/overrides/`
- `packages/studio-server-web/dashboard/`
- the API, shared, executor, or bootstrap Studio Server workspace

If the change belongs to Rivet itself, change the owning Rivet package directly
and verify its public consumers. Do not hide a general Rivet fix in a hosted
override merely because the override is locally convenient.

### Prevention

- identify the owning package and public contract before editing
- use public Rivet host/provider/workspace seams before adding an override
- test both the owning package and the Studio Server integration when a change
  crosses their boundary
- keep hosted-only aliases and shims narrow enough that unrelated Rivet imports
  cannot be rewritten

## 2. `yarn studio-server:dev` and `yarn studio-server:prod` do not validate the same thing

### Wrong assumption

If behavior is correct in `yarn studio-server:dev`, it is effectively verified for `yarn studio-server:prod`.

### Reality

- `yarn studio-server:dev` uses the Docker dev stack with live workspace mounts and the Vite dev server
- `yarn studio-server:prod` pulls the published `rivet2.0-studio-server/*` images and force-recreates the stack without building
- `yarn studio-server:prod:restart` force-recreates the stack from already-local images without pulling or building, which is only for picking up `.env` changes without changing the app version
- `yarn studio-server:prod:custom` builds production images from the current monorepo commit

These modes are related, but they are not the same artifact and not the same risk profile.

### What this broke

- production regressions were missed because local dev was exercising current workspace files while prod was running a different built image

### Correct rule

Use the mode that matches the question:

- `yarn studio-server:dev` for iterative development
- `yarn studio-server:prod:custom` to verify the current monorepo commit as production images
- `yarn studio-server:prod` to verify what was actually published
- `yarn studio-server:prod:restart` to re-read `.env` on an already-deployed production-style Docker stack without pulling newer GHCR images

### Prevention

- when dev works and prod does not, suspect an artifact mismatch before blaming caching or browser state
- when testing a hosted production fix, verify both the local production build and the published image path
- do not treat `yarn studio-server:prod` as proof that your local changes are running; it is intentionally the published-image path
- do not use `yarn studio-server:prod:restart` as a deployment/update command; it intentionally keeps the already-local images
- for local unpublished work, prefer `yarn studio-server:prod:custom`
- for deployment verification, prefer `yarn studio-server:prod`

## 3. Keyboard shortcut bugs are multi-layer problems

### Wrong assumption

If the parent document focuses the editor iframe, editor keyboard shortcuts are fully restored.

### Reality

Shortcut behavior can fail at multiple layers at once:

- top-level document focus must move from the dashboard into the iframe
- inside the iframe, focus must still land on the right editor surface and not on a stale button, hidden menu input, or unrelated control
- hidden or recently closed editor-local inputs can still intercept shortcuts
- immediate shortcut handlers can read stale state if they depend on render timing instead of the actual source of truth

Clipboard shortcuts were blocked even when the iframe itself was focused, because the editor-local focus and state path were still wrong.

### What this broke

- `Ctrl+C` / `Ctrl+V` immediately after `Shift+click`
- `Ctrl+C` / `Ctrl+V` after closing context-menu search
- blank-canvas recovery after sidebar focus

### Correct rule

For iframe-hosted keyboard behavior, verify all of these separately:

- parent page focus ownership
- iframe element focus
- editor document active element
- canvas or input focus inside the editor
- whether the shortcut handler sees the latest selection and clipboard state

### Prevention

- do not stop debugging at "the iframe is focused"
- if a shortcut is editor-local, inspect the active element inside the iframe document too
- when recovering focus from sidebar interactions, ensure real text inputs are preserved but stale editor-local inputs are cleared
- for immediate keyboard handlers, prefer reading from the real source of truth or another freshness-safe pattern rather than assuming the most recent render is enough
- test zero-delay sequences such as selection change followed immediately by the shortcut

## 4. UI shortcut and focus regressions need browser automation on the right artifact

### Wrong assumption

Manual spot checks are enough for focus and shortcut behavior.

### Reality

Focus, clipboard, and iframe interactions are timing-sensitive and can differ across dev, local production builds, and published images.

### Correct rule

For UI changes that affect focus, shortcuts, mouse interactions, or iframe behavior, run Playwright before finishing, and run it against the artifact that matches the risk you are validating.

### Prevention

- use the repo runner in headless mode for routine checks
- inspect Playwright trace, screenshots, and video when behavior differs from expectations
- keep an observable headed flow available for debugging, but treat automated verification as the default gate
- encode exact failure sequences in the spec instead of relying on memory
- if a regression only appears in production-style behavior, run the test against `prod:custom` or published images rather than only against dev

## 5. Managed Playwright runs are not disposable by default

### Wrong assumption

Browser automation against a managed stack is automatically a disposable test fixture, so it is safe for UI specs to create real workflows and clean them up however is convenient.

### Reality

- Storage-tab `Object storage` mode means workflow state is authoritative in Postgres plus object storage
- a Playwright spec that hits the real workflow routes is mutating that authoritative state unless it explicitly mocks the API
- cleanup done through ad hoc browser-page `fetch()` calls is brittle because it depends on page state and can fail without going through the same trusted proxy path as the normal browser shell
- UI/controller coverage for modals and tree state often does not need real managed mutations at all

### What this broke

- managed Playwright runs leaked real workflow projects into the shared workflow tree after failed specs

### Correct rule

Default browser-visible specs to non-mutating mocked flows when storage mutation is not the behavior under test.

If a spec really must mutate managed workflow state:

- gate it behind an explicit opt-in such as `PLAYWRIGHT_ALLOW_MANAGED_MUTATIONS=1`
- use shared setup/cleanup helpers that go through Playwright's request context
- keep cleanup explicit and deterministic

### Prevention

- treat managed Playwright runs as real writes unless the spec proves otherwise
- use `requireManagedMutationOptIn()` for mutating workflow specs
- prefer mocked `/api/workflows/*` responses for project-settings, version-modal, and similar controller/UI tests
- keep cleanup helpers on top of `page.request` rather than `page.evaluate(fetch(...))`
- when debugging leaked state, query the workflow tree directly after the spec run instead of assuming teardown succeeded

## Adding a new entry

Use this structure:

1. wrong assumption
2. reality
3. what this broke
4. correct rule
5. prevention

If an issue does not improve the team's mental model, it probably does not belong in this file.

## Pre-merge checklist

Before merging a meaningful frontend or hosted-editor change, ask:

1. does this behavior live in the package that owns its contract?
2. which artifact am I actually validating: dev, local production build, or published image?
3. if keyboard behavior is involved, have I checked both focus ownership and handler state freshness?
4. is there a Playwright check that exercises the exact interaction sequence?
