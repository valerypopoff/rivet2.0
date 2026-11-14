# Runtime-library execution snapshots

Status: implemented locally, 2026-11-14. The original failures below were
reproduced before changing the serving code. Local validation results are recorded
below. No installation setting, cloud runtime library or deployment was changed.

This corrects the snapshot-stability assumption in [Runtime Libraries](./runtime-libraries.md).
It is separate from [hosted execution isolation](./hosted-execution-isolation-plan.md):
neither fix should wait for the other, and thread isolation alone does not fix
mutable dependency paths.

## Confirmed original problem and scope

The failure requires a library activation/removal to overlap a run that can
still use libraries. It is not evidence that every execution mixes dependencies,
or that a particular historical production run was affected.

| Finding                                                                                        | Evidence and consequence                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed cache promotion replaces the physical `current` directory and deletes its predecessor. | `runtime-libraries/managed/local-cache.ts:promoteCurrentRelease`; an existing API module's late dependency load returned release B after it initially loaded A. Removing the current release caused an unvisited dependency load to fail with `MODULE_NOT_FOUND`.                                                             |
| The actual deployment activation is already durable elsewhere.                                 | `managed/artifact-activation.ts` uploads an immutable archive, then commits release/job/activation metadata in PostgreSQL before local reconciliation. The defect is in local materialization and execution resolution; no replacement database or activation controller is needed.                                           |
| Legacy file mode has the same destructive directory swap.                                      | `runtime-libraries/job-runner.ts:activateStaging`. It needs the same physical-retention behavior; fixing only the managed class leaves this mode exposed.                                                                                                                                                                     |
| API request scoping does not make the filesystem immutable.                                    | `ManagedCodeRunner` memoizes its preparation and resolver, but their path can still be replaced. It also clears previous release modules from process-wide CommonJS caches when another runner selects a release.                                                                                                             |
| An initially empty library set is not pinned.                                                  | After an API runner first used builtin `node:path` with no managed packages, installing B let that same runner discover B. Its ambient fallback resolver is not retained. Empty/absent library sets must be explicit snapshots too.                                                                                           |
| SQLite materialization solves only part of the problem.                                        | `local-metadata/runtime-library-authority.ts` retains unique physical directories. An old API module kept version A, but loading B cleared A's cached dependency instance and reset its state. The existing SQLite test checks version bytes, not preservation of the old module instance.                                    |
| The editor sidecar resolves libraries per invocation.                                          | `AppExecutorWorkerCodeRunner` prepares and recreates its resolver for successive calls. The same runner returned A then B. `createCodeWorkerRunRequest` stores a mutable alias; a request prepared under A but dispatched after activation loaded B. Both current-thread and worker paths must use the same per-run snapshot. |
| There are two managed synchronization implementations.                                         | The API cache serializes forced refresh rounds. Bootstrap `sync.mjs` instead awaits the previous promise and lets multiple forced waiters start separate passes. A local reproduction produced three queries with two concurrent follow-up queries. Updating only the API cache misses the executor/bootstrap path.           |
| Cache roots are not necessarily private to one process.                                        | The backend workload mounts runtime-library storage into API and executor containers. The chart also supports existing PVCs. A single process restart is not proof that no other reader needs older directories.                                                                                                              |
| A cache-layout change also affects operational readers.                                        | `migrate-runtime-libraries.ts:createSourceArchive` rejects a symlinked `current` directory; `readSourceManifest` rejects an empty manifest when `current` exists. Both rejected the proposed layout locally. Migration, restore, backup and recovery checks need explicit compatibility coverage.                             |

The local diagnostic receipts are Git-ignored under
`artifacts/runtime-library-snapshot-review-20261114/`. They use generated packages,
temporary directories, stubbed database/object-storage calls and the real runners;
no npm download or production access is involved. The current focused suites also
pass (21 tests, one Windows-specific atomic-link test skipped), demonstrating that
existing coverage misses these overlapping-run cases.

The additional layout checks are recorded in `plan-gaps-result.json` in that same
ignored directory. They test current readers against generated proposed layouts;
they do not modify an installation or demonstrate a defect in an existing backup.

[Node's module documentation](https://nodejs.org/download/release/v24.22.1/docs/api/modules.html#caching)
explains the relevant behavior: CommonJS identity follows the resolved filename,
and removing cache entries causes modules to execute again. Stable physical paths
and preserving active module caches are both required.

## Required behavior

1. A logical root run selects one library snapshot when its first managed-library
   preparation succeeds. The API keeps its lazy first-`require`
   behavior; preserve the sidecar's existing preparation triggers while making
   them single-flight per run. This does not promise that a run which has not
   touched libraries uses the release active at HTTP admission time.
2. Every later supported managed `require`, Code-family invocation, child graph
   and managed background branch in that root uses the same physical release.
   A new independent root can select the newly active release.
3. A snapshot records an empty library set as explicitly as a populated one.
   Installing the first package or removing the last cannot change an already
   bound root's resolution.
4. Activating B does not delete A, clear A's live module objects or silently move
   an existing run to B. This includes a dependency that A loads only after an
   `await`, a debugger pause or a foreground response.
5. Preserve Node's supported require behavior, managed package/native resolution
   and normal desktop fallback. Preserve existing module identity within the
   same isolate; ordinary sidecar Code workers already have separate module
   caches. They must agree on release bytes, not share module objects or require
   a new worker-pool design. Intentional mutation of package files, `require.cache`
   or a mutable absolute path remains outside this guarantee.
6. Preserve the existing PostgreSQL/object-store activation outcome rules and
   SQLite authority. A local extraction failure does not undo a confirmed
   database commit or report an unverified cache as ready.

## Minimal implementation design

### Immutable local releases and an explicit prepared snapshot

Use a small in-memory snapshot descriptor containing the release identity,
integrity identity and absolute physical package directory. Accept it only from
trusted host preparation, never uploaded graph settings or action input. Treat
`current` as a compatibility/discovery alias, never as a saved execution anchor. The preparation
operation must return the exact descriptor it prepared; do not subsequently
combine `realpath(current)` with a separately read manifest that another publisher
may have changed.

Reuse the existing SQLite cache-directory convention for managed and legacy
materialization; do not migrate SQLite to another layout:

```text
<runtime-root>/
  cache-<UUID>/
    package.json
    node_modules/
    <validated-release-metadata>
  manifest.json              # existing manifest, with private cache-location metadata
  current -> cache-<UUID>     # compatibility only, where safe to maintain
  jobs/                                        # disposable preparation
```

Prepare in a unique directory, validate the archive and package layout, then
publish a complete release without overwriting an existing physical release.
Extend the existing manifest with a format/version and a confined relative cache
location; publish it with its existing atomic replacement. Do not introduce a
second mutable active-pointer file. In managed mode this remains a rebuildable
cache hint; in legacy file mode the existing manifest remains the authority.
SQLite keeps its catalog authority and returns its prepared path directly.
Keep these cache-location fields internal; existing runtime-library API responses
do not need new filesystem paths.
An existing destination may be reused only after its ownership/integrity identity
matches; a conflicting destination is an error, not permission to replace it.
Represent three outcomes distinctly: unconfigured ambient Node resolution, a
confirmed empty hosted release, and failed preparation. Only the first is an
ambient fallback. The second has a stable empty package directory; the third
fails that preparation without invoking Code or silently selecting another
release. A missing descriptor, unreadable manifest or corrupt hosted cache is
not evidence of an empty release. A recognized legacy manifest is adopted and
validated first; do not mistake a supported old format for corrupt new metadata.
Resolve only owned, confined cache-directory names, including on Windows.

Reuse SQLite's established confinement and extraction checks. Do not turn this
into a rewrite of its catalog or archive authority. Put shared filesystem and
descriptor operations in `packages/studio-server-bootstrap/runtime-release-cache.mjs`,
with a declaration and explicit public subpath. Keep it independent of PostgreSQL,
settings and S3. Declare the API workspace dependency and update runtime inclusion
checks; preserve existing bootstrap import paths when declaring exports. Do not
add a forbidden deep import or a second implementation. The generic
Node/sidecar require boundary receives only a prepared anchor/binding, without
taking a dependency on Studio Server storage or starting its services.

Preparation returns a snapshot for the authoritative release observed by that
preparation, not a globally simultaneous activation across all replicas. Shared
cache publishers may prepare different releases concurrently. Their candidates
must be unique, completed releases immutable, and each caller must receive its
own prepared descriptor. No execution reader may depend on which publisher most
recently changed a compatibility alias. Readiness reports the actually prepared
release, with the database's target release kept distinct.

### Bind the resolver once per root

Change the internal preparation contract to return the descriptor instead of
only `void`. Retain one single-flight preparation/snapshot promise per logical
root, including its ambient/empty result. New standalone roots get new bindings;
subgraphs and managed tails inherit the parent's binding.

Keep the binding on the runner already created by the hosted root factory. Audit
endpoint, HTTP/socket action, schedule and Evaluation factories for fresh runners;
do not add a new Core run-lifecycle API solely for this fix. Concurrent first uses
share the same preparation promise. A failure leaves no partial binding and does
not invoke that Code operation. Preserve the owning surface's retry policy: this
change adds no automatic retry, and any later permitted attempt before binding
must inspect/reuse completed cache publication rather than repeat an npm install.
Once binding succeeds, it never changes during that root.

- **API:** `ManagedCodeRunner` constructs and memoizes its Node resolver directly
  from the returned physical path. Stop invalidating an older release's module
  cache when a newer release starts. Keep compiled-function and resolver caches
  bounded independently; eviction of a resolver lookup must not clear live
  CommonJS objects. The force-prepare diagnostic may repeat its check, but must
  not rebind an already selected root to another release.
- **Editor sidecar:** `AppExecutorWorkerCodeRunner` binds the same snapshot for
  current-thread and worker execution. Pass its physical require anchor explicitly
  into `createCodeWorkerRunRequest`, before queueing. A prewarmed worker must use
  the request's anchor, not its startup environment or the current alias at dispatch.
- **Existing Node consumers:** preserve ordinary desktop/default require
  behavior. Do not impose hosted package policies on unconfigured Node callers.
- **Nested graphs:** verify actual `GraphProcessor` context inheritance, including
  cross-project Subgraphs and managed async/continuation branches. Do not create
  another snapshot for children belonging to the same root. An authored call that
  deliberately starts a separate standalone runner remains a new root.

Check supported launch `NODE_PATH`/custom require anchors as part of this change.
They must not let a pinned empty/old release fall through into a newer mutable
managed tree. Preserve builtin and supported ambient dependencies; do not mutate
process-global module paths during concurrent runs. Explicit legacy overrides
need either a validated stable anchor or a clear compatibility error.

The hosted preparation result must be explicit. A legacy hook returning `void`
is not permission for a configured managed consumer to reread `current` and
guess its release. Keep unconfigured/custom desktop behavior separate, and fail
clearly for an incompatible hosted producer/consumer pair.

Do not promise hot replacement of every native addon. Test the supported native
package path; if a demonstrated addon cannot coexist with its previous version
in one process, require controlled restart for that upgrade instead of hiding an
unsafe reload behind cache deletion.

### Operational readers and archive compatibility

Use one reader for the selected manifest plus its verified physical directory.
Update runtime export/migration, restore preparation, recovery checks and space
estimation to consume that pair; resolving `current` independently is a race.
Accept legacy real-directory sources, valid new cache metadata and confirmed
empty releases, while rejecting ambiguous or out-of-root paths.
Resolve new metadata to a validated real directory; do not simply relax the old
directory checks to follow arbitrary symlinks. An empty manifest with an
unverified or unreadable tree must still fail validation.

Keep the existing exported archive formats. A selected-runtime export includes
only its selected release. A full browser backup still includes its promised
source bytes and retained history: do not silently change its coverage or its
certification fingerprint to save space. Its size estimate must include retained
caches. Do not apply a general "exclude inactive caches" rule to full backups.
Restore normalizes only the verified extraction, never a live source tree.

### Retention and synchronization

Do not introduce database leases, per-node registrations, cache-reference counting,
an RSS polling gate or a new garbage collector. Retain completed physical releases
for the lifetime of all processes using that cache root. This also covers late module loads from outputs,
recording serialization and callbacks that are not tracked by a graph counter.

- Never delete an older release as part of activation/removal.
- Prune only generated, owned paths after a supervisor/maintenance boundary has
  established that **all** readers of that root are stopped. API-only restart or
  bootstrap startup does not establish this in a shared root.
- Do not add automatic cache pruning in this change. The SQLite initializer
  also runs on API-only reloads, so it cannot establish exclusive ownership.
  Leave reclamation to Pod removal or explicit quiescent maintenance.
- Default ephemeral Kubernetes caches disappear with their Pod. Persistent/shared
  caches require the same explicit quiescence proof before pruning.
- Inspect free space and bound extraction; on insufficient space, fail preparation
  clearly while preserving existing releases. Respect the configured cache volume
  limit rather than increasing reservations silently. Do not evict a pinned
  release to make room for the next one.
- Keep remote historical-archive pruning separate: the current PostgreSQL/S3
  cleanup is not a license to remove locally referenced physical directories.

Measure retained disk and process RSS across repeated updates. If retention
cannot fit the existing installation envelope, require a graceful cache-owner
restart before further updates. Keep any space checks on preparation/install
paths, not each Code invocation, and preserve existing runs on failure.

Bring bootstrap forced synchronization under the API cache's existing serialized,
coalesced round behavior. A forced caller must wait for a round that observes its
request; parallel waiters must not fan out concurrent writers. Do not add sleeps,
blind retries or repeat an installation/activation after an uncertain result.

## Ordered work and owning files

1. **Add failing behavioral regressions first.** Extend
   `src/tests/managed-code-runner.test.ts`, `runtime-library-local-cache.test.ts`,
   and the sidecar's `codeRunnerRequire.test.mts` /
   `AppExecutorWorkerCodeRunner.test.mts`. Promote the generated local cases below
   into their owning suites, using explicit gates rather than timing sleeps.
2. **Implement physical publication and prepared descriptors.** Update
   `runtime-libraries/managed/local-cache.ts`, `manifest.ts`, `backend.ts`,
   `filesystem-backend.ts`, `job-runner.ts`, and bootstrap `state.mjs`/`sync.mjs`.
   Keep `managed/artifact-activation.ts`'s durable transaction intact. Update its
   mocks/tests only for the changed preparation result.
3. **Bind API and editor roots.** Update `managed-code-runner.ts`,
   `AppExecutorWorkerCodeRunner.mts`, `codeRunnerRequire.mts`, and
   `codeRunnerWorkerHost.mts`. Adapt the bootstrap preparation hook and SQLite
   authority to provide the descriptor without adding another authority. Verify
   hosted factories create fresh bindings for new requests/actions/trials.
4. **Handle lifecycle and operational compatibility.** Update `startup.ts` and
   the backend supervisor/bootstrap hooks only where needed for safe ownership.
   In `scripts/migrate-runtime-libraries.ts`, replace independent manifest/current
   reads with one validated source selection. Adapt `legacy-restore/runtime-preparation.ts`,
   `legacy-restore/import-worker.ts`, `legacy-restore/runtime-layout.ts`,
   `local-metadata/stage-local-metadata-candidate.ts`, `operator-service.ts`,
   `browser-backup.ts` and `copy-capacity.ts` where they assume the old layout.
   Preserve archive formats and full-backup scope. Test container restart
   separately from full Pod/host shutdown and update runtime inclusion checks.
5. **Validate correctness and performance locally.** Run the targeted suites,
   maintained API/Node/sidecar builds, packaging checks and benchmarks below.
   Correct the documentation to match the tested semantics.
6. **Publish and qualify separately when authorized.** Use the existing staging
   workflow. After the candidate's cache consumers are upgraded and healthy, run
   one bounded A-to-B library activation with an old endpoint/editor run held
   open. Then use the usual production rollout path. Do not add a second full
   staging campaign for this probe. This plan does not authorize cloud work.

## Required regression cases

- Start under A, load one dependency, hold on a gate, activate B, run B, resume A.
  Assert old/new versions, lazy transitive loads and old dependency object identity.
- Remove a package and remove the entire set. Old bound runs still load A;
  new runs cannot use removed managed packages. Start with no libraries, install
  B, and verify an already bound empty run does not discover B.
- Repeat across two Code nodes, cross-project Subgraphs and post-response async
  work. Repeat with editor current-thread Code and ordinary worker Code. A worker
  request queued under A must still load A when dispatched after B activates.
  Ordinary per-invocation workers must retain their existing fresh module state;
  pinning must not introduce shared objects across workers.
- Change package `main`, `exports` and a nested dependency. Preserve `require`
  features already supported and test an existing supported native dependency
  without adding a paid provider or downloading packages in the core regression.
- Force simultaneous preparation calls during an older blocked sync. Assert
  bounded coalescing, correct returned descriptors and no unverified readiness.
  Include two real local processes sharing a cache root.
- Reject a missing/malformed hosted descriptor, an escaping cache path and a
  legacy `void` result from a configured hosted producer. Confirm that recognized
  old formats adopt safely and unconfigured desktop fallback still works.
- Export and restore a nonempty and an empty new-format release, plus a legacy
  source. Verify selected-runtime export uses the matching manifest and bytes;
  full-backup fingerprints and capacity accounting still include their promised
  contents. Recovery validation must not depend on a stale compatibility alias.
- Break archive integrity/layout, deny publication, exhaust candidate space and
  cancel preparation. No partially published release, mutation of A, missing
  prepared snapshot or false successful activation is allowed. Preserve committed
  activation with cache-error reporting when database publication already happened.
- Crash between completed extraction, local descriptor publication and cache
  reporting. Restart reconciles from the existing authority. Cleanup must not
  touch unrelated paths, links, live readers or unowned directories.

Keep pure resolver and state-machine regressions in fast normal CI. Place real
process/native/platform cases in the existing integration lanes. The current
green tests originally verified only the new runner/new release result and a saved
old resolver. The new tests additionally cover same-root stability and module-object identity.
Replace assertions that require clearing old release modules; retain meaningful
bounded resolver/compilation-cache checks. A resolver lookup's LRU lifetime is not
the lifetime of a module still used by an old run.

Reuse the existing endpoint and actual editor/sidecar harnesses for integration.
Audit other hosted surfaces through their shared factories and targeted existing
tests; do not create a duplicate end-to-end matrix for every transport.

## Validation and acceptance

Use the pinned Yarn version and current package scripts. Initial targeted commands:

```powershell
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api test:files src/tests/managed-code-runner.test.ts src/tests/runtime-release-cache.test.ts src/tests/runtime-library-local-cache.test.ts src/tests/runtime-library-artifact-activation.test.ts src/tests/server-resource-lifecycle.test.ts src/tests/workflow-async-response.test.ts src/tests/legacy-restore.test.ts
node .yarn/releases/yarn-4.17.1.cjs exec tsx --test packages/app-executor/bin/codeRunnerRequire.test.mts packages/app-executor/bin/AppExecutorWorkerCodeRunner.test.mts
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-api build
node .yarn/releases/yarn-4.17.1.cjs workspace @valerypopoff/rivet-studio-server-bootstrap build
node scripts/checks/check-doc-links.mjs
```

Run packaged Linux Node 24 and Windows executor checks for the final public
exports/worker-anchor changes. Any actual editor behavior change also requires
the repository's headless `studio-server:ui:observe` flow. No Kubernetes rehearsal
is needed just to investigate or implement this locally.

Preserve lazy preparation: no new database/network step for ordinary no-require
runs, no preparation per subsequent Code node, and no repeated extraction on a
warm unchanged release. Benchmark no-Code, repeated require, mixed Code-family,
async/nested and large-input requests using the same source/runtime/load. The
accepted small-run bound remains at most **1 ms added p95**; keep the separately
frozen **5 ms** bound on the local **8 MiB** fixture. Passing a small synthetic
benchmark does not replace the real endpoint/sidecar regression or capacity test.

Complete means all supported hosted execution paths use one verified physical
snapshot per root, existing same-isolate module objects survive unrelated activation, new roots
observe new releases, empty releases are stable, cleanup is reader-safe, and
performance remains within the accepted bounds. A directory change alone is not
completion.

## First rollout and recovery

Keep library install/remove operations paused while old and new cache writers
coexist; normal traffic continues. Staging's A-to-B probe occurs after this mixed
writer period, not during it. Fresh per-Pod caches initialize the new layout.

For a shared legacy root, leave `current` and its files untouched while validating
and copying them to a new immutable directory. Official new consumers use the
prepared descriptor; compatibility aliases and old files are retired only at a
proven quiescent boundary. If a safe copy/ownership boundary cannot be established,
stop adoption and require quiescent maintenance. Never silently rename a live
legacy tree or infer quiescence from one API process restarting.

On a failed local preparation, retain existing directories and report the failure.
On a confirmed remote activation followed by failed extraction, repair local
materialization from that committed archive; do not re-run npm or roll back the
database silently. Do not downgrade to a destructive old cache writer against
the new shared root. A rollback needs either a fresh disposable cache or a
quiescent compatibility restoration using the existing release authority.

No new database schema, cloud service, broker, package-management UI or automatic
workflow retry is part of this fix. Cache/entrypoint compatibility, not image build
speed or full worker isolation, determines its release prerequisites.

## Local implementation record — 2026-11-14

The serving implementation is complete. Publication, validated source selection,
and serialized synchronization now share `runtime-release-cache.mjs`. API and
editor root runners retain the returned physical binding. SQLite keeps its
existing catalog/link authority; migration and restore use a paired source
selection without persisting local cache pointers into portable manifests.
No production or staging activation was performed.

Behavioral checks cover old/new/empty releases, module identity and lazy loads,
real cross-project Subgraphs, post-response work, queued real Code workers,
concurrent publishers, a second process and crash after manifest publication,
readiness synchronization, native-addon coexistence, invalid paths, and space
failure. The actual published endpoint test returns A, completes its delayed
background branch under A after activation of B, then returns B on the next run.
The existing backup suite also checks retained cache history and fingerprints.
Archive validation failures are normal rejected preparations; a tar filter must
not throw from the library's stream callback and create an unhandled rejection.

Windows API, sidecar and packaged-sidecar builds pass. Linux Node 24 compiled
tests cover the same cache/endpoint/backup paths, including POSIX link replacement.
The native coexistence fixture uses the already installed SWC addon on Windows;
the slim Linux runtime image excludes that development dependency and skips that
one fixture. This is not a claim about arbitrary third-party native ABI upgrades.
The shared helper is included by the container runtime packaging test.

The headless observer passed 21 preview/session/browser integration checks.
An additional live-Code UI scenario was attempted against the static preview;
that environment has no matching live API/executor, so it is not accepted as a
live editor execution proof. Actual Code execution is covered by the sidecar
worker tests and published endpoint test. A live browser check belongs with the
authorized staging activation, not a claim based on mocked HTTP routes.

The before/after loopback HTTP benchmark uses the previous runner, the same
generated graphs, 20 warmups and 300 measured requests per version and case,
interleaved without cloud/provider IO:

| Case               | Windows added p95 | Linux Node 24 added p95 | Allowed added p95 |
| ------------------ | ----------------: | ----------------------: | ----------------: |
| No Code            |         +0.005 ms |               -0.033 ms |              1 ms |
| One Code           |         -0.940 ms |               +0.081 ms |              1 ms |
| Sixteen Code nodes |         -2.484 ms |               -0.388 ms |              1 ms |
| 8 MiB input        |         -1.349 ms |               -0.001 ms |              5 ms |

These isolate local runner overhead, not end-to-end production latency. Library
preparation is supplied by the local fixture; database/provider latency is not
included. The Windows report writer failed after the latency assertions passed;
its receipt identifies values recovered from captured output. The Linux report
completed normally. There is no added preparation on no-require nodes and no
new database work per subsequent node.

A separate ordinary-process retention sample loaded twelve generated 512 KiB
JavaScript releases: approximately 6 MiB retained on disk and 30 MiB process RSS
growth without forcing GC. This demonstrates the retention tradeoff, not a
production sizing guarantee. Monitor the real package set and use a graceful
all-reader restart before exhausting persistent cache capacity.

Local receipts are under the Git-ignored
`artifacts/runtime-library-snapshot-implementation/` directory. Temporary benchmark
modules and local observer fixtures are removed from source after validation.
The local Linux fixture needs an executable `/tmp` for its fake npm launcher;
using `noexec` silently falls through to the real npm command on PATH and is an
invalid test setup. No registry download is required.

Remaining delivery work is the already described authorized publication/staging
and production rollout. During the first mixed-version deployment, keep library
install/remove operations paused until every reader/writer uses the new format.

### Follow-up review

The follow-up review reproduced and fixed five additional boundary cases:

- A lost manifest with retained releases was mistaken for an empty installation,
  including by the offline source reader and install/remove jobs. All now
  preserve that state and fail; managed mode can reconstruct the cache from its
  durable authority. Display normalization is not used to derive mutations.
- Matching legacy cache metadata did not prove that its package files matched
  the published archive. Managed API/bootstrap synchronization now downloads and
  validates the authoritative archive once. It leaves the legacy files intact
  and reuses a validated new-format cache on subsequent preparations.
- `drain()` could return in the gap between two accepted synchronization rounds.
  It now drains every recorded round before releasing the IO clients.
- Two bootstrap disposal callers could close the clients while initialization
  still used them. Disposal is now single-flight, and restart waits for it.
- `NODE_PATH` could reach the mutable tree through an outside symlink. Validation
  now checks the physical target as well as the configured path.

The changes remove the duplicate cache-validation read, the managed legacy-copy
branch, an unused hashing helper, and a redundant poller flag. They do not add
per-node preparation, a background service, or a new activation authority.
Each fixed boundary has a local behavioral regression using generated files or
explicit Promise gates.

Reassessment validation passed: the compiled Linux suite ran 103 tests (102
passed; the development-only native fixture was unavailable), the Windows
targeted suites passed, and all four preview-chat browser smoke tests passed.
API/bootstrap builds, import boundaries, test-style checks and documentation
links passed. The normal per-Code execution path is unchanged; the additional
checks run during snapshot preparation or library mutation.

### Adjacent lifecycle review

Two further failures were reproduced before fixing them:

- The SQLite initializer assumed an API restart stopped every cache reader.
  The development API watcher restarts independently of the executor; a saved
  executor module then failed its first lazy dependency load because startup
  had deleted that release. Startup pruning is removed. Unchanged caches are
  reused after checking the catalog's package metadata and archive checksum;
  changed or damaged caches are rebuilt without removing older releases.
  Cache metadata must also agree internally so the API cannot certify a cache
  that the executor would reject.
- Starting synchronization and immediately requesting shutdown in the same
  JavaScript turn closed the clients during initialization. Startup now waits
  only while disposal is actually active, avoiding an unnecessary yield before
  registering its owner. Concurrent disposals still await the same shutdown.

Regression checks use the real SQLite catalog, a retained lazy module and
explicit startup/shutdown Promise gates. They cover repeated startup without
duplicate extraction, changed archives, damaged metadata and client closure
exactly once. The per-Code execution path is unchanged. No automatic cache
collector, schema change or new background worker is introduced.

The Windows and compiled Linux checks each completed with 107 passing tests
and one platform-specific skip (POSIX-only link replacement on Windows; the
development native addon absent from the Linux runtime image). Four headless
preview-chat smoke checks passed. API/bootstrap builds, runtime packaging,
import boundaries, test style and documentation links passed. The compiled
parity suite needs a read-only bootstrap mount at its emitted relative-import
location as well as the normal package mount; an initial missing test-fixture
mount was corrected without changing production code.

### Whole-change review

Review the serving changes separately from the hosted-isolation prototype. The
prototype remains outside the production compiler inputs; its successful worker
tests do not mean production endpoints have moved off the API event loop.

The broader review reproduced and corrected three additional cases:

- A cache could match the managed release ID and package list but disagree with
  the published artifact checksum. Both API and bootstrap now compare that
  checksum before reuse, repair a mismatch and retain old reader files.
- An extracted metadata file could be hard-linked to package code. Writing new
  metadata then corrupted that code. Publication replaces the reserved metadata
  entry exclusively instead of truncating its old target.
- The strict new manifest reader accidentally blocked normalization of an older
  backup layout. Layout normalization again supports that legacy extraction;
  execution and final source validation still require valid package metadata.

Keep `legacy-restore.test.ts` in the local regression selection as well as the
cache/runner suites. It covers the old backup format that the new-format cache
tests alone cannot exercise. The changes add no per-Code database work and no
new service, job or cache collector.

Validation covered a 205-case API selection on Windows and Linux. Both found
the legacy-layout regression above; after repairing it, the 61 affected
restore/cache cases passed again (60 on Linux, with its development-only native
addon fixture skipped). The Windows sweep's other skip is the POSIX-only link
replacement test. The remaining cases in each sweep passed unchanged.
All 32 editor-executor checks, four headless preview-chat smoke checks, the
full 11-group local isolation verifier, API/bootstrap/native-sidecar builds,
production type checking, import/runtime packaging, PnP state and documentation
checks also passed. The compiler input inventory confirms the isolation
prototype is excluded from the serving build. No deployment was performed.

Receipts, including the initial failure rather than hiding it, are Git-ignored
under `artifacts/server-holistic-review-20261114/`. This review does not replace
the planned staging activation across overlapping old/new runs.

### Test maintenance

The snapshot regression tests now use one real old/new-module scenario even
when release IDs are absent and timestamps are unchanged. This replaces three
overlapping import tests, including an obsolete claim that timestamps identify
the module cache. A single compiled-function reuse test checks fresh inputs,
graph inputs, context and globals across runners.

The editor test verifies the executing thread directly. Duplicate builtin-import
and preparation checks are covered by the capability/snapshot tests; fixed CPU
spins and an ordering-only test that did not prove worker entry are removed.
Keep the real queued-worker, native-addon, cross-process crash and shutdown-gate
checks. Their failure modes are distinct and cannot be replaced by result-only
unit tests. Child-process cleanup joins an already-observed close promise, so a
signal exit cannot cause a missed-event wait.

Bootstrap fixtures share only IO stubs, configuration and restoration; scenario
gates and assertions remain in each test. Both managed synchronization adapters
and the late forced-sync drain stay covered. No production code was changed during
this test cleanup. Test-runner/module startup dominates these small suites;
removing code and CPU spins is not a claim of a large CI wall-time improvement.

The three edited suites are 330 lines smaller. The selected API/cache checks
went from 52 to 48 cases; the editor-executor checks went from 32 to 29. Windows
and Linux each pass 47 API/cache cases with their expected platform-specific
skip, and all 29 editor-executor cases pass on Windows. API compilation, test
style and documentation checks pass. Before/after timings remain dominated by
module startup, so these results establish simpler coverage rather than a
significant wall-time speedup.
