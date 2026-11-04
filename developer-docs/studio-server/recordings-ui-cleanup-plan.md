# Run recordings UI cleanup plan

Status: complete. Recording-card presentation was completed on 2026-10-04; project navigation and terminology were completed on 2026-11-03. This plan covers the recordings UI, not storage migration or recording capture.

## Completed scope

- [x] Hide `Related run key` on primary recordings, including correlated roots with sub-runs.
- [x] Keep the key on called-project Subgraph recordings for debugging.
- [x] Remove the selected-workflow `Recording scope` label and explanation.
- [x] Preserve correlation metadata, family grouping, expansion, replay and deletion behavior.
- [x] Select root cards by stable recording ID in browser tests instead of removed display text.
- [x] Document the presentation contract in [workflow-publication.md](workflow-publication.md).

## Verification completed

- Prettier and `git diff --check` pass.
- Four headless Playwright regressions pass: root expansion and card presentation; linked child filtering/deletion; filtered root deletion; root deletion with failed catalog refresh.
- Browser assertions verify that root keys and scope text are absent while child keys remain visible.

## Project navigation follow-up (2026-11-03)

- [x] Label the picker **Project** and use project terminology in the subtitle and Any option description.
- [x] Associate the Project label with the existing picker input for accessible naming and click-to-focus.
- [x] Add **Inspect recordings** immediately after Rename in every project context menu, reusing the footer recording icon.
- [x] Open a fresh session scoped to the clicked project's stable ID, clearing retained filters and pagination.
- [x] Keep projects with no recording catalog entry selected with an empty history.
- [x] Preserve temporary dismissal/footer reopening and restore Any after explicit close.
- [x] Document the selection and reset contract in [recording-search-performance.md](recording-search-performance.md).

Six focused headless Playwright regressions passed: mouse project inspection; keyboard inspection of a project without recordings; refresh during catalog loading; explicit-close reset; an empty catalog; and deleting the final recording. The inspection cases hold the catalog response to verify selection through asynchronous loading, and assert menu order/icon, cleared status filters, accessible naming and label focus. Documentation links and `git diff --check` also pass.

No implementation tasks remain for these UI changes. They do not change API responses, persisted recording identities or backend filtering.
