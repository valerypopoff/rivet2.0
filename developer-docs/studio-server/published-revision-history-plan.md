# Published revision history and frozen endpoint dependencies

The implementation covers published workflow endpoints and their project
dependencies. It uses the existing project tree, Project Settings and editor.
[Workflow Publication](workflow-publication.md#frozen-endpoint-releases)
documents the schema 22 upgrade and rollback requirements.

## 1. Product behavior

Keep one editable project tree. **Publish** serves the current saved project
and the exact saved revisions its reachable graphs resolve, including projects
outside its bundle. The current release is what callers get. **Unpublished changes**
means the saved project or the saved dependency selections differ from the
active release. Open editor tabs track unsaved work separately. The same rule
applies to a single project, a project in a bundle and a project that uses an
external dependency.

Rename **Published version history** to **Published revision history** in Project
Settings and related labels. Keep timestamps, stars, comments, the **Current**
marker and the **Preview**, **Restore** and **Download** actions. Keep the history
attached to the project’s stable ID. A project revision is an immutable saved
project and its data. An endpoint release is the exact set of revisions and
bindings captured by Publish. A history row records when a release became live.

**Restore** makes a historical release live at the endpoint’s current address
and access policy. The confirmation says, for example, “Serve this revision at
`/workflows/eA`. Drafts stay in the project tree.” Keep saved projects, folder
membership, datasets and unsaved editor tabs as they were. If the current tree
differs from the restored release, show **Unpublished changes** immediately. A
developer can open either the editable draft or the historical preview using
the existing entry points.

| Action                                                | Endpoint eA | Endpoint eB | Editable tree                                                   |
| ----------------------------------------------------- | ----------- | ----------- | --------------------------------------------------------------- |
| Publish A and B, both referencing C with Saved latest | A1 + C1     | B1 + C1     | C1                                                              |
| Save C2                                               | A1 + C1     | B1 + C1     | C2, both endpoints have unpublished changes                     |
| Publish A2, then save C3 and publish B2               | A2 + C2     | B2 + C3     | C3, only eA has unpublished changes if its own draft matches A2 |
| Restore eA’s first release                            | A1 + C1     | B2 + C3     | A2, B2 and C3, eA still has unpublished changes                 |

Keep the existing Subgraph choices. **Saved latest** selects the current saved
revision at Publish. **Published** selects the target project’s published
revision, so editing that target’s draft alone does not change the caller’s
candidate. Its nested Saved latest calls still select their own current saved
revisions. The selector chooses a project revision. Calling a graph inside that
project and calling the target’s HTTP endpoint are distinct operations. Rivet
freezes the former, including all its project dependencies. External services,
secrets, runtime libraries and other server settings keep their existing
runtime behavior. Editor and Latest runs continue to use the editable tree.
Independent web-app publications, schedules and Evaluations keep their existing
publication and execution rules.

## 2. Capture and serve a release

The managed [publication service](../../packages/studio-server-api/src/routes/workflows/managed/publication.ts)
stores the root revision and its captured dependencies as one release. The
[execution service](../../packages/studio-server-api/src/routes/workflows/managed/execution-service.ts)
loads that exact set on published runs. Publication preconditions and the
write transaction make the complete release the unit of promotion.

1. **Resolve the saved project set on Publish.** Start at the actual endpoint
   entry graph. Follow graph calls through internal and external projects using
   the same selectors, prefab resolution, enabled-node rules and depth/cycle
   handling as the [runtime](../../packages/core/src/model/GraphProcessor.ts).
   Reuse the [call-site extractor](../../packages/core/src/model/ProjectGraphCallSites.ts)
   and [reference summary](../../packages/studio-server-api/src/routes/workflows/project-reference-summary.ts)
   where they capture the required inputs. Cover nested local calls,
   `Call Graph` and compatible dynamic graph selection, legacy
   `Project.references`, Referenced Graph Alias, LLM tool continuation and
   OpenAI Run Thread callbacks. Follow Data Bus connections when choosing a
   local target. Include each possible local target once when the graph is
   chosen at runtime. A configured tool delegate contributes its handlers
   and fallback.
   Include explicitly configured legacy projects the runtime eagerly loads.
   Refuse a publish if a supported call can escape the captured set and its
   targets cannot be resolved safely. Unused bundle members stay out.
2. **Validate and record it once.** Store a versioned release manifest linked
   to the existing history entry. Record the root graph and artifact, every
   resolved project ID and revision ID, immutable project and optional dataset
   object identities, captured names and ancestor paths, and the source graph,
   call site, selector and target graph for each binding. Maintain an indexed
   artifact projection for retention and reverse lookup. Key distinct
   revisions separately. One release can include both Saved latest C2 and
   Published C1. Where the runtime already keys targets by project and
   selector, preserve that behavior and validate the caller’s actual edge.
   Check embedded project identity, target graph, bundle scope and the same
   graph boundary rules a run uses. Surface a blocked call with the project,
   graph and node names. Honor the current compatibility behavior for saved
   Subgraph interfaces.
3. **Promote the exact set reviewed.** Use the normal Publish flow and existing
   stale-review response. Bind review to the root draft, selected dependency
   pointers, relevant topology and current publication version. Validate the
   read set again in the existing write transaction under the established lock
   order. Read immutable bytes outside long write locks. If a selected
   dependency changes between review and commit, require a refreshed review.
   Publish the release reference, history row and live pointer atomically.
   Reconcile uncertain responses from the committed publication state. Give
   preparation bounded work and deadlines. Keep the current release serving
   if any validation or preparation fails.
4. **Load by release at execution.** Route both external and internal published
   workflow requests through the same snapshot-aware processor factory. Each
   run acquires one release before starting the graph. Its Subgraph and legacy
   project loaders use the captured bindings and matching dataset provider.
   Prepared immutable artifacts can be reused across runs. Release-specific
   lookup, editor state and mutable dataset/run state must stay scoped to the
   actual run. Validate the required artifacts when preparing the release for
   execution. A missing or invalid artifact fails before the workflow starts.
   The old and new release never mix during
   publish or restore. Integrate with existing execution cache invalidation
   and the public route’s current access check. A warm endpoint run should
   add no dependency-pointer queries, extra permission lookups, object reads
   or files written. Separate cold and warm latency measurements.
5. **Keep captured artifacts reachable.** Extend the existing
   [object reference verifier](../../packages/studio-server-api/src/routes/workflows/managed/workflow-object-references.ts)
   so retained manifests keep their exact object keys alive even if a source
   draft is deleted. Reuse the existing durable cleanup path. Retain one
   manifest for all its history activations, including Restore. Protect
   objects while capture and materialization are in progress. A run that
   already acquired its prepared release retains it until completion, including
   after cache eviction. Exercise deletion, restore, backup and cleanup with
   shared objects and in-flight readers. History still follows the existing
   project retention policy.

Apply current bundle authoring rules when capturing a release. For example, a
bundle member can call a permitted standalone project. Capture does not grant
permission for ordinary Subgraph lookups across bundle boundaries. Keep the
ordinary API and editor checks in
[Subgraph access](../../packages/studio-server-api/src/routes/workflows/managed/subgraph-access.ts).
Treat published snapshots as data already committed to that publication. A
permitted move or rename of a draft updates its ordinary tree location and the
next Publish review. History retains the captured location and may only serve
a member actually captured for the authorized history entry. Endpoint access
changes and unpublish continue to control who can invoke the live release.

### Restore and older history

- Replace the draft-mutating Restore in
  [publication HTTP](../../packages/studio-server-api/src/routes/workflows/publication-http.ts)
  and its backend adapters. Preserve route identity, current access
  configuration and existing web-app bindings. Validate the selected history
  row, retained manifest, project ownership, expected publication version and
  endpoint ownership. Commit a new Current history row referencing the same
  release and its source history entry. Leave the root draft pointer and all
  dependency draft pointers alone. Remove the dashboard’s post-Restore editor
  reload. Draft saves need their own revision check. They should not fail
  because Restore changed an unrelated live pointer.
- If a project is unpublished and has no current endpoint address, Restore
  must use an explicitly reviewed and available configured address before
  going live. Keep existing collision and access checks. Never take over a
  historical URL now owned by another project.
- Older history captured the root only. Keep old rows readable and
  downloadable. For an old entry with dependencies whose exact revisions
  were never captured, label coverage **Project only** and show exactly what
  is available. Prevent a purported exact Restore of that entry. An explicit
  new publish using the old root and reviewed current dependencies can create
  a protected release if needed for recovery. Show it as a new release. Exact
  Restore remains available for a legacy standalone snapshot when it can be
  verified to have no runtime project dependencies. Exact dependency history
  starts when Rivet first captures the release.
- Before replacing an already-live legacy endpoint for the first time,
  capture a rollback point from its current published root and the dependency
  selections it resolves now. Use the same review, validation and retention
  rules. Mark the capture time explicitly. Keep the checkpoint and new
  activation in the same transaction after both sets have been validated.
  If the live version cannot be captured, explain that the previous release
  cannot be restored exactly and require explicit acknowledgement before
  replacing it.
- Keep the existing standalone project download. For a dependency release,
  Download produces an archive of the exact stored manifest and artifacts.
  Reuse the existing bounded archive writer. Use the normal bundle format
  only when it can faithfully represent all captured bindings and versions.
  Otherwise ship a labeled revision archive for inspection and recovery.
  Import as an editable bundle is outside this feature. A missing artifact
  stops the full download with a useful error.
- Deliver frozen dependency sets first in managed PostgreSQL/object storage,
  including local managed development. Implement live-only Restore for the
  existing standalone filesystem and SQLite backends that expose it. Surface
  capability and coverage explicitly on older configurations. An active
  protected release must fail visibly if the storage or reader cannot honor
  its manifest.

## 3. History preview in the project tree

**Preview** opens the selected root revision and switches the sidebar into
**History preview**. Show the endpoint and the history timestamp, short copy
such as “Browsing the project revisions captured for this endpoint,” and an
**Exit history preview** button. Reuse the project tree’s row, folder,
keyboard and selection patterns and the comparison mode’s session ownership.

- Show the root and the captured referenced projects, including transitive
  dependencies within and outside the bundle. Keep their ancestor folders as
  recorded at Publish and prune empty branches. New captures record each
  applicable bundle path for the normal bundle glyph. Before committing, verify
  the prepared paths and bundle memberships under the topology lock. Older
  root-only entries can display the bundle glyph at the root project's current
  recorded path. Exclude unrelated projects even when they share a folder or
  bundle with a captured one. Mark the root and distinguish multiple frozen
  revisions of the same project by selector
  and revision date. Choose rows by artifact identity, so matching names
  never collide. Selecting a project opens its frozen editor tab. Closing an
  editor tab leaves the mode active until the user presses **Exit history
  preview**.
- Return a small manifest/tree response first. Fetch the selected project and
  its data lazily through authenticated history handlers scoped to the history
  owner and captured artifact. Use retained ID and captured path data.
  Give each pending History preview selection a cancellation signal before
  queueing it in the editor. A newer selection supersedes it. A live project
  selection or comparison action cancels a pending history tree request.
  Exit cancels pending work from its session and releases the dashboard's
  selection gate.
  Acknowledge skipped opens without an error toast. Preserve unrelated tabs,
  unsaved work, and the ordinary tree expansion and selection on exit. Keep
  the history back and forward shortcuts working inside the preview and across
  the return to normal editing.
- [HostedIOProvider](../../packages/studio-server-web/io/HostedIOProvider.ts)
  gives the detached history tab a temporary project ID. The history provider
  uses it to resolve the captured call site by source artifact, source graph,
  node, selector, target project and target graph.
- Keep isolated editor-tab and dataset namespaces, and carry the real
  snapshot identity in a read-only per-tab context. The Subgraph node body,
  settings, target name, ports, and every **Go to subgraph** path must resolve
  using the selected release, source artifact and graph/node binding. Same
  project, same bundle and external references then open the actual frozen
  graph. The historical provider never queries the live catalog or substitutes
  a current graph. If a legacy or unreachable graph’s target was not captured,
  show “Target unavailable in this revision” as one compact node label and
  display its saved interface if available. Preserve the live provider for
  ordinary tabs.
- Block save, publish, run and dataset mutations for historical tabs. Keep
  Preview read-only even when a normal editable tab for the same project is
  already open. The sidebar provides the exit action for History preview.
  Editor read-only enforcement stays active without the ordinary Git-history
  notice, canvas border or execution buttons. Back/forward entries and late requests must keep
  the right tab context. Exit cleans up only tabs and state owned by that preview.

## 4. External references in the normal tree

Put a clickable **N external references** action beneath the bundle name whenever
its saved members reference projects outside it. Count distinct external
target projects directly referenced from any saved member, including a member
that is unused by an endpoint. Multiple call sites to the same project count
once. An external project's own dependencies are transitive and appear in the
release preview and status when used by the endpoint.

Use the saved reference index and live bundle membership to compute this
summary. Load details through the authenticated bundle read route and show
its results in the standard modal. Use the existing persistent project open
command. Group by source bundle member, then by Subgraph location within that
project. Show each referenced project's name, path and **Open project** action
beneath the location. The source heading's tooltip shows its path and when its
revision was saved. **Open project** uses the normal editor tab flow and
preserves any open unsaved tab. Missing targets remain identifiable and cannot open a
different project that has reused their old path.

Use a real accessible button separate from the folder row's expand and drag
actions. The tree must remain usable during indexing. Show known counts and
coverage honestly. Zero means confirmed empty, so display no badge for a
complete zero. A partial or unavailable result may refresh as the existing
bounded summary backfill catches up. Keep index reads off the critical path
for opening the tree and do not scan project bodies on tree refresh.

## 5. Unpublished changes and reference markers

Use one saved-state calculation for the endpoint details, Published Items and
project tree. Compare the active release to the root and relevant selections a
new Publish would use. Match artifact identity, using the existing managed
save deduplication rules for identical content. Use indexed manifest bindings
and batched current selectors. Changes at a reachable dependency make the
caller dirty even when its root stayed the same. When an upstream revision
changes its references, that dependency is already dirty. Refresh the exact
transitive set for review at the next Publish. Unrelated workspace changes do
not dirty the endpoint. Detect changed, missing and no-longer-valid selections.
Incomplete coverage stays explicit. Older history with unverified dependencies
must not quietly show as fully matched. Local development with its own
PostgreSQL and MinIO captures dependencies on Publish by default. For a
preceding legacy publication, the status prompts an Update when capture is
available.

- The reference-icon pill beside **Unpublished changes** appears when at least
  one saved dependency selection has changed or become unavailable. It opens a
  modal with the project name, current path, active revision and saved
  selection where known, and **Open project**.
  Root-only changes keep the existing status pill by itself. Group multiple
  call sites or paths to the same referenced project so each project appears
  once. Distinguish a changed dependency from an unavailable one.
- During Publish, use the editor’s
  [dirty-project feed](../../packages/studio-server-shared/editor-bridge.ts)
  to prompt for a save when the root or a selected draft has unsaved edits.
  Key the feed by stable project ID and editor generation and include hidden
  editable tabs. History, recording and other read-only tabs are excluded.
  Recompute publication status and discover new reference relationships
  after Save.
- Keep the existing solid publication dot for a project’s own publication.
  A referenced project gets a **hollow yellow circle** if its own relevant
  saved selection differs from at least one active release or has become
  unavailable. It gets a **hollow green circle** when its saved selections
  match the captured revisions in at least one verified published release.
  This applies to direct and transitive dependencies. Changes to the caller
  or another dependency leave a matching dependency green. Yellow wins when
  the dependency differs in another active release. A project may have its
  own solid dot and a separate hollow circle. Give the circles meaningful
  accessible labels and tooltips. Unknown coverage alone earns neither
  hollow marker.
- Deliver a small, batched reference status projection alongside the ordinary
  tree. Keep the last accepted projection visible while the current generation
  loads, and discard responses from superseded generations.
  Refresh on existing save, publish, restore, unpublish, topology and index
  change notifications. Reuse the app’s aggregate status rules for unrelated
  web apps and the existing publication icon components. Avoid broad
  per-project polling and dependency scans at execution time.

## 6. Implementation order and acceptance

1. **Storage and execution.** Add the managed schema, manifest builder,
   readers and retention support. Thread the release through the narrow
   published execution boundary. Verify the real processor with a disposable
   PostgreSQL/object-storage stack. Cover internal and external routes,
   nested and legacy references, both selectors pointing to different
   revisions of the same project, disabled/cyclic/dynamic calls, dataset and
   attachment identity, scope rejection and bounded failures.
2. **Publish, history and restore.** Extend the existing command and reviewed
   preconditions. Add release-aware history read and download, live-only
   Restore and old history coverage. Use the A/B/C scenario above, with an
   external transitive dependency too. Prove staleness rejection during
   Publish, compare-and-swap on Restore, stable URL/access, and byte-for-byte
   unchanged drafts and datasets across both operations. Interrupt the
   publication transaction and simulate a lost acknowledgement and a stale
   reader. A failure must never produce a partial publication or replace an
   existing release. Extend the existing
   [managed history tests](../../packages/studio-server-api/src/tests/managed-publication-history.test.ts)
   and filesystem/SQLite restore tests. Verify artifact retention and recovery
   across deletion and backup/restore.
3. **Preview.** Add the history tree session and scoped editor resolver,
   then wire the renamed tab and existing actions. Cover nested folders,
   unrelated projects hidden, duplicate names and two revisions of one
   project. Verify all Subgraph navigation surfaces, graph labels and ports,
   read-only mode, closed tab behavior, Page Up/Down, explicit exit,
   unsaved tabs and a slow response arriving after a mode switch. Keep the
   existing bundle comparison and ordinary cross-project navigation checks.
4. **Tree reference UI.** Add batched saved summaries and the two detail modals.
   Cover one and multiple callers, direct and transitive dependencies, green
   and yellow precedence, undo/close/save across editor tabs, a Published
   choice unaffected by draft edits, and independently changed endpoint and
   web-app status. Exercise missing objects, incomplete index coverage,
   topology moves, and click and keyboard behavior next to ordinary tree
   controls.
5. **Local and release verification.** Use the applicable API and editor
   suites, the existing project settings Playwright check, and a focused
   history journey with `PLAYWRIGHT_HEADLESS=1` and `PLAYWRIGHT_SLOW_MO=0`
   via `yarn studio-server:ui:observe`. Compare warm endpoint p50/p95 and
   cold dependency materialization against the baseline for a standalone
   endpoint and a bundle with representative external references. Gate on
   no added warm storage round trips and no material warm latency regression.
   Measure tree payload and DB query counts on a populated workspace. Qualify
   mixed-version reader behavior, backup and recovery before enabling in
   staging, then production when approved.

Deploy additive schema and compatible readers to every control and execution
replica before enabling protected publication writes. During the mixed-reader
rollout, existing endpoint pointers remain valid. After a protected release is
active, deployment rollback must retain a manifest-aware reader. Enforce that
restriction in rollout preflight. Disabling new captures must still honor all
existing manifests. If activation is interrupted, preserve the active pointer
and all retained manifests. Adoption is explicit on the next
successful Publish. Existing endpoints continue serving under their current
contract until then.

Update [Workflow Publication](workflow-publication.md),
[Project Bundles](project-bundles.md), storage and rollout documentation, and
the applicable Studio Server user documentation as each behavior lands. The
feature is complete when the full shared-dependency scenario, history preview
and status flows pass locally, and the release gate has verified compatibility
without changing any saved draft on Restore.

## Local validation

The managed integration fixture uses isolated PostgreSQL and S3-compatible
storage. It exercises schema 22 lock contention, stale publish review,
independent restores with a shared transitive dependency, legacy baseline
capture, both selectors for one project, an unavailable artifact, history
metadata, the release archive and retention after draft deletion. It also
interrupts a publication after release preparation, checks stale Restore
preconditions, verifies captured dataset isolation, and observes the catalog
refresh after reference backfill. It imports legacy publications to exercise
Update while new Publish operations capture dependencies automatically. Run
`yarn workspace @valerypopoff/rivet-studio-server-api test:endpoint-releases-managed`.
It starts disposable local Docker storage. Both
`RIVET_TEST_HISTORY_DATABASE_URL` and `RIVET_TEST_HISTORY_OBJECT_URL` can be set
to use an existing disposable loopback fixture. The optional
`--measure` switch profiles cold startup and warm endpoint p50/p95 in both
floating and protected modes for a standalone endpoint and a bundle with
nested references. Both public and internal warm lookups assert the storage
read budget. The same switch records query counts and payload sizes for the
tree and reference overview with 120 additional saved projects.

The maintenance checks render fenced schema 22 on the existing two-pool HA
layout and the single-worker staging profile. The managed migration fixture
asserts that a legacy Restore inventories project and dataset objects retained
only by a frozen release, then clears that inventory while preserving unrelated
SQL and object data. The PostgreSQL schema verifier compares all existing draft,
artifact and publication values across the upgrade, including the new empty
release fields on legacy history rows. Release-image and hosted qualification
are verified separately during release preparation.

The endpoint graph unit test is included in the default API CI manifest. Run
`yarn test:style` to check that CI covers the new test and that the reviewed
shared-contract, HTTP-error and editor imports match the exact file-tree inventory.

The Playwright published revision history spec covers history navigation, frozen
Subgraph ports, Page Up/Down, and exiting during a delayed artifact read. It
verifies legacy capture, live-only Restore at the freshly reviewed address,
recovery from lost or incomplete publication responses, same-path project
replacement, incomplete release review and both reference details dialogs.
The storage tests also cover rejection of unreadable saved release datasets,
replacement of a broken legacy release after explicit acknowledgement,
history ownership checks, live-only Restore without a draft precondition,
and backfill of a damaged current-format reference summary.

## Follow-up refactor

### What a history entry guarantees

A managed saved revision identifies the project and optional dataset bytes
stored under revision-specific object keys. A history row in
`workflow_published_versions` records a Publish or Restore of that root
revision. Its own ID, activation time, star and comment describe the event.
It points to a release in `workflow_endpoint_releases`, which stores the
root artifact, entry graph, captured paths and exact graph bindings. Each
`workflow_endpoint_release_projects` row pins the object keys for one
revision. The editable draft pointer and the active history pointer are
separate. A Restore adds an activation pointing to an existing release and
records its source history row. See the
[save writer](../../packages/studio-server-api/src/routes/workflows/managed/revision-factory.ts)
and [release schema](../../packages/studio-server-api/src/routes/workflows/managed/endpoint-release-schema.ts).

- **Publish.** Prepare and validate the saved object bytes outside write locks.
  The dashboard's review token binds the submitted operation to the reviewed
  manifest. Recheck the project, publication version, saved selections and
  bundle topology under the write locks. Commit the pins, history row and
  endpoint pointer together and deliver cache invalidation after commit.
  The transaction is the activation boundary. The dashboard refreshes from
  persisted state when it loses the response.
- **Run.** Resolve the active history ID and load its release before graph
  execution. Validate owner, root, pins and artifact contents on a cold load.
  A warm run shares prepared immutable artifacts and gets its own dataset
  providers. A missing captured target fails explicitly. If the same project
  is called via **Saved latest** and **Published**, each selector can bind a
  different revision. Published selects the target project's published root
  revision at capture time. The caller's own release then resolves that
  graph's transitive calls. It is independent of the target endpoint's release.
- **Restore.** Verify the selected release and artifacts first. Revalidate
  the reviewed project and publication version, then activate the older
  release at the current address and access policy. If two endpoints share C,
  restoring the first to its captured C1 leaves the second serving C3 and
  leaves the editable C at its current revision. In-flight runs retain the
  prepared release they acquired. Filesystem and SQLite use their own
  project-only snapshots and live-only Restore.
- **Preview, Download and annotations.** An exact preview uses the captured
  tree and source call site, including references to a deleted or moved
  project. Preview validates membership in the selected release and loads
  only the requested artifact into a read-only tab. Download uses the selected
  history's artifacts and emits a revision archive
  when it needs to represent dependencies or datasets. Stars and comments
  update history metadata.
- **Retention and rollout.** Cleanup and backup/restore inventory include
  objects retained solely by release pins. Recovering a release requires
  matching PostgreSQL metadata and object bytes. Schema 22 is the reader
  floor once protected releases exist. Capture is enabled after all serving
  readers understand it. Keep the existing rollout and backup gates.

A legacy entry can be previewed and downloaded with **Project only**
coverage. Exact Restore requires either a retained release or a verified
standalone root. The first protected update can capture the legacy endpoint
as it resolves at that moment, with the capture time recorded. Dependencies
from earlier legacy activations are recoverable only if their exact
revisions were recorded. This guarantee covers saved workflow graphs and
datasets. Endpoint access, runtime libraries, server settings and external
services have their own lifecycle.

### Implementation

1. **Correct coverage at the metadata boundary.** The reference overview
   validates the manifest version, root, owning project and bindings before
   comparing current saved pointers. A broken active history pointer or
   invalid capture reports project-only coverage. This uses the existing
   bounded database queries. The release
   reader also checks pin ownership and object keys, then validates content
   when cold execution, Restore or the archive builder needs the bytes.
2. **Derive the dashboard's publication status once.** The
   [publication projection](../../packages/studio-server-web/dashboard/workflowProjectPublicationStatus.ts)
   computes saved dependency status against stable IDs. The tree row uses
   one derived status for its class and dot. The active card, Project
   Settings and Published Items use the same rules and keep the catalog
   project intact. Pending refreshes keep the accepted reference markers until
   the latest request settles. Web apps keep their individual status and refresh
   from saved project state.
3. **Own preview navigation within the history session.** The
   [dashboard hook](../../packages/studio-server-web/dashboard/useWorkflowHistoryPreview.ts)
   opens and cancels published history tabs through the existing bridge.
   A new live navigation intent or bundle comparison supersedes a history
   tree request while it loads.
   The [editor resolver](../../packages/studio-server-web/dashboard/hostedHistorySubgraphs.ts)
   indexes each loaded session by the captured call site and revision. It
   reuses the bounded artifact cache and retains the browser's ordinary
   tree, graph navigation and read-only protections.
4. **Give capture and reads separate owners.** The
   [capture module](../../packages/studio-server-api/src/routes/workflows/managed/endpoint-releases.ts)
   retains preparation, review tokens, locking and persistence. A single
   [manifest parser and binding index](../../packages/studio-server-api/src/routes/workflows/managed/endpoint-release-manifest.ts)
   supports the reference overview and
   [reader](../../packages/studio-server-api/src/routes/workflows/managed/endpoint-release-reader.ts).
   The reader verifies the saved project identity for Preview and shares
   its artifact index with the existing execution cache, which supplies
   per-run dataset providers. This preserves schema 22,
   review token serialization, and the active pointer and backup contracts.

### Verification

The publication policy test verifies that Restore still checks the reviewed live
publication version when the saved draft has changed.

The managed CI lane runs the real PostgreSQL/MinIO fixture with
`yarn workspace @valerypopoff/rivet-studio-server-api test:endpoint-releases-managed`.
The command starts isolated local storage when no fixture URLs are supplied.
It checks failed activation, stale review, broken active history pointers,
foreign preview artifacts, missing captured objects, independent Restore with a
shared dependency and artifact retention. The fixture counts database queries
and object reads on both backends. The reference overview uses saved metadata
without reading artifacts. A warm public request can use one database lookup.
A warm internal request uses the cached pointer and release. Both reuse captured
objects. Cold reads exercise the counters, and the `--measure` option reports
timings and storage calls for standalone and nested endpoints and a larger catalog.
Run the local integration commands after `yarn test:style` finishes. The
Graph Builder checks rebuild the Core output those tests import.

The [Published revision history browser spec](../../packages/studio-server-web/playwright-observe/published-revision-history.spec.ts)
shares the project settings route fixture. It runs in the local Playwright
runner and the [editor CI shards](../../scripts/ci/editor-test-shards.mjs). It
covers read-only navigation for saved latest and published
revisions of the same dependency, reference indicators and details, legacy
history, and Publish and Restore review. The navigation test keeps the same
dashboard session and verifies that live selection, a newer history selection,
and Exit cancel the specific pending request. The dashboard and modal-sizing
browser specs also check the Project Settings tab order and history label.
