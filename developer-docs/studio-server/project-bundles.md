# Portable project bundles

Studio Server's project-row **Download with dependencies** action exports a saved
project and its recursive dependency closure as a ZIP. Ordinary **Download** and
published-history downloads retain their single-file contract. Closing the bundle
dialog does not cancel export, activate a project, refresh the tree or discard edits.
Failed, cancelled and interrupted jobs offer **Retry export** directly: disposal
must succeed before creating a fresh job with the selected root version. Ready
jobs retain **Prepare another bundle** for choosing a different version. Status
responses and polling errors are fenced by the current job ID, so late replies
from a disposed job cannot overwrite the retry's progress or download link.

The bundle dialog uses the shared responsive modal dimensions, black backdrop,
dark surface and header/close styling. Project details and export progress use
bordered cards with the shared 14px/1.5 description typography. Root-version
selection uses `SegmentedControl`, not an OS-native select. Atlaskit actions live
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
- Cross-project targets are keyed by `(projectId, latest|published)`. Different
  versions of one project are separate artifacts. Legacy `Project.references`
  use a separate ID binding and select published, falling back to latest only
  when there is no published version. Stale hint paths are not export authority.
- Every captured source is re-read before and after ZIP construction. A changed
  project or dataset rejects publication; an export is not a transaction spanning
  databases, but it never knowingly publishes a mixed, changed capture.
- Node `loadProjectBundle` validates the extracted manifest, contained real paths,
  lengths, SHA-256 hashes, identities, target graphs and wire boundaries before
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
`projects/*.rivet-project` / optional `.rivet-data` artifacts. Schema and loader
capability are both version 1; `exportingRuntimeVersion` records the installed Node
runtime version independently of the loader capability. Checksums detect corruption, not malicious authoring:
executing a bundle can execute its Code nodes and network requests.

## Job and download lifecycle

Authenticated API routes under `/api/workflows/project-bundles` are:

- `POST /` with `{relativePath, version: live|published, requestId?: UUID}` returns
  202 promptly. The client creates and remembers the UUID before POST, allowing
  progress recovery after a lost acknowledgement.
- `GET /:id` reports collecting, packaging, ready, failed, cancelled or interrupted.
- `GET /:id/download` serves a ready immutable ZIP with a strong archive-hash ETag,
  Range/If-Range support, attachment disposition and no-store headers.
- `DELETE /:id` requires `X-Rivet-Bundle-Intent: 1` and cancels/disposes the export.

Only one export prepares at a time, including final staging cleanup. Terminal
status and download acknowledgement wait for that preparation owner to settle:
observing failure guarantees its packaging slot is released before retry, and a
ready archive is not exposed before a later cleanup failure can revoke readiness.
Expiry and cancellation use one serialized removal owner;
failed deletions remain tracked for disk accounting and are retried instead of
orphaning archives. Failed staging removal also blocks further preparation until
cleanup succeeds, while leased downloads may finish. Cancellation denies new
downloads before removing scratch and protects its journal update from concurrent
cleanup. Concurrent cancellation requests share one operation and journal write;
atomic journal writes use unique temporary files. This avoids both temporary-file
collisions and concurrent journal replacement on Windows, without filesystem retries.
A 30-minute deadline cancels stalled preparation;
late non-abortable reads cannot publish. On API restart, unfinished journaled jobs
become interrupted. Restart reconciliation removes leftover staging and partial
archives even for ready jobs, preserves only durably published ready ZIPs, and
keeps cleanup failures tracked/blocking until removal succeeds. Private scratch is
installation-scoped under the OS temporary
directory, with restricted creation modes. Ready jobs expire after 24 hours;
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

The collector releases raw project/dataset strings after staging; retained source
checks contain fingerprints, not complete payloads. Parsed graph definitions remain
available for closure/boundary validation. ZIP generation streams staged files.

Defaults: 256 project/version artifacts, 64 MiB per project or dataset file, 512 MiB
total captured payload, 2 GiB scratch budget, and 512 MiB free-space reserve. Operators
may deliberately set `RIVET_PROJECT_BUNDLE_MAX_BYTES` (up to 8 GiB) and
`RIVET_PROJECT_BUNDLE_SCRATCH_MAX_BYTES` (up to 32 GiB). Scratch accounting reserves
room for both staging and archive, counting each successful file write separately
(including the manifest and README), not delayed whole-artifact progress. Free-space
checks retain room for archiving all files already staged. Failed archive removal,
like failed staging removal, blocks new preparation until owned scratch is removed;
it must not erase retained archive accounting. Capacity exhaustion fails rather than
deleting unexpired bundles. The Node loader defaults to 512 MiB total and accepts
`maxTotalBytes` for intentionally larger trusted bundles.

## Portability limits

Only saved server content is exported; unsaved browser edits are excluded.
Published roots can still reference **Saved latest** children, frozen at export
time. Server settings, credentials, recordings, runtime libraries, environment
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
yarn workspace @valerypopoff/rivet-studio-server-api exec tsx --test src/tests/project-bundle.test.ts src/tests/sqlite-workflow-backend.test.ts src/tests/managed-execution-service.test.ts
$env:PLAYWRIGHT_HEADLESS='1'
$env:PLAYWRIGHT_SLOW_MO='0'
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:5174'
yarn studio-server:ui:observe project-bundle.spec.ts
```

The browser fixture uses owned API responses and a real exporter, browser download,
ZIP extraction into another directory, and Node execution, plus delayed/lost start
acknowledgements, failed preparation followed by retry without reloading the
workspace, and the shared modal theme. API tests cover auth,
range resumption, redaction, cancellation, restart, coherent closure and reader
retention, including cancelled reader capacity, held staging cleanup, retry after
failed expiry removal and unclaimed scratch preservation.
Held-cleanup fixtures cover both success/failure acknowledgements and prevent
downloads from escaping a subsequent cleanup failure; they use explicit gates,
not sleep-based race timing.
The real ZIP execution fixture includes a valid mutual-project call through a
different graph; an indirect cross-project cycle through a local helper is rejected.
Node tests cover two versions of one target, repeated processor isolation,
public ESM/CommonJS entry points, legacy alias datasets (including empty snapshots),
corrupt/incomplete mappings, size bounds and escaping paths. Artifact reads are
bounded by the captured file size plus one overflow byte, including when a file
grows after its size check; whole-file reads cannot bypass the memory limit.
Node's `pretest` builds both package entry formats so this check does not depend
on stale local artifacts.
The `test` command invokes that preparation explicitly because Yarn does not
automatically run arbitrary `pretest` lifecycle scripts.
The closure fixture covers prefab/non-main targets, legacy back-edges, attachments
and a second version of the root. Storage failure followed by retry is covered.
No Kubernetes rehearsal or production migration is required.

For an opt-in capacity measurement, not a slow CI regression:

```powershell
yarn workspace @valerypopoff/rivet-studio-server-api exec node --expose-gc --max-old-space-size=256 --import tsx src/tests/helpers/project-bundle-capacity.ts
```

The probe owns six random 16 MiB datasets, measures the real exporter and deletes
all its fixtures. On the Windows checkout on 2026-10-05, 100,669,652 payload bytes
produced a 75,824,624-byte ZIP in 3.02 seconds. Sampled peak heap was 140,393,088
bytes; RSS increased from 344,428,544 to 447,676,416 bytes, and peak scratch was
176,500,788 bytes. Export scratch after disposal was zero. These are fixture/host
measurements, not universal memory or latency guarantees; the loader intentionally
materializes project/dataset snapshots when executing them.
