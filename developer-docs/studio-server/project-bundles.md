# Portable project bundles

Studio Server's project-row **Download with dependencies** action exports a saved
project and its recursive dependency closure as a ZIP. Ordinary **Download** and
published-history downloads retain their single-file contract. Closing the bundle
dialog does not cancel export, activate a project, refresh the tree or discard edits.
Failed, cancelled and interrupted jobs offer **Retry export** directly: disposal
must succeed before creating a fresh job with the selected bundle-wide version. Ready
jobs retain **Prepare another bundle** for choosing a different version. Job status
includes the optional durable `versionPolicy`; reopening or retrying a new-format
job restores its actual choice instead of the root project's publication default.
Legacy jobs without that field retain the existing default behavior.
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
version is 1; loader capability is 3 for bundle-wide version selection. `exportingRuntimeVersion` records the installed Node
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
stale values. New UI exports declare `requiredLoaderVersion: 3` and
`versionPolicy: latest|published`; capability 3 requires that policy and rejects
duplicate project identities. Latest policy rejects published artifacts. Older loaders
fail with an upgrade instruction rather than misinterpreting the new descriptors.

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
runs and Evaluation trials capture the tab's `bundleManifestPath` and pass it
back to the native reader. The remembered manifest is authoritative: rediscovery
from the file's parent would lose membership for valid nested paths and silently
drop the Subgraph loader. Explicit reads validate both permitted paths, canonical
containment and declared membership, including on Windows.
Missing, moved or invalid remembered manifests fail preparation with a visible
error; they never downgrade to standalone execution. Individual-member opens
retain the same membership metadata as manifest workspace opens.

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
