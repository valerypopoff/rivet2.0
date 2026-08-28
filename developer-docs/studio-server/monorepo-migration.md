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

| Former area | Monorepo destination |
|---|---|
| API | `packages/studio-server-api/` |
| Web/editor host | `packages/studio-server-web/` |
| Executor | `packages/studio-server-executor/` |
| Shared contracts | `packages/studio-server-shared/` |
| Runtime bootstrap | `packages/studio-server-bootstrap/` |
| Images and Compose | `deploy/studio-server/images/` and `deploy/studio-server/compose/` |
| Helm and release gates | `deploy/studio-server/helm/` and `deploy/studio-server/scripts/` |
| Documentation | `developer-docs/studio-server/` |

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
yarn studio-server:verify:kubernetes
```

Focused package work uses `yarn workspace`. Dependency installation is always
`yarn install --immutable` at the repository root.

## Verification Status

The import branch passed the following monorepo checks on Windows:

- immutable root Yarn installation
- the existing upstream Rivet test suite
- all five Studio Server workspace builds
- `studio-server:test`, including 555 API tests and 58 web tests
- documentation type checking and production build
- a Playwright check of the documentation homepage and its Studio Server link
- the full hosted-editor Playwright suite (45 passed, 1 optional test skipped)
- filesystem and local managed Docker compatibility gates
- API, web, executor, and proxy image builds from the monorepo root
- production Compose health checks, including a non-root API process
- Helm rendering and linting for every checked-in overlay
- the managed-Kubernetes smoke gate and full local disruption gate in Kind
- stale two-repository reference scans and representative two-step
  `git log --follow` checks across the subtree merge

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
