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

## 1. `rivet/` is vendor input, not repo-owned code

### Wrong assumption

It is acceptable to implement hosted fixes or product behavior directly under `rivet/` and rely on those edits as part of this repo.

### Reality

- `rivet/` is upstream code that can be replaced by `npm run setup:rivet`
- by default that setup pulls `https://github.com/valerypopoff/rivet2.0.git` at `main`, not the original published Rivet repo
- this repo consumes that code; it does not own or maintain it
- even when `rivet/` exists locally as a checkout or snapshot, that is for inspection, compilation, and compatibility work around it, not for committed repo behavior
- CI builds bootstrap a fresh upstream Rivet snapshot before building images
- changes under `rivet/` are therefore the wrong place for repo-specific behavior

### What this broke

- published-project save status updates in production
- hosted save toast duplication fixes
- hosted clipboard and focus behavior

### Correct rule

Do not implement repo-specific behavior in `rivet/`.

If the behavior belongs to this repo, put it in tracked wrapper code such as:

- `wrapper/web/overrides/`
- `wrapper/web/dashboard/`
- other tracked wrapper files that are part of the real web build

If the change truly belongs to Rivet itself, contribute it upstream instead of carrying a local fork inside this repo.

### Prevention

- treat `rivet/` as read-only upstream input for this repo
- reject the instinct to "just patch it in rivet for now"
- before writing code, ask: "Is this our wrapper behavior or an upstream Rivet change?"
- if it is wrapper behavior, implement it outside `rivet/`
- if it is an upstream change, upstream it properly instead of depending on a local repo-only patch
- never merge a fix whose intended behavior still depends on changes under `rivet/`

## 2. `npm run dev` and `npm run prod` do not validate the same thing

### Wrong assumption

If behavior is correct in `npm run dev`, it is effectively verified for `npm run prod`.

### Reality

- `npm run dev` uses the Docker dev stack with live workspace mounts and the Vite dev server
- `npm run prod` and `npm run prod:prebuilt` pull the published `cloud-hosted-rivet2-wrapper/*` images and force-recreate the stack without building
- `npm run prod:restart` force-recreates the stack from already-local images without pulling or building, which is only for picking up `.env` changes without changing the app version
- `npm run prod:custom` builds production images from the current wrapper workspace and the current `rivet/` folder

These modes are related, but they are not the same artifact and not the same risk profile.

### What this broke

- production regressions were missed because local dev was exercising current workspace files while prod was running a different built image

### Correct rule

Use the mode that matches the question:

- `npm run dev` for iterative development
- `npm run prod:custom` to verify the current wrapper and current `rivet/` folder as production images
- `npm run prod` or `npm run prod:prebuilt` to verify what was actually published
- `npm run prod:restart` to re-read `.env` on an already-deployed production-style Docker stack without pulling newer GHCR images

### Prevention

- when dev works and prod does not, suspect an artifact mismatch before blaming caching or browser state
- when testing a hosted production fix, verify both the local production build and the published image path
- do not treat `npm run prod` as proof that your local changes are running; it is intentionally the published-image path
- do not use `npm run prod:restart` as a deployment/update command; it intentionally keeps the already-local images
- for local unpublished work, prefer `npm run prod:custom`
- for deployment verification, prefer `npm run prod` or `npm run prod:prebuilt`

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

1. does this behavior live in wrapper-owned code, or am I accidentally depending on `rivet/`?
2. which artifact am I actually validating: dev, local production build, or published image?
3. if keyboard behavior is involved, have I checked both focus ownership and handler state freshness?
4. is there a Playwright check that exercises the exact interaction sequence?
