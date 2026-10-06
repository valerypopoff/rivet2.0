# Scheduled runs

The calendar-icon sidebar action immediately before Settings opens
`ScheduledRunsModal.tsx`. Schedules are durable
control-plane work, not browser timers or public endpoint self-requests. Closing
the browser does not stop work; the server must be online.

## Dashboard controls

The list and separate Add/Edit dialogs participate in the shared Studio Server
black-backdrop/dark-surface theme. Each header and close control stays visible while content scrolls;
the two-column form becomes one column on narrow screens. Project/details,
timing and execution settings have separate headings. Buttons, selects and
checkboxes use the existing Atlaskit components, not native OS controls.
Select labels explicitly target their input IDs; the project hint is associated
with its input. Field-box CSS applies only to direct text fields, not selects'
internal inputs. Pending operations mark the region busy and disable editing;
previewing never changes the Save label to claim a save is in progress. A
successful action/list refresh immediately clears a retired polling error.
The modal tracks the currently open select by input ID: Escape closes its menu
without dismissing the draft; a retired menu's close event cannot retire a newer
menu. With no menu open, normal modal Escape behavior remains. Preview and Open
recording use the same busy/error guard but do not fetch the schedule list or
report an acknowledged mutation after their read-only operation.

Add and Edit open `scheduled-run-editor-modal` over the unchanged list/history
dialog, using Atlaskit's modal stack. After the list focus lock reactivates,
explicitly restore the originating Add/Edit control (or list Close if that
control disappeared through concurrent deletion). Cancellation/Close
discard only the draft and return to the list; Escape with a select open dismisses
only that menu. Save/Preview disable closing until their response settles, avoiding
late results affecting a dismissed or replacement draft. Failed/uncertain saves
retain the draft and request-ledger semantics; acknowledged saves close the editor
and refresh the list. Polling cannot replace an open draft.

`ScheduledProjectSelect.tsx` follows the Subgraph Other projects control's
expand-in-place folder interaction. Nested folders are indented and toggle
without selecting a runnable target or closing the menu. Only project rows select
a target; schedules always run its main graph, so there is no graph-selection step.
The selected project's ancestors expand on opening. Project rows have icons and
visible filenames. Search matches project names and paths; identical display names retain separate
project IDs. Search reveals matching descendants of collapsed folders without
altering persistent expansion state. The picker retains an
unavailable saved project visibly rather than silently substituting another.
`scheduledProjectOptions.ts` owns normalization/hierarchy/natural sorting without
mutating the tree data. The observable scheduled-runs regression checks folder
expansion/search/keyboard selection, separate editor/focus restoration, sidebar
order/icon, custom controls, modal colors and narrow-screen layout
alongside its existing real-API save/execution/restart coverage.

## Guarantees and owners

- `calendar.ts`: once, elapsed interval, daily, weekly, monthly and next-five preview
  use the same explicit IANA-zone calculator. DST gaps are skipped and repeated
  times run once (first instant). Ambiguous/nonexistent one-time dates are rejected,
  including normalized invalid dates such as February 30. Absent monthly days are
  skipped. Interval anchors require an explicit UTC offset and a real calendar
  date; they do not drift with execution completion.
- `store.ts`: queue decisions are transactional. SQLite uses WAL, FULL synchronization,
  a shared per-file in-process queue and `BEGIN IMMEDIATE`. PostgreSQL uses a
  transaction advisory lock and database time. No external IO occurs in transactions.
  Due occurrence IDs include schedule ID/revision/instant; manual runs/retries get
  fresh IDs. Edits/deletion require revision preconditions and cancel queued/claimed
  work, not already-running graphs. Missing projects can still be paused/deleted.
- Create, Run now and Retry require a UUID `requestId`. Intent fingerprints and
  successful response receipts commit atomically with the action, in SQLite and
  PostgreSQL. Repeated requests return the original acknowledgement even after
  completion/deletion; a different intent using the same ID gets 409. Receipts
  survive restart/import and last at least 24 hours (active occurrences retain
  theirs longer). The bounded ledger rejects new requests at 10,000 receipts
  or a conservative 64 MiB receipt budget instead of evicting live
  acknowledgements. Clients must not retry an uncertain
  action beyond the 24-hour window. The modal retains uncertain keys through
  closing/reopening; a full document reload requires reviewing refreshed state.
- `scheduledRunApi.ts` owns the page-scoped request ledger. JSON syntax alone is
  not an acknowledgement: Create requires its saved ID/revision, and Run/Retry
  require an occurrence ID, schedule ID and known status. Malformed/empty success
  replies retain the key. Retired replies may clear only their own key, never a
  newer same-intent action. List reconnection dismisses only its stale accepted-
  action warning; validation/conflict errors are not hidden.
- Claims expire after 60 seconds, renewed every five seconds. Acceptance is durable
  before processor invocation. Unaccepted expired claims can be reclaimed; accepted
  worker loss becomes interrupted, outcome uncertain, never automatic retry. Late
  workers cannot overwrite that evidence. Explicit retry warns about external side
  effects and uses the earlier input snapshot. This is not exactly-once execution
  of external services: `context.schedule.occurrenceId` is available for idempotency.
- Missed work defaults to skip with 60-second start grace. Catch-up selects only the
  latest due instant. One pending/running occurrence prevents ordinary overlap.
  Capacity lateness is bounded to 15 minutes. SQL-wide concurrency defaults to one;
  `RIVET_SCHEDULED_RUNS_MAX_CONCURRENT=1..8` must be consistent across control replicas.
  Timeout is 1–1,440 minutes including preparation. Limits: 1,000 schedules, 1 MiB
  input each, 1,000 terminal history entries (300 returned, 100 displayed).

## Execution and recording wiring

`runner.ts` captures saved latest/published by project ID through the authoritative
Subgraph target resolver. Missing/ambiguous identities and invalid main graphs fail.
Unsaved browser drafts are never used. `hosted-processor.ts` shares endpoint runtime
policy: managed Code libraries, environment, native IO, references, cross-project
Subgraphs, datasets, profile health and cancellation. Scheduled runs await full
completion; HTTP endpoints retain early-output behavior. Interactive User Input
fails promptly because scheduled runs have no interactive browser owner.

Blank input omits the `input` port; `{}` sends an empty object. Input may contain
secrets, so never log it or raw provider/Code exceptions. Recording requires both
the schedule toggle and server recording enablement. Root/child replays share the
occurrence correlation key. The `scheduled` surface and schedule/name/occurrence
identity survive every metadata reader. Scheduled roots are excluded from endpoint
statistics. Retention uses schedule ID, not its renameable name. Recording/profile
health failures do not turn graph success into failure or trigger execution retry.
An outcome database write failure likewise never fabricates a graph failure or
replays it. The accepted lease is reconciled as interrupted/outcome-uncertain when
it expires; a successfully committed outcome remains authoritative.

## Persistence, maintenance and restore

Combined/control profiles start the scheduler only after runtime libraries,
reconciliation and server startup are ready, so overdue jobs cannot race bootstrap.
Maintenance fences new claims and
includes preparation/execution in the storage drain.
All schedule mutations (Create/Edit/Delete/Run now/Retry/Cancel) also hold that
drain until their asynchronous handler settles, including after a browser
disconnect. Response closure is not a durable-write acknowledgement. New
mutations are rejected while paused; an already-admitted commit must finish
before the migration can certify a frozen source.
Paused startup defers opening/binding the schedule database and automatically
initializes after writes resume, without requiring a browser or mutating the
frozen source. Initialization is itself included in the drain.
Shutdown uses one grace deadline for initialization, polling and execution, then
allows five seconds to unwind. Concurrent shutdown callers share one promise.
Stores remain open under late cleanup until it settles. Preparation waits observe
cancellation even when underlying IO cannot; late processors are disposed and
ownership is checked before execution. Accepted runs are not detached merely to
free a slot. Subsequent worker-loss recovery is durable.
Scheduler startup is idempotent and polling is single-flight, including explicit
ticks. Shutdown tracks an in-flight claim even when it was not started by the
poll timer, and storage errors do not skip shutdown cleanup.

Local state is `scheduled-runs.sqlite` in selected operational storage or legacy
app data. Existing authority is checked before DDL. SQLite schema version 1 adds
the request-receipt ledger. The exact original unversioned three-table schema
upgrades automatically on writable startup; unmarked four-table databases are
adopted without replacing their receipts. The DDL and `user_version=1` marker
commit together under `BEGIN IMMEDIATE`, preserving schedules, history and the
installation binding. Unsupported versions, unrelated tables, incomplete base
schemas and missing tables in marked databases fail closed without repair.
Read-only backup/copy verification recognizes the original schema without
modifying a frozen source; upgrade happens only when normal writable serving
opens its selected copy. Unversioned files cannot distinguish an original
three-table database from one whose newer receipt table was removed; the version
marker makes that distinction reliable after adoption. Never delete a scheduler
database to fix a startup schema error.
Fresh initialization/local copy
create and certify this domain. Capacity/source fingerprints include existing
schedule databases while absent databases preserve old fingerprint compatibility.
Certificates accept the optional new domain without rewriting older certificates.
Coordinated backups must include this database and WAL. Managed schema migration
**14** (the unreleased scheduled-runs migration) adds the tables/indexes, request
receipts and recording identity column; serving never performs
PostgreSQL DDL. Initialization probes all four schedule tables, including the
acknowledgement ledger, before starting work. Helm compatibility is 14. SQLite-to-managed import preserves history
but disables schedules and retires queued/running work; verification compares this
intentional safe transformation.

An independent local control identity binds the schedule DB. Restoring app data
under a new control identity pauses schedules. UI-managed roots reuse their UUID
(hashed legacy key for old configurations); manual roots own `scheduler-installation-id`.
A clone containing the **same control identity** cannot be distinguished from its
original: keep clones offline and pause schedules before starting them. This is not
fencing between independent databases. Review and enable restored schedules manually.

## Verification

```powershell
yarn build:runtime
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/scheduled-runs.test.ts src/tests/scheduled-run-execution.test.ts src/tests/managed-workflow-schema-migrations.test.ts
# Owns an isolated loopback-only PostgreSQL Docker container; no deployment credentials:
yarn workspace @valerypopoff/rivet-studio-server-api test:scheduled-managed
$env:PLAYWRIGHT_HEADLESS='1'
$env:PLAYWRIGHT_SLOW_MO='0'
yarn studio-server:ui:observe scheduled-runs.spec.ts
```

The browser fixture drives the dashboard through an isolated, authenticated real
API process and scheduler. It drops Create/Run now/Retry acknowledgements after commit,
verifies safe retry and executes a real root → cross-project child with both
recordings. The same owned server process fixture is stopped and restarted without
reseeding its data to verify durable schedules/history. It also checks stale edits,
accepted mutations followed by list outages, and cancellation of a real waiting
HTTP node. Other dashboard bootstrap services remain mocked. The
execution fixture runs a real root → cross-project child with recordings on/off.
It also exercises authenticated HTTP mutations, revision/input/body limits and
paused startup with automatic initialization after resume.
The HTTP fixture also holds a schedule commit across client disconnect and
maintenance entry, verifying that the drain remains blocked until commit and
that new mutations are rejected without losing the admitted action.
The Docker gate verifies real PostgreSQL migration, replica claims, lost-worker fencing and the
SQLite import's disabled/interrupted safety transform. The existing managed
deployment-contract CI lane runs this gate; local invocation is opt-in.
Deterministic tests cover calendar boundaries, competing claims, corruption, stale
leases, CAS, overlap, maintenance, catch-up, acknowledgement restart/deletion,
cancelled/late preparation, bounded shutdown (including late recording cleanup)
and restored installation binding. Receipt expiry retains active work; count and
byte budget rejection is tested for atomic rollback and successful recovery.
An injected outcome-commit failure verifies that graph success is not rewritten
as failure and that only one execution occurs.
`scheduled-run-api.test.ts` runs in the regular web suite and covers malformed
acknowledgements, retired-response races, definitive/uncertain HTTP errors and
the client ledger's age/count limits with deterministic request fixtures.
Also run affected first-start/copy/recording suites and both test-style guards.
Run checks that rebuild Core (including root `test:style`) before, not alongside,
API/browser fixtures: replacing shared `dist` output during a fixture restart
can produce a missing-module failure unrelated to the feature under test.
Real PostgreSQL/deployment resource qualification is separate from unit coverage.
