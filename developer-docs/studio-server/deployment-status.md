# Deployment Status

`Settings` -> `Deployment` shows operational topology and the live published
execution concurrency control. It separates these controls from
`Settings` -> `Runtime libraries`, which is solely for adding, removing, and inspecting
Code-node packages.

## What the page tells an operator

### Single-host deployment

This is historical compatibility behavior only. Supported installations now use
managed roles under Docker Compose or Kubernetes. Their topology value
is `replicated` because roles are separate; on one machine it does **not** imply
redundant nodes, storage or automatic failover. See [Supported Server Stack](./server-stack.md).

The default is `RIVET_DEPLOYMENT_TOPOLOGY=single-host`. It is the Docker and
VM shape: one combined API process serves the editor, dashboard, and published
workflow endpoints. The page states plainly that there is no second Rivet API
replica or automatic failover. This remains true even when that one host uses
PostgreSQL or object storage for a managed-storage rehearsal.

### Replicated deployment

Both managed launchers inject `RIVET_DEPLOYMENT_TOPOLOGY=replicated` into every
API workload. The page then shows:

- the role of the API process serving the page (`control`, `execution`, or
  `evaluation`);
- live published-endpoint and editor/dashboard replicas that have checked in;
- whether each reporting replica has synchronized the active Code-node library
  release;
- last synchronization heartbeat, stale reports, release mismatch, and the
  recorded sync error where applicable.

The replica list is a durable managed runtime-library synchronization registry.
It is useful when a library release needs to reach every execution process,
but it is **not** a Kubernetes pod-health, desired-replica, HPA, node-health,
or cluster-autoscaler view. Kubernetes remains authoritative for those facts.
The page says this explicitly so a green synchronization status cannot be
mistaken for an application availability guarantee.

Counts include only reports newer than the runtime-library heartbeat TTL. A
stale marker can be cleared from this page after an operator has confirmed that
the former process is gone; the action deletes only stale registry entries, not
pods, runtime-library releases, packages, or other data. It reports the number
of records cleared (or that no stale records required cleanup) after the request
finishes.

The page refreshes registry data every five seconds while it is open. Its
`Last synchronization heartbeat` ages are a local display clock and tick once
per second; those age labels do not imply a request is sent every second.

### Live published-execution concurrency

On a supported replicated deployment, **Concurrent runs per execution Pod**
accepts an integer from 1 through 10,000. **Save** changes how many new published
endpoint, web-app action and scheduled executions a worker may accept. It does
not resize a Pod, change the replica minimum, limit editor/preview runs or
increase the worker's physical processing capacity.

Workers update their existing admission counter in place. Lowering from 32 to
16 while 20 runs are active lets all 20 finish; new requests receive the existing
overload response until capacity is available. The server does not queue them.
Saving never restarts a Pod, cancels work, replays a run or reopens a draining
worker. The field is unavailable when the deployment cannot enforce it.

The explicit override is encrypted in the existing versioned `app_settings`
store, scoped to `RIVET_LEGACY_RESTORE_INSTALLATION`. No schema migration is
required. Notifications normally propagate changes promptly; the existing
five-second settings poll covers lost notifications. An outage can delay this:
**Saved** confirms persistence, not that every worker has applied the value.
There is no per-execution database, disk or inter-worker request for the policy.

**Use deployment default**, followed by **Save**, removes the override. The
default comes from the installation's existing Helm/Compose configuration;
production and staging can have different defaults and saved overrides. Restart,
scale-up and upgrades retain the override. A restored override from another
installation is ignored until explicitly saved for this installation. Old backup
snapshots without the new optional domain use the default.

The normal revision-protected settings form preserves unsaved input during
background status refresh. Stale saves fail with a conflict. An uncertain write
is read back once; the browser does not automatically repeat it. The runtime-library
replica list below the field does not report this setting's convergence.

See the [implementation and validation plan](published-execution-concurrency-plan.md)
for rollout compatibility and the one-time release acceptance exercise.

## API and source of truth

The authenticated control-plane route is:

```text
GET  /api/deployment-status
POST /api/deployment-status/replicas/cleanup
GET  /api/app-settings/published-execution
PATCH /api/app-settings/published-execution  # If-Match required; PUT also supported
```

`packages/studio-server-api/src/deployment-status.ts` validates
`RIVET_DEPLOYMENT_TOPOLOGY` and returns the current API runtime profile. In a
replicated deployment it reads the managed runtime-library replica registry; in
a single-host deployment it intentionally returns no registry data rather than
inventing a replica count from storage configuration.

The API validates this value during startup as well as when it serves the
status route. A typo therefore fails deployment readiness instead of remaining
hidden until someone opens this page.

Valid topology values are:

```text
single-host  # historical compatibility/fixture default, not supported serving
replicated   # injected by managed Docker and Helm API workloads
```

Changing the environment variable is a deployment operation, not a Settings
action. Set it only to describe the actual topology; it does not create
replicas or make a single host highly available.

## Important files

- `packages/studio-server-shared/deployment-status-types.ts` — browser/server contract.
- `packages/studio-server-api/src/deployment-status.ts` — topology validation and status assembly.
- `packages/studio-server-api/src/routes/deployment-status.ts` — authenticated API route.
- `packages/studio-server-api/src/published-execution-settings.ts` — scoped setting, default and process subscription.
- `packages/studio-server-api/src/published-execution-admission.ts` — in-memory admission and accepted-work ownership.
- `packages/studio-server-web/dashboard/app-settings/tabs/DeploymentStatusSettingsTab.tsx` — Settings UI.
- `packages/studio-server-web/dashboard/DeploymentReplicaReadinessPanel.tsx` — synchronization detail view.
- `deploy/studio-server/helm/templates/_env.tpl` — Helm's explicit replicated-topology metadata.

## Local validation

The concurrency regressions cover revision-protected saves, installation scope,
older backup compatibility, listener recovery and preservation of accepted work.
Run the affected API tests with the API package's `test:files` command; the core
files are `app-settings.test.ts`, `settings-repository.test.ts`,
`managed-settings-sync.test.ts`, `published-execution-admission.test.ts` and
`workflow-async-process.test.ts` under `src/tests/`.

`yarn workspace @valerypopoff/rivet-studio-server-api run test:published-execution-managed`
uses a disposable local PostgreSQL container and four independent API-policy
processes to check propagation, missed notifications, reconnects, restarts and
outages. It removes its owned container and volume afterward.

For the browser form, run `deployment-status.spec.ts` through
`yarn studio-server:ui:observe` in headless mode. It covers validation, Save/Revert,
reset, stale saves, uncertain acknowledgements, background refresh and focus.
It is also registered in the normal editor CI shards. Local verification does
not replace the first release's focused staging acceptance.
