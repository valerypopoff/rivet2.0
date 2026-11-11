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

## Immediate opening follow-up (2026-11-12)

The revised scope removes blocking UI dependencies while retaining existing API
and storage behavior. SQL tuning and a separate lightweight catalog are conditional
follow-ups requiring measurements, not prerequisites for entering or applying a
filter.

- [x] Render Project/Any and filter controls before catalog or initial-page reads finish.
- [x] Keep the Project picker searchable while loading and preserve its query and focus when options arrive.
- [x] Initialize the session and inspected project before requests; never briefly query Any for a project-specific entry.
- [x] Allow Apply to supersede initial browsing, retaining active-search, deletion and replay protections.
- [x] Keep catalog errors/retries independent from results and protect deletion refreshes from stale opening snapshots.
- [x] Distinguish unknown totals from zero; preserve root-only search progress, family pagination and retained orphan-history totals.
- [x] Preserve temporary dismissal, explicit close, Refresh, project selection, input edits and focus.
- [x] Add a reproducible delayed-startup timing fixture and deterministic held-response browser regressions.
- [x] Measure fresh and retained opening separately and prove reopening adds no requests.
- [x] Verify compiled-worker cold startup separately instead of treating mocked browser timings as warm-worker evidence.
- [x] Complete local validation and record the final results below.

The implementation and measurement boundaries are documented in
[recording search performance](recording-search-performance.md#immediate-modal-interaction-november-12-2026).

Validation: the full 88-case browser suite passed, including the late-arriving
picker regression and delayed-startup timing check, along with 20 unit tests. The production web build, targeted
lint, formatting, test-style and documentation-link checks passed. Differential
typechecking found no added diagnostics (the broad existing web check has 53).
In the five-second delayed-response fixture, median time to filtered results
fell from the 10.66-second baseline to 1.95 seconds. No production speed claim,
database change or cloud activation is included.

### Reconciliation with the approved seven-step plan

| Plan item                                           | Implementation and evidence                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Separate opening, project-choice and result timings | The browser fixture measures fresh controls, catalog arrival and first filtered results, then retained controls/results. Three follow-up runs preserve the session without another request. Compiled-worker cold/warm timings are measured separately. |
| Controls independent of metadata                    | Project/Any and filters render before responses; counts and progress remain unknown until reported.                                                                                                                                                    |
| Initialize before issuing requests                  | The session generation and initial project gate the first requests. Project-inspection regressions reject an accidental Any request.                                                                                                                   |
| Preserve request/lifecycle ownership                | Catalog, retry, deletion, Refresh and retained-session tests cover late responses and committed deletions. Explicit close ends the session.                                                                                                            |
| Apply supersedes initial browsing                   | Held-response tests prove a filtered result arrives before catalog/browse completion and their late responses cannot replace it.                                                                                                                       |
| Optimize the server only with evidence              | No API/query/schema change is needed to unblock controls. A lighter catalog remains conditional on measured project-choice latency after deployment; synthetic delays cannot justify that rewrite.                                                     |
| Local concurrency and compatibility validation      | Browser coverage preserves orphan history, empty projects, root-only counts, family pagination, Stop, replay and deletion; compiled-worker tests cover immediate preparation and failure recovery.                                                     |

All local implementation steps are complete. The fresh-control half-second goal
and actual production project-choice latency are not claimed as achieved: the
next authorized deployment must measure them. No database or catalog rewrite is
implicitly required by this checklist.

The completion audit reran the updated timing case three times and five related
browser journeys. All passed, as did the API build and nine compiled-worker
regressions. Release preparation also passed all 88 browser cases against the
production build with the CI configuration, all 275 web package tests and the
root style checks. The normal editor CI shards now include this modal suite;
fixture startup rejects unexpected API traffic instead of using an ambient
server.
