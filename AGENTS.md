# Codex Workspace Instructions

## UI verification

- After any code change that affects or may affect UI behavior, run a Playwright check before finishing.
- Treat this as required for changes involving layout, focus, keyboard shortcuts, mouse interactions, drag/drop, modals, routing, iframe behavior, or other browser-visible behavior.
- Prefer headless verification for routine checks.
- Use the repo runner:
  - set `PLAYWRIGHT_HEADLESS=1`
  - set `PLAYWRIGHT_SLOW_MO=0`
  - if needed, set `PLAYWRIGHT_BASE_URL` to the current app URL
  - run `yarn studio-server:ui:observe`
- If the user wants to watch the browser live, use headed mode instead:
  - `yarn studio-server:ui:observe`
  - or `yarn studio-server:ui:observe:debug`
- On failure, inspect artifacts under `artifacts/playwright/` and summarize the failing UI step clearly.

## New features and significant changes

When adding Studio Server features or making significant changes, load the relevant Markdown docs under `developer-docs/studio-server/`.

After the feature is implemented or changes are made and tested, update the relevant Markdown docs under `developer-docs/studio-server/`.

## Kubernetes
Don't use the Kubernetes rehearsal for small UI changes and keep verification lighter unless the change is actually Kubernetes-related
