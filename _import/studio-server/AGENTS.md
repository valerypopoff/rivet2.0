# Codex Workspace Instructions

## UI verification

- After any code change that affects or may affect UI behavior, run a Playwright check before finishing.
- Treat this as required for changes involving layout, focus, keyboard shortcuts, mouse interactions, drag/drop, modals, routing, iframe behavior, or other browser-visible behavior.
- Prefer headless verification for routine checks.
- Use the repo runner:
  - set `PLAYWRIGHT_HEADLESS=1`
  - set `PLAYWRIGHT_SLOW_MO=0`
  - if needed, set `PLAYWRIGHT_BASE_URL` to the current app URL
  - run `node scripts/playwright-observe.mjs test`
- If the user wants to watch the browser live, use headed mode instead:
  - `npm run ui:observe`
  - or `npm run ui:observe:debug`
- On failure, inspect artifacts under `artifacts/playwright/` and summarize the failing UI step clearly.

## New features and significant changes

When adding new features or making significant changes, make sure you loaded into your context the .md docs in the `docs/` folder.

After the feature is implemented or changes are made and tested, make sure you update the relevant .md docs in the `docs/` folder.

## Kubernetes
Don't use the Kubernetes rehearsal for small UI changes and keep verification lighter unless the change is actually Kubernetes-related