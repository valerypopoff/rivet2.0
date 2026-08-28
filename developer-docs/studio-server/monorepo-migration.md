# Studio Server Monorepo Migration

## Decision

Rivet Studio Server is maintained in the Rivet repository as five private Yarn
workspaces plus deployment and developer-documentation trees. Rivet packages
and Studio Server packages now share one commit, one workspace graph, one
`yarn.lock`, and one CI source checkout.

## History Preservation

The former Studio Server repository was imported with a non-squashed
`git subtree add` before files were moved with `git mv`. This preserves the
complete source history while placing current files at their owning monorepo
paths.

The final `git mv` is visible from each monorepo path. Git does not infer a
subtree prefix rewrite across a merge, so continue from the subtree merge's
second parent to inspect the earlier server history:

```powershell
git log --follow -- packages/studio-server-api/src/server.ts
git log --follow -- packages/studio-server-web/entry.tsx
git log --follow -- deploy/studio-server/helm/Chart.yaml

$importCommit = git log --grep="Add '_import/studio-server/'" --format=%H -n 1
git log --follow "$($importCommit)^2" -- wrapper/api/src/server.ts
git log --follow "$($importCommit)^2" -- wrapper/web/entry.tsx
git log --follow "$($importCommit)^2" -- charts/Chart.yaml
```

## New Ownership

| Former area            | Monorepo destination                                               |
| ---------------------- | ------------------------------------------------------------------ |
| API                    | `packages/studio-server-api/`                                      |
| Web/editor host        | `packages/studio-server-web/`                                      |
| Executor               | `packages/studio-server-executor/`                                 |
| Shared contracts       | `packages/studio-server-shared/`                                   |
| Runtime bootstrap      | `packages/studio-server-bootstrap/`                                |
| Images and Compose     | `deploy/studio-server/images/` and `deploy/studio-server/compose/` |
| Helm and release gates | `deploy/studio-server/helm/` and `deploy/studio-server/scripts/`   |
| Documentation          | `developer-docs/studio-server/`                                    |

## Removed Integration Layer

The migration removes the machinery that existed only because Studio Server
and Rivet were separate repositories:

- cloning or resolving an external Rivet source ref
- converting an embedded checkout's dependency layout
- generated `.rivet-package-links` overlays
- filtered secondary Docker build contexts
- nested npm lockfiles and dependency installations
- `RIVET_REPO_URL` and `RIVET_REPO_REF`
- image labels that attempted to record two independent Git revisions

Studio Server packages now depend on Rivet packages through `workspace:^`.
Docker images copy packages directly from the monorepo root and are labeled
from the single monorepo revision.

## Command Migration

Studio Server commands are namespaced at the repository root. Examples:

```bash
yarn studio-server:dev
yarn studio-server:prod:custom
yarn studio-server:build
yarn studio-server:test
yarn studio-server:verify:host-compatibility
yarn studio-server:verify:migration-ledger
yarn studio-server:verify:kubernetes
```

Compatibility aliases from the former repository are retained under the same
namespace, including `studio-server:dev:docker`, `studio-server:dev:down`,
`studio-server:dev:recreate`, and `studio-server:prod:prebuilt`.

Focused package work uses `yarn workspace`. Dependency installation is always
`yarn install --immutable` at the repository root.

The old standalone npm operator surface is intentionally not preserved. VM
automation must migrate `npm install` to `corepack enable` followed by
`yarn install --immutable`, `npm run prod` to `yarn studio-server:prod`, and
`npm run prod:custom` to `yarn studio-server:prod:custom`. `yarn dev` continues
to mean the Rivet desktop/editor; Studio Server commands remain namespaced.

npm remains only at boundaries where npm itself is the external protocol or an
isolated tool: publishing public packages to the npm registry, installing
developer-selected Code-node libraries into a synthetic runtime package, and
installing the exactly pinned static web-image helper. It is not a second
monorepo package manager.

## In-place production cutover

The production launcher is migration-aware about the two historical standalone
Docker Compose identities: `compose` and `ops`. It keeps `compose` as the fresh
deployment default, but when exactly one existing legacy app-data volume is
present it adopts that volume's project name automatically. Therefore an old
`compose_rivet_data` or `ops_rivet_data` volume stays attached after an in-place
cutover, along with matching managed-profile volumes when they exist. If both
legacy volumes exist, startup fails before changing containers so the operator
can select the authoritative one explicitly with
`RIVET_STUDIO_SERVER_COMPOSE_PROJECT=compose` or
`RIVET_STUDIO_SERVER_COMPOSE_PROJECT=ops` in `.env`.

No export/import step is needed for filesystem-backed app data. The mounted
`*_rivet_data` volume continues to provide the same `/data/rivet-app` path to
the API and executor, so saved Settings domains and `evaluation-runs.sqlite`
remain in place. The imported settings repository and filesystem Evaluation
store preserve their existing on-disk formats and migrations.

Before replacing a production checkout:

1. Back up the host artifact directories and the selected legacy Docker volumes.
2. Preserve the production `.env`. Verify that `RIVET_ARTIFACTS_HOST_PATH`
   resolves to the same absolute host directory from the monorepo root.
3. Do not run `docker compose down -v`, remove the named volumes, or prune
   volumes. Recreating containers is safe; deleting volumes is not.
4. In the monorepo root, run `corepack enable`, `yarn install --immutable`, and
   `yarn studio-server:prod`.
5. Verify the editor's projects, retained recordings, published workflow and
   web-app routes, and storage settings before retiring the old checkout.

With **Local folders** selected, live projects, recordings, published
snapshots, and runtime libraries remain in the configured host artifact
folders. The app-data volume still owns server settings and local indexes.
The artifact-storage choice and metadata-database provider are separate saved
settings: **Local Docker Postgres** selects the Compose-hosted database, while
**Managed Postgres** selects an external database. The production Compose
identity preserves both the app-data and local-Postgres volumes during this
cutover. The Docker API defaults to managed-schema migration mode, so existing
PostgreSQL schemas are advanced on startup; Kubernetes continues to use its
separate migration job and verify-only serving pods.

## Verification Status

The import branch passed the following monorepo checks on Windows:

- an executable tracked-file reconciliation of all 517 source files: 305 moved
  byte-identically, 195 moved with reviewed monorepo adaptations, one README
  was split/merged into two maintained destinations, and 16 files were removed
  with explicit reasons because they were obsolete two-repository machinery,
  nested lockfiles, or a test of retired linking behavior
- a moved-document link audit, root-command compatibility audit, and generic
  pull-request CI trigger check enforced by the repository structure verifier
- immutable root Yarn installation
- the existing public Rivet test suite
- all five Studio Server workspace builds
- `studio-server:test`, including 555 API tests, 58 web tests, and the executable hosted-editor compatibility scanner
- documentation type checking and production build
- a Playwright check of the documentation homepage and its Studio Server link
- the full hosted-editor Playwright suite (45 passed, 1 optional test skipped)
- filesystem and local managed Docker compatibility gates
- same-commit `studio-server:test` verification before API, web, executor, and proxy image builds from the monorepo root
- production Compose health checks, including a non-root API process
- Helm rendering and linting for every checked-in overlay
- the managed-Kubernetes smoke gate and full local disruption gate in Kind
- stale two-repository reference scans and representative two-step
  `git log --follow` checks across the subtree merge

### Reproducible source-completeness evidence

The migration does not rely on a prose inventory or on the former repository
remaining available:

- source commit: `fed8964eb86e9db134e7a2742a4ef26d271f6439`
- source tree: `dff081c4d11d2fbda113967006b3fad9efb54509`
- non-squashed import commit:
  `860d549b91001f8a282063ff097fd05e4318efb0`
- consolidation commit:
  `e2136da480fe4bcd830acb16a5f08763da70f389`

Git records the source commit as the import commit's second parent. The source
commit tree and the imported `_import/studio-server` subtree have the same
tree object ID, which proves that the complete tracked source snapshot entered
the monorepo byte-for-byte.

`deploy/studio-server/migration/source-file-ledger.json` then records one and
only one reviewed disposition for each source path, including source mode and
blob ID, migration-time destination mode and blob ID, and an explanation for
every transformation, merge, or removal.
`yarn studio-server:verify:migration-ledger` reconstructs the source and
consolidation trees from retained Git objects, compares the checked-in ledger
with the canonical mapping rules, verifies every recorded blob, and requires
every maintained destination to remain tracked and present. The Studio Server
verification and image-publication workflows use full-history checkouts so
this proof runs in CI before builds can be accepted or published.

The write command,
`yarn studio-server:verify:migration-ledger:write`, exists only to regenerate
the deterministic ledger after a reviewed mapping-rule change. Review the JSON
diff and removal reasons before committing it.

The provider-backed managed-Kubernetes gate remains external because it needs
the target provider cluster, values, credentials, DNS, ingress, object storage,
and PostgreSQL. Passing the local Kind gates does not replace that production
verification. Archiving the former repository is likewise deferred until this
branch is reviewed, merged, and deployed successfully.

## Release Sequence

1. Review and merge the import branch into `develop`.
2. Build all four Studio Server images from that merged monorepo commit.
3. Pass filesystem, managed-Kubernetes smoke, disruption, and provider-shaped
   release gates with those exact image digests.
4. Deploy the production-shaped environment and confirm editor and published
   workflow traffic independently.
5. Merge `develop` into `main` under the normal Rivet release process.
6. Archive the former Studio Server repository only after the production
   deployment passes, leaving a pointer to these monorepo paths.

The old repository remains an external release/archival gate; it must not be
rewritten or archived as part of the source import commit.
