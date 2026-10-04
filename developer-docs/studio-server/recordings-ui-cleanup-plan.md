# Run recordings UI cleanup plan

Status: complete (2026-10-04). This plan covers only the recording-card presentation cleanup, not storage migration or recording capture.

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

No implementation tasks remain for this cleanup. It does not change API responses, persisted recording identities or backend filtering.
