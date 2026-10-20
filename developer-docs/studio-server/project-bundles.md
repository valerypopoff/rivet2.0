# Project bundles

## Explicit Studio Server containers

PostgreSQL/S3 installations support **New bundle** and **Convert to bundle**.
Creation is available through the library's **+ New bundle** action. Folder context
menus offer **Convert to bundle**, not nested creation; the conversion action uses
the same bundle icon as the project tree. **Upload bundle** is available only outside
bundles. A bundle root and every ordinary folder beneath it hide that action;
**Upload project** remains available there.
A bundle owns every descendant project, including disconnected projects and ordinary
subfolders. It has no entry/main project. Ordinary folders may contain bundles,
but bundles cannot nest. Existing folders are not converted automatically.
Conversion back to an ordinary folder removes grouping only. Projects, references
and publications survive; only empty containers can be deleted.

**Convert to bundle** validates every descendant project's saved draft, endpoint
publication and independently pinned published web-app snapshots before changing
the folder. Each distinct revision is read once. Authored cross-project bindings
(Subgraph nodes, legacy references/aliases, Library source nodes, disabled nodes and
saved variants) cannot target a project in another explicit bundle. Internal targets
and ordinary external projects remain allowed. A 409 response identifies the caller,
saved version, target and other bundle. Conversion failures open a persistent,
accessible modal, not a toast, without optimistically changing the tree. The
`bundle_cross_bundle_reference` error code selects specific repair guidance:
retarget calls, save drafts and republish/unpublish affected endpoint or web-app
snapshots, then explicitly retry conversion. Other errors retain their details
and warn that a lost response needs a tree refresh before retrying; they do not
claim a write was rolled back. The shared modal provides backdrop, focus trapping,
Escape/close actions and a scrolling body with a visible footer on short screens.
Closing never retries a request. Local-upgrade prompts stay suppressed while it
is open. The browser regression covers actionable errors, no duplicate toast,
explicit retry/reopen, keyboard dismissal and long diagnostics on a short viewport.
Unsaved editor content is not inspected or saved automatically; missing Library
definitions do not hide other authored bindings.

`managed/bundle-conversion.ts` reads immutable project blobs outside topology/row
locks, with at most 256 members and 128 MiB across selected saved snapshots; datasets
are not downloaded. Before assigning the bundle ID, the existing topology lease
and member row locks protect a recheck of paths, draft/endpoint/web-app revisions and
current target membership through commit. Concurrent source edits require a retry;
concurrent target conversion/moves cannot bypass the final membership check.
Web-app publication/unpublication also locks its workflow row, fencing changes to
independent app revision bindings until conversion commits. Unreadable/mismatched
source revisions fail closed; parse failures identify the project/version without
logging or returning snippets from its contents. Conversion back to ordinary
folders and idempotent requests for an existing bundle do not scan project blobs.
This guards new conversions, not an automatic repair of existing invalid bundles
or a global reference lock on subsequent authoring/moves. Empty bundle creation is
unchanged. Regression owners: `managed-bundles.test.ts`,
`remap-bundle-project.test.ts`, the real PostgreSQL/MinIO explicit-bundle contract,
and the rejected-conversion case in headless `explicit-bundles.spec.ts`.

Focused verification from the repository root:

```sh
yarn workspace @valerypopoff/rivet-studio-server-api test:files src/tests/managed-bundles.test.ts src/tests/remap-bundle-project.test.ts src/tests/project-bundle-import.test.ts src/tests/project-bundle.test.ts src/tests/managed-subgraph-access.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api test:async-managed
yarn studio-server:ui:observe explicit-bundles.spec.ts
```

The integration command provisions and removes only its own disposable local
PostgreSQL/MinIO containers. The browser command uses the local application or
preview at `PLAYWRIGHT_BASE_URL`; set `PLAYWRIGHT_HEADLESS=1` and
`PLAYWRIGHT_SLOW_MO=0`. Its API fixtures do not send conversion writes to a live
deployment. No Kubernetes rehearsal or database migration is required for this guard.

Bundle creation/duplication and ordinary folder creation/rename validate their
complete destination through the same folder-path rules used by later operations.
In particular, folder names ending in `.rivet-project` are rejected before storage
work rather than creating containers that folder APIs cannot address. Import also
checks every declared workspace folder against server path/name rules before
preparing projects; it rejects non-canonical names instead of silently merging or
renaming folders. No database migration is needed for these checks.

Desktop cross-project target bindings remain read-only in the editor, but are
executable from an extracted portable bundle (or a compatible project loader).
The node's helper text must not imply that Studio Server is required to run them.
The desktop bundle Playwright check covers this message and actual child execution.

### Subgraph encapsulation

Bundled projects may be targeted through Subgraph only by projects in the same
explicit bundle. Ordinary projects remain reusable from both ordinary and bundled
callers. A bundle has no entry project; published endpoints can still start any
published member directly. This rule is graph-reference policy, not a new user
authorization boundary or a restriction on opening projects.

The Subgraph **Graph source** control offers **This project**, **Same bundle**
(only for bundled callers), and **Other projects**. Same bundle lists all sibling
members, including nested folders; the picker starts at the bundle's contents,
omitting the bundle root and its ordinary ancestors. Other projects lists only ordinary projects
and preserves their folder hierarchy.
Old saved internal targets are displayed under Same bundle without rewriting them.
After conversion to an ordinary folder, a saved Same bundle hint displays as Other
projects, preserving usable ordinary calls instead of stranding the selector.
The same applies when only the target moves out of the bundle. Once the catalog
has loaded, actual selected-target membership takes precedence over that UI hint;
an unselected Same bundle picker retains its chosen mode. The settings source
buttons and graph dropdown share one tree snapshot and refresh together when the
dropdown opens. Caller membership changes invalidate the tree and pending target
requests, without editing authored references or marking the project dirty.
Changing source clears the previous target intentionally. Missing/inaccessible
targets retain their saved IDs and wire boundary for repair; saving unrelated edits
does not silently remove or retarget them.

Shared preview definitions remain available for displaying existing ports and
wires, but are not permission to select a graph. Each dropdown visit refreshes
the catalog and its visible expanded projects. Graph choices stay disabled until
that project's current preview succeeds; pending or failed reads cannot reuse an
older cached boundary. Readiness is tracked per project/version, so one successful
preview cannot clear another project's failure. A catalog-refresh failure removes
the stale choices instead of presenting them as current. Closing/reopening retries
without modifying the saved node; ordinary local node-body selectors still avoid
catalog requests.

`SubgraphProjectTarget.callerProjectId` is additive transient metadata assigned by
Core from each actual graph owner, never trusted from node data. The managed
`subgraph-access.ts` owner checks target/caller membership in one live SQL statement,
using workflow-ID lookups plus bundle ancestors, without reading revision blobs.
Browser previews/execution and Node executor requests include the caller ID;
requests without a caller cannot load a bundled target through those HTTP routes.
Internal root snapshot selection for endpoints, schedules and maintenance remains
available without a caller. It does not authorize any subsequent graph edge.

The loader's optional `validateTarget` hook rechecks cached targets too: an allowed
caller must not authorize a different nested caller sharing that snapshot. API,
hosted Browser, hosted Node and Evaluation loaders implement it. Ordinary custom
loaders stay source compatible. Access checks are not cached across runs or topology
changes. A move/conversion can therefore invalidate an old outside call; the next
run fails clearly instead of selecting a different project. In-flight graph runs
are not protected by a topology lock or retroactively aborted.

Hosted Node permission checks are service requests, not browser operator sessions.
The API operator gate admits only authenticated executor **GET** requests to
`/api/workflows/subgraph-projects/:projectId/execution` and `/access` (in addition
to the executor's other explicitly listed service routes). Both the proxy and
executor tokens are required; this works with key or OAuth UI authentication,
without a UI cookie or trusted-client bypass. The route still checks live bundle
membership and caller identity. Do not replace this with a broad Subgraph-route
or `/api` exemption, remove cached-target validation, or forward operator cookies
from the executor.

Managed bundle-policy denials carry `subgraph_bundle_scope_forbidden`. The hosted
loader reports a same-bundle restriction only for that explicit 403 code; generic
401/403 responses identify service authentication/access failures instead. Missing
targets, service failures and connection failures are distinct. Permission checks
require 204, use a deadline, and do not follow redirects. Error-body inspection is
bounded and never displays raw upstream HTML, credentials or arbitrary messages.
An unpublished target selected as **Published** returns the existing API status
409 with `workflow_publication_missing`, not 404. The hosted loader recognizes
that exact status/code/selection combination and asks the user to publish the
target or choose **Saved latest**. Other conflicts stay generic; changing only
an HTTP status or error message cannot masquerade as a bundle/publication decision.

Regression ownership: `trusted-clients.test.ts` exercises the real operator gate
in key and OAuth modes with no UI session/trusted IP, including wrong/missing
service credentials and neighboring routes/methods. Executor
`subgraphProjectLoader.test.mts` covers transport, domain-error classification,
caller/version preservation, published snapshot datasets/revision identity,
cancellation of oversized/stalled denial bodies, missing publication diagnostics
and fail-closed responses. The required browser lane
includes `hosted-subgraph-auth.spec.ts`: it creates its own local PostgreSQL and
MinIO containers, an authenticated real API and the built hosted Node executor.
Both single-host and replicated executor configurations are exercised; the latter
uses the real HA session handshake and derives service URLs from its loopback
runtime-config URL. This is a local protocol/auth proof, not a cluster-rollout test.
Two Subgraphs call different graphs of one sibling and return distinct values;
each cold single-node call, whole-graph runs, repeated runs and a warm single-node
call must succeed. A never-published sibling is also exercised through the real
API and editor, checking the actionable publication failure before returning to
a valid graph. Moving the target to another bundle between its
snapshot read and cached permission check must fail. Its internal `/access`
requests are real HTTP requests, never Playwright mocks, and have no operator
cookie. The test proxy preserves those actual service headers rather than repairing
missing/wrong credentials; negative requests verify that distinction. Each repeated
run must deliver fresh root completion and Subgraph result events, not merely retain
the previous run's successful node styling. The fixture removes only its own child
processes, exact containers and their image-created anonymous volumes, and verifies
that the recorded test volumes are gone. It never prunes Docker or deletes unrelated
volumes. Diagnostic attachment failures cannot skip runtime cleanup.

To reproduce locally, build the API and hosted executor first, serve the web
preview on loopback, then run:

```powershell
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:5174'
yarn studio-server:ui:observe hosted-subgraph-auth.spec.ts
```

Docker must be available for this fixture. No cluster, production credentials,
ambient database/bucket or paid provider rehearsal is used. API test enrollment
and the executor package test commands run the focused regressions in existing CI
lanes. `test:source` remains safe for the source-only repository-contract lane;
`test:runtime` runs after compiled Core/Node artifacts are restored in the web-test
lane. The package's `test` runs both locally. No new deployment step or database
migration is needed.

A passing local proof does not update an installed server. Release the API and
hosted executor together through the normal pinned-image CI/deployment workflow.
This service-auth fix needs no project edits, bundle recreation or republishing;
adding an operator cookie to executor requests is not a workaround. Until that
release is deployed, an older server can still deny service-only `/access`
requests even though an operator-authenticated request for the same caller passes.

Capability-4 portable manifests enforce the same member/ordinary boundary during
closure validation, including editable Desktop entry overrides. Server exports
also validate actual source membership before collection and final publication,
so another bundle's project cannot be smuggled in as an ordinary dependency snapshot.
Legacy referenced-graph aliases are unchanged; this policy applies to Subgraph nodes.
Regression owners: `subgraphBundleScope.test.ts`, `managed-subgraph-access.test.ts`,
the Core cached-caller test, `project-bundle-import.test.ts`, the real PostgreSQL
explicit-bundle integration matrix and headless `subgraph-bundle-scope.spec.ts`.
The picker regression covers a target moving out and back while settings stay
open, unchanged save state, and conversion of the caller's bundle to a folder.
It also holds then rejects a cached preview and verifies that another sibling's
successful preview does not re-enable that failed graph choice. Clicks on those
disabled choices and a failed catalog refresh preserve the clean project; reopening
after recovery restores usable choices.
The same tests assert that Same bundle omits its root/ancestors while retaining
nested member folders. `explicit-bundles.spec.ts` checks conversion icon parity,
absence of folder-scoped creation, and upload visibility at ordinary ancestors,
prefix-sharing siblings, bundle roots and descendants. The real managed round-trip
contract rejects both legacy and capability-4 uploads at a bundle root and nested
folder and verifies that rejected imports do not change the catalog.

Migration 16 adds nullable, unique `workflow_folders.bundle_id`. Membership is
derived from the hierarchy into tree/editor bindings, not stored in project files.
The tree advertises `capabilities.explicitBundles`; filesystem/SQLite compatibility
backends reject new container operations. Folder moves retain the UUID. PostgreSQL
topology locks and deferred constraints reject nesting through predecessor folder
operations too, checking final paths rather than temporary move prefixes. Startup
verification checks the column, uniqueness and enabled trigger/function bodies.
Ordinary folders skip deferred ancestry scans. Execution and recording writes do
not acquire the topology lock. Saving an existing project also leaves its folder
chain untouched: the workflow row lock protects its current location, and saves
must not acquire topology after that row lock. The managed integration regression
holds a topology lease while both unchanged and edited full-service saves finish;
checking only the final workflow UPDATE would miss folder-preparation regressions.

Legacy restore recognizes only the four source-owned topology triggers, matching
their full PostgreSQL trigger definitions and function bodies, public namespace,
language, invoker security and absence of function-local configuration. A matching
name is insufficient: custom triggers, altered guards, cross-table dependencies,
RLS and inheritance still block replacement before deletion. Migration SQL and
checksums are unchanged; the restore boundary accepts the guards already installed
by migration16. The disposable PostgreSQL/MinIO migration test covers successful
restore plus changed bodies, security/configuration, disabled/replaced/custom
triggers and an unrelated table referencing Rivet. Unrelated SQL/S3 sentinels
must survive the complete import/verification cycle.

Authenticated POST operations under `/api/workflows/bundles` provide creation
(`/`), conversion (`/kind`), preview (`/:id/preview`) and duplication
(`/:id/duplicate`). They require `X-Rivet-Bundle-Intent: 1`, reject cross-site
requests and use maintenance-owner routing. Preview fingerprints hierarchy,
membership and selected revisions; duplication rechecks under topology/member locks.

**Duplicate bundle** copies all members and preserves subfolder layout. Saved latest
is the default; Published selects published revisions with explicit saved-latest
fallback for unpublished members. Opened unsaved members are identified; copying
their saved versions requires acknowledgement, never an implicit editor save.
An unavailable editor, predecessor browser, or capture omitting a saving/loading
tab is not evidence of clean edits. The additive `editCheckComplete` capture flag
must be true to skip that acknowledgement; otherwise the dialog explicitly asks
to copy stored revisions without a complete edit check. Revision fingerprints
still protect against source saves that finish before duplication commits.
The shared `remapBundleProject` helper assigns fresh project identities and remaps
internal Subgraph/legacy references, prefab sources and saved variants. Graph/node/
port IDs survive. Internal targets become saved-latest; external targets and their
version settings remain shared. Dataset ownership is remapped without changing rows
or dataset IDs. Unfinished variants survive; Code strings and URLs are not rewritten.

Limits are 256 projects, 512 folders and 64 MiB decoded project/dataset content.
Capture resolves the root through its unique bundle ID and fetches only its
subtree. SQL limits of 257 projects and 513 folders detect over-limit containers
without materializing every installation folder or an arbitrarily large bundle.
Root handling compares stable paths, not object identity between query results.
Artifacts are prepared outside SQL; one transaction exposes the entire copied group.
Stale/failed operations expose no partial group. Existing reference-aware cleanup
handles unused uploads and uncertain commits. Lost responses are not automatically
retried: refresh the tree first. Copies have no published routes, enabled schedules,
publication/recording history or copied server credentials. External services and
shared configuration are not sandboxed. Coordinated publishing/merge-back is not added.

New portable imports create explicit containers. Capability-4 imports preserve
membership and subfolders. Both legacy and capability-4 imports reject destinations
at or inside existing bundles. The managed importer checks the destination while
holding the topology lock in its transaction, so stale menus and direct HTTP calls
cannot bypass the rule. Rejected imports discard prepared revisions and expose no
partial folders or projects. Ordinary ancestors containing bundles may still accept
uploads as new sibling bundles. Previously imported folders are not converted automatically. The
archive's root artifact is only an initial Desktop/Node selection, not an
entry-project property on the container.

Remote Debugger grouping uses server-qualified explicit bundle identity only.
Cross-project calls never expand membership; standalone projects stay independent.
Explicit desktop manifest grouping remains supported. Start/stop from any opened
member. Closed members are not opened automatically. Membership changes reconcile
joins/departures and fence late events while retaining remaining members' sessions.
An authoritative tree deletion clears a tab's hosted membership without closing
the tab, rewriting content or saving edits. Initial loading and failed tree reads
are not authoritative empty trees. Membership helpers receive only opened-tab
metadata; streamed graph snapshots are not inputs or subscriptions for grouping.
Hosted tab normalization retains the bundle key (including explicit null) when
repairing other legacy tabs. Explicit hosted detachment never falls back to an
old portable-manifest hint; desktop tabs without hosted metadata still use theirs.
Passive projection also checks membership. Root lifecycle bookkeeping can settle
eligible children called from outside without painting the outside caller.
Old browser builds must reload to adopt the policy.
Shared disconnect hooks use the same callback-isolation helper as ordinary
executor lifecycle subscriptions, so async consumer failures are reported without
an unhandled promise rejection. Keep explicit Core type imports in these hooks;
the App lint gate disallows inline `import()` type annotations.

Optimistic folder move/rename updates reconcile descendant project bundle IDs
from the resulting hierarchy, not just their paths. This makes newly opened tabs
use the correct membership before the background tree read completes, including
when that read fails. Moving an ordinary folder into/out of/between bundles
updates all descendants; moving a bundle or an ordinary ancestor retains nested
bundle identities. The returned moved-root identity takes precedence over the
old tree, covering a concurrent conversion. No project content or references are
rewritten. `workflow-tree-ops.test.ts` owns these regressions; the browser move
check opens the moved project while follow-up tree reads fail.

Verification owners: `remap-bundle-project.test.ts`, schema migration tests,
registry/observation tests, the explicit-container contract in `test:async-managed`,
and headless `explicit-bundles.spec.ts` / `remote-bundle-observation.spec.ts`.
The debugger browser matrix includes HA replay completion, child failure and
active shared-stop cases:
open A/B/C from one explicit bundle, connect from C, and execute A → B → C on
another backend. It fills the bounded history before connecting and again during
streaming (evicting the active start), then reconnects the one shared socket onto
the other backend. Every member retains **Stop Remote Debugger**, its own live
node outputs and Run Activity; completion/failure settles the correct member
views. An unrelated standalone tab stays independent, and stopping from B
disconnects the shared observer without sending workflow controls. Existing
non-HA cases still cover abort, mixed versions, source reopen, external calls and
membership deletion. `helpers/latestDebuggerFixture.ts` supplies the same real
two-owner authenticated relay used by the focused HA replay browser tests; no
production services or cloud rehearsal are involved.
Transport replay warnings are consumed before project-event routing, so a
history gap cannot masquerade as a terminal graph error in any bundle member.
Per-owner event deduplication and the logical session survive physical reconnects;
bundle membership and tab-lifetime fences are not reset by reconnecting.
Only executed members have new flow data. Closed tabs are not opened automatically,
and a newly opened member does not retroactively acquire an already-admitted run.
`managed-bundles.test.ts` covers source changes during artifact preparation and
failure of a later upload, asserting that no copied metadata becomes visible and
only prepared copy artifacts are offered for reference-aware cleanup.

### Plan and delivery boundaries

The first-class-container plan has the following acceptance surface. These are
implementation boundaries, not a claim that a deployment has already been upgraded.

| Planned behavior                                                                                                                      | Implemented owner / regression evidence                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Explicit folder identity, derived membership, no entry projects or nesting                                                            | Migration 16, managed tree projection, schema tests and PostgreSQL integration                                   |
| Create, convert, rename/move and empty-container deletion without rewriting references                                                | Existing folder operations plus bundle routes; integration and browser checks                                    |
| Duplicate all members and subfolders with fresh identities, internal rewiring, shared external references and selected saved versions | Shared remapper, managed duplication service, copy-execution integration                                         |
| Unpublished copies, no copied routes/schedules/history, no silent saving or partial group exposure                                    | Duplication preview/acknowledgement, rollback integration and preparation-failure tests                          |
| One debugger session from any opened member; no grouping by inferred references                                                       | Explicit membership helper, registry/routing tests and browser streaming matrix                                  |
| Membership changes/deletion retain edits and reject late events                                                                       | Guarded editor binding reconciliation, registry lifetime fences and deletion-during-streaming browser regression |
| Keep existing portable artifacts, desktop runtimes and storage compatibility paths working                                            | Existing import/Node contracts retained; unsupported backends advertise no new container actions                 |

Coordinated publication, endpoint cutover and merge-back between copies remain
outside this plan. Container-level download reuses the existing portable archive
and job owner rather than introducing another transfer format or scheduler.
Deployments apply migration 16 through the existing migration owner before serving
the updated API; no manual project conversion or new Kubernetes component is needed.

## Portable project bundles

Studio Server's explicit bundle-folder **Download bundle** action exports every
saved member, including disconnected members, subfolder/empty-folder metadata and
the recursive external dependency closure as a ZIP. Ordinary **Download project** and
published-history downloads retain their single-file contract. Closing the bundle
dialog does not cancel export, activate a project, refresh the tree or discard edits.

Projects and ordinary folders do not offer **Download bundle**. A bundle folder
uses the existing two downward arrows, with the right arrow slightly lower.
Project menus retain the single downward arrow for **Download project**.
Icons are decorative; menu labels provide accessible names. The
bundle dialog also uses the **Download bundle** title.
The single-project version chooser retains its **Download** title and version
buttons; `workflow-project-version-modal.spec.ts` exercises that flow through
the **Download project** menu item, separately from the bundle chooser.

Failed, cancelled and interrupted jobs offer **Retry export** directly: disposal
must succeed before creating a fresh job with the selected bundle-wide version. Ready
jobs retain **Prepare another bundle** for choosing a different version. Job status
includes the optional durable `versionPolicy`; reopening or retrying a new-format
job restores its actual choice. New bundle downloads default to Saved latest.
The session-storage key is the explicit bundle ID, not a project's metadata ID.
Status responses and polling errors are fenced by the current job ID, so late replies
from a disposed job cannot overwrite the retry's progress or download link.
Late start acknowledgements cannot regress packaging back to collection, or
replace a terminal result with active progress.
Action admission uses a synchronous in-flight guard as well as disabled buttons,
so rapid repeated clicks cannot start competing POST/DELETE operations. Progress
polls may reconcile a lost start acknowledgement but never erase a cancellation
failure; only another explicit action or reopening clears that diagnostic. The
dialog uses the shared API response parser, retaining HTTP status and gateway
guidance without showing HTML bodies or malformed structured error values.

The bundle dialog uses the shared responsive modal dimensions, black backdrop,
dark surface and header/close styling. Project details and export progress use
bordered cards with the shared 14px/1.5 description typography.
The progress card shows an indeterminate spinner while loading initial status,
collecting snapshots or packaging, including after reopening an active export.
Terminal states remove the spinner; reduced-motion preferences disable rotation.
The existing live status text announces progress without exposing a decorative icon.
Bundle-wide version selection uses `SegmentedControl`, not an OS-native select. Atlaskit actions live
in a non-scrolling footer; Prepare/Download are blue primary actions on the right.
The body alone scrolls, keeping the title, close control and actions visible on
short viewports. Download remains a real anchor with the authenticated archive
URL, preserving native browser downloads and resume rather than buffering a blob.

## Ownership and snapshots

### Uploading bundles into the workflow library

The folder context menu offers **Upload bundle** beside **Upload project**, including
at the library root. `BundleTransferIcon` renders the existing staggered downward
arrows for download and their upward counterparts for upload. Both paths retain
accessible menu labels and the shared dark modal styling, including the existing
spaced, non-scrolling footer and button styles rather than new upload-specific CSS.

`WorkflowBundleUploadModal` captures the destination folder and prevents duplicate
submission or closing during an accepted upload. `projectBundleUpload.ts` reads a
directory selection or ZIP with `fflate` streaming decompression; it never extracts
archive paths to disk. One optional wrapper directory is stripped. macOS
`__MACOSX` and `.DS_Store` entries are ignored. Traversal, duplicate paths, multiple
manifests, files outside the wrapper and invalid UTF-8 are rejected.

Upload limits are 64 MiB compressed ZIP size,
64 MiB total actual decoded file contents, 514 meaningful files (up to 256 projects
with sidecars, manifest and README), 1 MiB manifest, and the existing 100 MiB JSON
control-plane request limit. New container exports enforce these same round-trip
limits (including manifest/README and JSON escaping) before exposing a ready ZIP;
edits may still grow an extracted bundle past those limits. Legacy programmatic
project-closure exports retain their configurable larger limits. Actual decoded sizes are checked independently of ZIP
headers; directory entries and ignored metadata also have a bounded entry count.

Authenticated `POST /api/workflows/project-bundles/import` requires
`X-Rivet-Bundle-Intent: 1` and rejects cross-site intent before parsing the body.
`project-bundle-import.ts` validates the complete manifest, project identities,
datasets, dependency closure and saved graph boundaries using the existing Core
bundle validators. Undeclared files and missing active dependencies are rejected.
Dataset and row identities must be unique within their respective project/dataset;
optional row embeddings contain only finite numbers. Directory uploads enforce
the same meaningful-file limit as ZIPs before reading excess files.
Parsed private dataset objects are reused for ID remapping and serialization;
import does not parse the same large sidecar twice.
Legacy bundles containing multiple versions of the same project require re-export
with one bundle-wide version selection; import never arbitrarily picks a version.

Preparation gives each project a fresh metadata ID, retaining graph/node/port IDs,
wires and attached data. It remaps cross-project Subgraphs (including prefab source
nodes and saved node variants), legacy references/aliases and dataset ownership to the new group; obsolete
path hints are removed. Subgraph version bindings become `latest`, since imported
snapshots are ordinary unpublished editable drafts, not new published endpoints.
Exports intentionally omit dependencies used only by disabled nodes, unused
prefabs, or inactive variants. Import preserves those uncaptured authored bindings
without treating them as active dependencies or silently retargeting them.
Enabling such a configuration may require selecting its target or supplying that
project. Bindings to projects that are captured are remapped even in inactive
configurations. Active dependency validation still occurs before any mutation.
Core's `ChartNode.variants` data is `unknown`, even for typed Subgraph/alias nodes.
Import narrows each current/variant configuration to a non-array object and checks
the target ID is a string before remapping. Unfinished inactive payloads are kept,
not cast to provider/node-specific data or used to invent dependencies. Qualification
must rebuild Core/Node declarations before compiling the API and its tests; stale
local declarations are not evidence of clean-container compilation. The API Docker
builder performs this dependency-first build with the supported Node 24 toolchain.
Project names are sanitized and made unique within each logical folder. A fresh
`<bundle name> <suffix>` explicit folder preserves declared member subfolders,
including empty folders. External dependency snapshots are copied into a separate
ordinary neighboring `<bundle name> <suffix> dependencies` folder; their references
are remapped to those new snapshots without expanding bundle membership. Desktop
retains each artifact's member/dependency role for debugger and live display grouping.
Legacy archives keep the `<root title> bundle <suffix>` naming. The new bundle is
expanded after success, and announced through the existing tree-change mechanism.
Existing projects are never overwritten. Ordinary move/rename operations work
after import because references bind to stable project IDs, not folder paths.

The supported PostgreSQL/S3 deployments use `managed/bundle-import.ts`: immutable
artifacts are prepared before one SQL transaction creates the folder and entire
project group. The destination parent is locked and rechecked before insertion.
Managed empty-folder deletion locks that folder before checking its children, so
an overlapping import cannot leave its group under a deleted parent. Folder moves
retain the existing PostgreSQL function's lock-before-traversal contract.
Failures roll back all metadata; unused artifacts go through the existing
reference-aware deletion outbox, including uncertain commit outcomes. No automatic
write retry occurs. A lost response can mean a committed import: refresh the tree
before manually retrying, since another upload creates a separate group. Historical
filesystem/SQLite compatibility backends return 409 rather than attempting a
non-atomic multi-project import. Upload does not execute nodes, install plugins,
transfer credentials, or import server settings/publication history.

Verification owners: `project-bundle-import.test.ts` covers preparation/remapping
and rejected input; web `project-bundle-upload.test.ts` covers directory/ZIP limits;
`project-bundle-upload.spec.ts` covers both browser pickers, destination expansion,
the icon, and explicit same-file retry after a failed response without partial tree
updates. The real PostgreSQL/MinIO async integration includes a second-row
rollback, empty-folder deletion waiting for an imported child, import of an
exported bundle, moving its dependency and executing the
imported root with preserved datasets. Its test-owned recordings are removed
through the normal recording API before later recording contracts run.

### Export and local execution ownership

- Core owns the versioned `ProjectBundleManifest`, validation, prefab-aware
  dependency enumeration and saved Subgraph boundary validation in `ProjectBundle.ts`.
- API `routes/workflows/project-bundle.ts` collects all graphs, not only Main.
  It reuses the execution snapshot resolver for filesystem, SQLite and managed
  storage, including the datasets belonging to the selected revision. Raw project
  bytes, project/graph/node IDs and attached data are preserved; no graph flattening
  or reference rewriting is performed.
- The dialog selects **Published** or **Saved latest** for the entire closure,
  exporting one artifact per project. Published falls back to saved latest only
  for projects with no publication. Both latest/published Subgraph bindings and
  legacy reference bindings resolve to that project's selected artifact. Authored
  Subgraph version settings are not rewritten; the selection overrides them only
  inside the bundle. Incompatible saved graph boundaries reject export rather
  than remove wires or silently choose another version. Stale hint paths are not
  export authority.
- API clients omitting `versionPolicy` retain the legacy per-call selection:
  `(projectId, latest|published)` artifacts and published-first legacy references.
- Every captured source is re-read once after the ZIP closes, before publication. A changed
  project, dataset, selected version or source revision rejects publication; this
  live-source consistency barrier does not checksum editable extracted files.
  An export is not a transaction spanning
  databases, but it never knowingly publishes a mixed, changed capture.
- Node `loadProjectBundle` validates the extracted manifest, contained real paths,
  actual file resource limits, identities, target graphs and wire boundaries before
  processor creation. Each processor receives separate mutable project clones and
  in-memory dataset providers per artifact. Legacy references and versioned calls
  resolve only through the manifest; there is no server lookup or filename guessing.
- The additive `ProjectReferenceLoader.getDatasetProvider(project)` hook gives
  referenced-graph aliases the referenced snapshot's datasets. The bundle supplies
  a provider even for an empty snapshot; it must not inherit root datasets. Existing
  custom loaders without this hook keep their previous caller-provider behavior.
- Cycle checks use graph calls, including same-project hops, rather than project
  membership. `A/main → B/main → A/helper` is valid; a recursive graph-call
  component containing a cross-project call is rejected. Ordinary local recursion
  retains the existing runtime contract. Legacy alias edges participate in this
  analysis without newly prohibiting legacy-only cycles. Missing alias graphs and
  unresolved library instances are rejected before execution.

The archive contains `rivet-bundle.json`, `README.txt`, and opaque numbered
`projects/*.rivet-project` / optional `.rivet-data` artifacts. Schema
version is 1; loader capability is 4 for explicit membership and 3 for older
bundle-wide version selection. `exportingRuntimeVersion` records the installed Node
runtime version independently of the loader capability. Bundles are not a trust boundary:
executing a bundle can execute its Code nodes and network requests.
The generated `README.txt` describes the actual bundle-wide policy; legacy API
exports retain the authored per-call version explanation. Keep the user guide's
Working with Projects, Subgraphs and Node `loadProjectBundle` reference aligned
with these version, editable-file and desktop execution contracts.

### Editable extracted files and compatibility

Extracted project and dataset files may be edited without updating the manifest.
New manifests contain only `path` in each file descriptor; per-file checksums and
export-time lengths are no longer calculated or enforced. The loader accepts old
capability-1 bundles too, ignoring their legacy `bytes`/`sha256` fields, including
stale values. New UI exports declare `requiredLoaderVersion: 4`, `workspace` and
`versionPolicy: latest|published`. Capability 4 requires both metadata fields;
capabilities 3 and 4 require that policy and reject
duplicate project identities. Latest policy rejects published artifacts. Older loaders
fail with an upgrade instruction rather than misinterpreting the new descriptors.

`workspace` carries the logical bundle name, relative subfolders and a
`{projectId, relativePath}` record for every member. Other artifacts are external
dependency snapshots. Core validates unique identities/locations, safe relative
paths, existing parent folders and a member initial selection. Physical artifact
paths remain opaque and contained; no native extraction or arbitrary path writes
are added. Every capability-4 artifact declares a dataset sidecar, including an
empty one, so Desktop can add its first dataset without editing the manifest.
Use an updated Desktop build supporting capability 4. Extract the entire ZIP and
open `rivet-bundle.json`, edit/save existing projects, then upload the folder or a
new ZIP. Import ignores stale legacy checksums but validates the current files.
It creates a separate unpublished bundle; it is not synchronization or merge-back.

Authenticated `POST /api/workflows/project-bundles/container` accepts
`{bundleId, version: latest|published, requestId}` and requires the existing intent
header. It seeds the shared collector with all members, rechecks the topology and
selected-revision fingerprint before publication, and uses existing job status,
cancel, shared-archive and download routes. An empty bundle cannot be exported.
The older project-closure POST remains compatible for API callers, but has no UI
menu action. The new managed round-trip contract runs inside `test:async-managed`:
real ZIP/Node loading, edit/save equivalent files, public HTTP import, empty and
nested folders, disconnected members, external dependency separation, new dataset
ownership, execution and source preservation. `desktop-project-bundle.spec.ts`
exercises the actual Desktop IO adapter and editor with owned native replies;
native reader containment is covered separately by Rust tests.

File limits (64 MiB per artifact, the configured total budget, and 1 MiB for the
manifest) use actual sizes before allocation, with bounded reads detecting growth
or truncation during loading. Path containment, identities, version bindings,
plugins, dependency closure, cycles and saved wire boundaries still apply.
Renaming an existing Graph Input or Graph Output keeps its stable node identity:
the caller retains its connected port ID while displaying and executing the new
name, just like same-project Subgraphs. Removing/replacing a boundary node,
changing its type, or introducing conflicting names requires reviewing the caller
contract; removing checksums does not make incompatible graph connections valid.

`loadProjectBundle` captures current disk contents once. Processors made from that
loaded bundle use isolated in-memory copies. Call it again after editing files to
use the edits; existing processors do not hot-reload. Export revision labels are
provenance, not checksums or proof that an extracted file is unchanged.

### Desktop opening and execution

Extract the ZIP first. Desktop Open accepts `rivet-bundle.json`, opens every
declared project in its own tab and selects the root. `.rivet-project`
files and JSON manifests share the default native Open filter. The file-type
dropdown also offers explicit **Rivet Bundle (rivet-bundle.json)** (`*.json`) and
**Rivet Project** (`*.rivet-project`) filters. Only bundle manifests are accepted
as bundles; the JSON filter does not turn arbitrary JSON into a project. Save
remains project-only, and bundle opens resolve the actual project save path,
not the manifest path.
Native adapter tests exercise the dialog IPC options and selected-manifest load,
not just the path-based loader; Playwright covers the editor's Open menu path.
Actual `.rivet-project` paths are used for saves, tabs and recent files. Existing tabs from the same
paths keep their unsaved edits and datasets; conflicting open project identities
fail before importing. New inactive members import datasets without activating
their provider and merge their Evaluation library entries. Workspace opening uses
the same guarded owner for file-picker and path-based opens, including when the
root is already open. Reusing activation does not start a competing intent.
Closing, moving or rebinding a member during deferred dataset import invalidates
the open before any new tabs are registered. Parsed member datasets are imported directly,
without rescanning the snapshot map for each member.
Opening any declared project directly inside the bundle's `projects/` folder
discovers the sibling manifest and opens only that member as the entry point.
Legacy mixed-version bundles still execute through the public Node loader or
individual-member opening. Opening their manifest as a desktop workspace rejects
duplicate project IDs, with guidance to re-export using the global version choice.
Discovery does not walk arbitrary ancestors or guess dependencies from filenames.
Once Open has established membership, tab activation/restoration, Browser/Node
runs, Evaluation trials and editor reference reloads capture the tab's `bundleManifestPath` and pass it
back to the native reader. The remembered manifest is authoritative: rediscovery
from the file's parent would lose membership for valid nested paths and silently
drop the Subgraph loader. Explicit reads validate both permitted paths, canonical
containment and declared membership, including on Windows.
Missing, moved or invalid remembered manifests fail preparation with a visible
error; they never downgrade to standalone execution. Individual-member opens
retain the same membership metadata as manifest workspace opens.

Reference reloads use the same explicit-binding reader as execution. In particular,
an entry under `projects/nested/` cannot rediscover its manifest from its immediate
parent: using that discovery path would leave external Subgraph previews missing
even though the run loader still has the correct bundle. The desktop bundle
Playwright regression verifies a bound reference read before execution starts.

Reopening an already-open individual member still registers its manifest, without
re-importing datasets or replacing live edits. If its saved baseline needs recovery,
the validated Open supplies that manifest to the guarded disk read before membership
is committed. Tab restoration also fences on manifest identity, not only file path:
a late read from an old binding cannot populate the new binding's baseline or cache.

An existing malformed manifest or undeclared member is an error, not a silent
fallback to standalone execution. Moving a project outside the bundle removes
automatic discovery for fresh opens; existing bound tabs fail rather than
silently losing dependencies. Move the complete extracted directory and reopen
its manifest to retain bindings.

Both Browser mode and the standalone desktop Node executor support live runs and
Evaluations. The current entry project/graph and its active editor datasets override
its disk snapshot, including unsaved edits. Dependencies are reread from disk for
each run, with separate latest/published artifact and dataset identities. Unsaved
edits in another open dependency tab must be saved before running the caller.
Each run gets isolated dependency projects and datasets; mutations do not leak
into another run or another version of the same project.
Root runs project live dependency node/graph events into matching bundle tabs,
including inactive tabs, in Browser and desktop Node mode. Core event metadata
identifies the actual owning project. This is a display projection: run controls,
cancellation, user-input prompts, recording and terminal errors remain entry-owned.
Cross-project graph entries are rebased for the dependency's graph view; nested
graphs within that project retain their parent identity. Replay events and unrelated
open projects are excluded. Display observer errors cannot fail the processor.
The desktop entry datasets are also captured at Run time and isolated per run
(or per Evaluation trial). Switching tabs cannot redirect a pending/running
bundle to the new tab's dataset provider. Dataset writes inside a bundle run
remain run-local; they do not modify the editor's datasets or extracted files.

Browser run preparation owns an abort controller before asynchronous bundle reads
begin, so repeated Run clicks cannot start duplicate work. Abort or closing the
entry tab prevents late reads from starting execution. The desktop Node executor
also acknowledges cancellation during bundle preparation and checks it before
starting the processor; subsequent runs remain usable. The public Node loader
accepts an optional `signal: AbortSignal`. The executor passes its preparation
signal to it, stopping further reads/parsing between filesystem awaits and closing
the current handle on cancellation. A pre-cancelled load performs no filesystem IO.
The Browser run reservation remains owned until processor completion, including
runs returning outputs early. Bundle/preparation failures show an error toast even
when no processor start/error event was emitted. Cancellation is checked after
asynchronous environment preparation in both ordinary runs and Evaluations, so a
late completion cannot start a cancelled run.

Opening checks manifest structure, project identities and membership, but allows
stale graph interfaces to be repaired in the editor. Execution then checks the
complete closure, cycle rules and saved wire boundaries against the visible entry.
`createProjectBundleRuntime` owns this shared browser/Node resolution contract;
Node's `createExecutionContext` and loader `entry` override use the same boundary.
Package plugins still require normal local installation; a manifest cannot grant
permission to install or execute a new plugin automatically.

Tauri's `read_project_bundle` reads on a blocking worker, validates the selected
file's existing scope and grants access only to contained declared files. Reads
are bounded at 1 MiB for the manifest, 64 MiB per artifact and 512 MiB total;
traversal, escaping symlinks and size changes fail clearly. Valid UTF-8 text is
required by both native and Node readers; an initial UTF-8 BOM in the manifest is
accepted by both (for compatibility with Windows text editors). Invalid UTF-8
remains an error. The Node reader opens
the contained canonical path rather than re-following the original symlink alias.
Node mode sends the manifest location, artifact ID and captured entry datasets
over the desktop executor protocol, not dependency bodies. The app and executor
must be updated together; a bundle request missing its entry dataset snapshot is
rejected instead of borrowing whichever tab is now selected.
A hosted/authenticated executor refuses local bundle locations
by default. External-debugger mode is unsupported for desktop bundle resolution
and reports an actionable error; Studio Server retains its server-owned loaders.

Ordinary saves edit the selected project and its neighboring data sidecar, never
the manifest itself. Dependency/version bindings are not rewritten automatically:
adding new projects or dataset sidecars to a previously data-free artifact requires
updating the manifest or exporting a new bundle. Existing declared data sidecars
should keep their standard neighboring `.rivet-data` location.

Server export still checks source consistency while collecting and before
publishing the ZIP, and retains the archive hash/ETag for resumable downloads.
Storage artifact integrity, backups and migration certification are unchanged;
none of these checks restrict editing extracted bundle files.

## Job and download lifecycle

### Storage-backend contract

The serving backend, not the presence of a project path on the VM, selects the
source reader. Bundle preparation uses the same saved-version resolver as execution:

| Source setup            | Project and dataset snapshot authority                                                          | Downloadable ZIP                 |
| ----------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| Legacy VM files         | Saved project/sidecar files or the selected published snapshot, under the filesystem read fence | Private API disk scratch         |
| Local SQLite            | Catalog-selected immutable local artifacts; virtual project paths need not exist as files       | Private API disk scratch         |
| S3 + managed PostgreSQL | PostgreSQL selects the revision; S3 supplies that revision's project and matching dataset blobs | Private control-API disk scratch |

Managed mode never reconstructs project files in the legacy workflows directory
or hands the browser an S3 object URL. Authenticated ZIP download and Range resume
are identical across the three setups, independent of bucket prefixes or virtual
project paths. UI **Published**/**Saved latest** applies to every project and its
matching datasets. Legacy clients without a policy retain per-call versions and
separate datasets. Source changes reject publication.

All setups still require writable export scratch and enough space for compressed
output plus headroom. Managed source storage does not eliminate that requirement.
Compose supplies the same disk volume for local and managed VM deployments; Helm
routes `/api/*` to the singleton control backend with its dedicated export volume.
Custom launchers must provide private writable scratch. Source credentials and
database connection/SSL configuration remain the normal storage prerequisites;
export creates neither database migrations nor new bucket permissions.

### HTTP and lifecycle

Authenticated API routes under `/api/workflows/project-bundles` are:

- `POST /` with `{relativePath, version: live|published, versionPolicy?: latest|published, requestId?: UUID}` returns
  202 promptly. The client creates and remembers the UUID before POST, allowing
  progress recovery after a lost acknowledgement.
  The UI always sends `versionPolicy`; `version` remains the backward-compatible
  root selector for older clients. With a policy the root also follows the policy.
- `GET /:id` reports collecting, packaging, ready, failed, cancelled or interrupted.
- `GET /:id/download` serves a ready immutable ZIP with a strong archive-hash ETag,
  Range/If-Range support, attachment disposition and no-store headers.
- `DELETE /:id` requires `X-Rivet-Bundle-Intent: 1` and cancels/disposes the export.

Only one export prepares at a time, including writer drain and journal publication. Terminal
status and download acknowledgement wait for that preparation owner to settle:
observing failure guarantees its packaging slot is released before retry, and a
ready archive is not exposed before a failed final journal write can revoke readiness.
Expiry and cancellation use one serialized removal owner;
failed deletions remain tracked for disk accounting and are retried instead of
orphaning archives. Failed archive removal also blocks further preparation until
cleanup succeeds, while leased downloads may finish. Cancellation denies new
downloads before removing scratch and protects its journal update from concurrent
cleanup. Concurrent cancellation requests share one operation and journal write;
atomic journal writes use unique temporary files. This avoids both temporary-file
collisions and concurrent journal replacement on Windows, without filesystem retries.
Failed journal replacement removes its attempt-owned temporary file without
altering the previous journal. If removal also fails, ordinary owned-directory
cleanup remains responsible for it. Scratch initialization is shared by concurrent
requests, but a failed attempt is not cached permanently: repair the mount or
permissions and retry without restarting the API. A disposed manager never retries
initialization through preparation.
A 30-minute deadline cancels stalled preparation;
late non-abortable reads cannot publish. On API restart, unfinished journaled jobs
become interrupted. Restart reconciliation removes legacy staging trees and partial
archives even for ready jobs, preserves only durably published ready ZIPs, and
keeps cleanup failures tracked/blocking until removal succeeds. Private scratch is
reconciled before admitting another export: a ready ZIP must still be a regular,
non-symlink file of the journaled size. Missing/truncated archives become failed
and unavailable for download. Archive bytes/hash are cleared only after all owned
archive cleanup succeeds, so interrupted jobs neither consume phantom budget nor
hide files that could not be removed. The same file validation is used on download.
Private scratch is installation-scoped beneath `RIVET_PROJECT_BUNDLE_SCRATCH_ROOT`,
with restricted creation modes. The root must be absolute; a hash of the workflows root keeps
installations sharing a base separate and stable across restarts. Standalone
servers without this setting retain the OS temporary-directory fallback. Ready jobs expire after 24 hours;
cleanup never removes an archive leased to an active download. Cancellation prevents
new downloads immediately; an existing reader may finish and its retained archive
continues to count toward the scratch budget until released. Expired, failed or
cancelled jobs do not create authoritative workflow data. Shutdown drains exporters;
unavailable scratch or export cleanup failures cannot prevent unrelated storage cleanup.
A disposed manager rejects new preparation before initializing scratch or timers.
Failed starts remove only directories created by that attempt, never pre-existing
unclaimed scratch with a colliding request ID. If start rollback fails, the directory
remains tracked for cleanup/retry, with a failed journal when storage permits.
These read-only export routes remain usable while migration pauses writes.
Only typed `ProjectBundleError` failures created by bundle validation/limits are
shown verbatim. Raw storage exceptions are redacted regardless of their message
prefix. Conflicting plugin requirements for the same plugin ID fail validation;
equivalent requirements are deduplicated. The loader also checks every included
project's plugin requirements against the manifest, so omitting or changing a child
plugin declaration cannot bypass the dependency contract.

The collector feeds each captured file directly into a backpressured ZIP writer;
there is no raw staging tree. It waits for each input to be consumed before reading
the next artifact, releases consumed byte buffers, and retains source fingerprints
rather than complete payloads. Parsed graph definitions remain for closure/boundary
validation. Compression runs during collection; the packaging phase closes the ZIP
and performs the final source check. SHA-256 is computed as ZIP output is written,
without rereading the archive. Only a closed, validated archive is atomically renamed
and published. Keeping this ZIP (rather than regenerating on download) preserves
stable length, checksum, selected versions and browser Range resume.

Defaults: 256 project/version artifacts, 64 MiB per project or dataset file, 512 MiB
total captured payload, 2 GiB scratch budget, and 32 MiB free-space reserve.
Version-selected bundles keep one artifact per project and allow up to 512 target
bindings (latest and published aliases), so both modes support all 256 projects.
Export also enforces the loaders' 1 MiB manifest limit against serialized UTF-8
bytes before publishing an archive; large titles cannot produce an unloadable ZIP.
Operators may deliberately set `RIVET_PROJECT_BUNDLE_MAX_BYTES` (up to 8 GiB) and
`RIVET_PROJECT_BUNDLE_SCRATCH_MAX_BYTES` (up to 32 GiB), and
`RIVET_PROJECT_BUNDLE_FREE_SPACE_RESERVE_BYTES` (1 MiB to 1 GiB). Scratch accounting
counts retained archives plus actual compressed output, including ZIP headers,
manifest and README, rather than raw payload size or a worst-case archive estimate.
Free-space checks run before output consumes the available credit, every 4 MiB or
one second of output, and after final source verification immediately before
publication. The last check cannot use credit measured before a potentially slow
source re-read. They keep the configured reserve plus 64 KiB
for bounded queued writes and small journal replacements; real ENOSPC errors still
abort and drain the writer. Failed archive removal blocks new preparation until owned scratch is removed;
it must not erase retained archive accounting. Capacity exhaustion fails rather than
deleting unexpired bundles. The Node loader defaults to 512 MiB total and accepts
`maxTotalBytes` for intentionally larger trusted bundles.

### Deployment scratch capacity

Production and development Compose automatically mount the private, disk-backed
`rivet_project_bundles` named volume at `/data/project-bundles`. The initializer
owns it as UID/GID 10001 with mode 0700. It is separate from workflow, recording,
runtime-library, app-data and local-upgrade roots, so exports do not inflate source
inventories or migration backups. It survives container recreation; normal job
expiry and cleanup remain responsible for disposal. Do not remove this volume
while downloads are active. Mounted dotenv cannot override the deployment root.
The staging preflight requires API and initializer to share this writable named
volume, separate from authoritative state volumes. A predecessor without export
scratch may add it on first rollout; an existing export volume cannot be silently
redirected. The isolated migration image rehearsal's replacement initializer also
sets export ownership and 0700 permissions instead of bypassing the production fix.
Compose passes optional payload/scratch budgets and the free-space reserve with
their normal defaults. These are limits/headroom, not preallocated disk space.

The Helm control backend uses a dedicated node-disk `emptyDir` at the same path,
bounded by `writableVolumeLimits.projectBundles` (default `3Gi`: the `2Gi` export
budget plus reserve and journal headroom). Execution, Evaluation, web
and proxy containers do not mount it. Container restarts retain it within the Pod;
Pod replacement discards exports, which can be prepared again. Increasing export
budgets also requires enough volume and whole-Pod ephemeral-storage capacity.

The old fixed 512 MiB reserve rejected even tiny exports on an empty 512 MiB tmpfs.
The incremental writer no longer has that requirement, but large retained ZIPs
still belong on disk rather than competing with workflow memory in tmpfs.
Keep `/tmp` and `/var/tmp` unchanged for ordinary RAM-backed Compose scratch.
For standalone deployments, select a private writable disk directory using the
root setting rather than raising RAM-backed temporary capacity.

After updating both images and deployment configuration, inspect the actual mount:

```sh
docker exec ops-api-1 printenv RIVET_PROJECT_BUNDLE_SCRATCH_ROOT
docker exec ops-api-1 df -h /data/project-bundles /tmp
docker inspect ops-api-1 --format '{{range .Mounts}}{{println .Type .Destination}}{{end}}'
```

Expect `/data/project-bundles` to be a Docker volume on disk, not tmpfs. The
host disk must still have room for retained ZIPs, the current archive and the reserve.
Updating only the API image cannot add the mount or its environment setting.

## Portability limits

Only saved server content is exported; unsaved browser edits are excluded.
Published selection uses saved latest only for children without publications;
legacy exports without a policy still honor individual Subgraph version choices.
Server settings, credentials, recordings, runtime libraries, environment
values, external services and arbitrary referenced files are not packaged. Values
already embedded in projects/datasets are included and may be sensitive.

Builtin plugin declarations from the entire closure are installed into the local
processor registry through the existing Node path. External plugins must be
installed and registered by the caller; bundles never install or fetch code.
Code-node npm dependencies and filesystem paths must also be configured locally.
Dataset mutations remain in memory, not in the extracted archive.

The server feature and public Core/Node exports must ship together. An older npm
package without `loadProjectBundle` cannot run this workflow; publishing packages
is a separate release action, not part of downloading or implementing bundles.
Before promoting this feature as available to npm users, bump all four public
packages through the lockstep release process, publish from `main`, and run a
downloaded bundle against that installed registry release. A successful workspace
or built-entry-point check is not proof of a published npm release.
The local release smoke on 2026-10-05 also installed the built Core/Node artifacts
into an isolated npm project (`--install-links --ignore-scripts`) and executed the
cross-project fixture through both public entry formats, without PnP/source imports.
That validates local package installation, not registry publication.

## Completion and release gate

The implementation covers dependency closure/version binding, all three storage
adapters, background ZIP lifecycle and resumable authenticated download, the
dashboard action, and the public Node loader. Regression coverage includes actual
download/extraction/local execution, failed preparation and direct retry, cancellation,
restart, capacity failures, legacy references, version/dataset isolation and corrupt
manifests. The owned large-dataset probe measures packaging memory/disk cleanup.

The final rollout step is still a coordinated lockstep public npm release, followed
by running a relocated downloaded bundle against that registry-installed release.
Local package builds or an unchanged published version do not satisfy that step.
Do not describe the feature as available in npm until this release gate passes.

## Regression checks

```powershell
yarn workspace @valerypopoff/rivet2-node exec tsx --test test/projectBundle.test.ts
yarn workspace @valerypopoff/rivet-app test:files src/io/DesktopProjectBundle.test.ts src/io/TauriIOProvider.test.ts src/hooks/useLoadProject.test.tsx
yarn workspace @valerypopoff/rivet-app-executor exec tsx --test bin/executor.projectBundle.test.mts bin/executor.outputSelection.test.mts
cargo test --manifest-path packages/app/src-tauri/Cargo.toml --offline project_bundle --no-default-features
yarn workspace @valerypopoff/rivet-studio-server-api exec tsx --test src/tests/project-bundle.test.ts src/tests/project-bundle-sqlite.test.ts src/tests/sqlite-workflow-backend.test.ts src/tests/managed-execution-service.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/kubernetes-contract.test.ts src/tests/proxy-image-contract.test.ts
node --test deploy/studio-server/scripts/staging-docker.test.mjs deploy/studio-server/scripts/local-upgrade-rehearsal-safety.test.mjs
node --test scripts/ci/api-test-shards.test.mjs
$env:PLAYWRIGHT_HEADLESS='1'
$env:PLAYWRIGHT_SLOW_MO='0'
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:5174'
yarn studio-server:ui:observe project-bundle.spec.ts
yarn studio-server:ui:observe desktop-project-bundle.spec.ts
```

The browser fixture uses owned API responses and a real exporter, browser download,
ZIP extraction into another directory, and Node execution, plus delayed/lost start
acknowledgements, failed preparation followed by retry without reloading the
workspace, and the shared modal theme. API tests cover auth,
range resumption, redaction, cancellation, restart, coherent closure and reader
retention, including cancelled reader capacity, held terminal journal writes, retry after
failed expiry removal and unclaimed scratch preservation.
Held-journal fixtures cover both success/failure acknowledgements and prevent
downloads from escaping a failed publication; they use explicit gates,
not sleep-based race timing.
The desktop-editor Playwright fixture exercises the real editor and desktop IO
adapter with owned native read replies: manifest/member save paths, unsaved entry
execution, preflight error toasts, cancellation during bundle and environment
preparation, recovery, and entry dataset capture while the selected provider changes.
The editor regression and Node sidecar integration both use a nested entry path,
so folder discovery cannot mask a lost manifest binding. Tab tests cover remembered
membership during baseline recovery, reopening existing members without replacing
live data, and stale reads/imports after a manifest rebind.
The standalone executor WebSocket fixture checks cancellation, unsaved entry/member
execution and the captured entry dataset protocol against a real Node process.
It can also execute the built native sidecar rather than the development Node
runtime. On Windows, after building the executor, run:

```powershell
yarn workspace @valerypopoff/rivet-app-executor run build
$env:RIVET_TEST_PACKAGED_EXECUTOR=(Resolve-Path packages/app-executor/dist/app-executor-x86_64-pc-windows-msvc.exe).Path
yarn workspace @valerypopoff/rivet-app-executor exec tsx --test bin/executor.projectBundle.test.mts
Remove-Item Env:RIVET_TEST_PACKAGED_EXECUTOR
```

The native smoke covers cross-project execution, member entry points, unsaved
entry edits and captured datasets. The deterministic preparation-cancellation
gate remains in the source-process variant; native smoke does not inject code
into the executable. Desktop release workflows run the native smoke on each
platform before release promotion. Build Core first when using a downloaded
frontend artifact, since that artifact does not include Core's test imports.
An installed older desktop release does not gain this feature from server updates;
the app and its bundled executor must both be rebuilt or updated.

The real ZIP execution fixture includes a valid mutual-project call through a
different graph; an indirect cross-project cycle through a local helper is rejected.
Node tests cover two versions of one target, repeated processor isolation,
public ESM/CommonJS entry points, legacy alias datasets (including empty snapshots),
corrupt/incomplete mappings, size bounds and escaping paths. Artifact reads are
bounded by the captured file size plus one overflow byte, including when a file
grows after its size check; whole-file reads cannot bypass the memory limit.
Cancellation tests abort during an artifact read and check that its handle closes
without opening the remaining artifacts. Native tests cover BOM compatibility and
invalid UTF-8 rather than relying on mocked browser-native replies for decoding.
Node's `pretest` builds both package entry formats so this check does not depend
on stale local artifacts.
The `test` command invokes that preparation explicitly because Yarn does not
automatically run arbitrary `pretest` lifecycle scripts.
The closure fixture covers prefab/non-main targets, legacy back-edges, attachments
and a second version of the root. Storage failure followed by retry is covered.
No Kubernetes rehearsal or production migration is required.

The shared `project-bundle-download-contract.ts` fixture exercises actual HTTP
upload/save/publish/export/download routes, full and Range ZIP responses, unauthenticated
download rejection, extraction into another directory and local Node execution.
It exercises legacy mixed-version exports and both bundle-wide policies (one
artifact per project), a dependency in a non-main graph and a stale-hint legacy
reference. Root/child/version datasets share an ID
but contain distinct rows, proving isolation rather than merely checking metadata.
Every fixture HTTP request, including download bodies and disposal, has a deadline
so an unresponsive endpoint cannot strand the test runner.
Filesystem and selected native-SQLite variants run in the normal API test list.
The shard-manifest check ensures these files remain assigned to CI. Deployment
contracts render Helm and inspect Compose mounts, ownership, environment settings
and capacity validation; they do not launch a Kubernetes cluster.
`proxy-image-contract.test.ts` also checks that the Compose initializer mounts
every writable API storage directory and its ownership loop covers exactly those
mounts, independent of directory order. The export root must receive private 0700
permissions. New storage mounts must extend this coverage, not preserve an old
literal shell-loop snapshot. Include this test when changing export deployment.
The SQLite fixture installs an isolated serving selection; supervisor startup and
migration validation remain covered by the local-upgrade tests.

For managed end-to-end verification, reuse the existing opt-in owned-services gate:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-api run test:async-managed
```

This command creates and deletes isolated PostgreSQL and S3-compatible containers;
it accepts no deployment URL and never touches production data. The shared bundle
contract runs through the real managed API, PostgreSQL revision catalog and S3 SDK,
with a non-empty bucket prefix and no local project files. It also checks disposed
export cleanup. On 2026-10-06 this passed with PostgreSQL 16.8 and a local MinIO
fixture, in addition to the normal filesystem/SQLite checks. This is protocol and
backend evidence, not a claim that every operator's live cloud credentials, SSL
certificates, quotas or disk mounts have been verified.

For an opt-in capacity measurement, not a slow CI regression:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-api exec node --expose-gc --max-old-space-size=256 --import tsx src/tests/helpers/project-bundle-capacity.ts
```

The probe owns six random 16 MiB datasets, measures the real exporter and deletes
all its fixtures. On the Windows checkout on 2026-10-06, the same 100,669,652-byte
payload used 176,500,776 peak scratch bytes with staging, versus 75,824,760 with
incremental writing (57% less). The latter produced a 75,824,601-byte ZIP in 2.89
seconds versus 3.14 seconds before. Sampled peak heap was 140,601,248 bytes;
RSS increased from 347,684,864 to 443,109,376 bytes, comparable to the old writer's
101,527,552-byte RSS increase. Export scratch after disposal was zero. These are fixture/host
measurements, not universal memory or latency guarantees; the loader intentionally
materializes project/dataset snapshots when executing them.
