# Deployment Status

`Settings` -> `Deployment` is Rivet Studio Server's read-only operational
topology view. It deliberately separates deployment information from
`Runtime libraries`, which is solely for adding, removing, and inspecting
Code-node packages.

## What the page tells an operator

### Single-host deployment

The default is `RIVET_DEPLOYMENT_TOPOLOGY=single-host`. It is the Docker and
VM shape: one combined API process serves the editor, dashboard, and published
workflow endpoints. The page states plainly that there is no second Rivet API
replica or automatic failover. This remains true even when that one host uses
PostgreSQL or object storage for a managed-storage rehearsal.

### Replicated deployment

The Helm chart injects `RIVET_DEPLOYMENT_TOPOLOGY=replicated` into every API
workload. The page then shows:

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

## API and source of truth

The authenticated control-plane route is:

```text
GET  /api/deployment-status
POST /api/deployment-status/replicas/cleanup
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
single-host  # default for Docker/VM operation
replicated   # injected by the Helm API workloads
```

Changing the environment variable is a deployment operation, not a Settings
action. Set it only to describe the actual topology; it does not create
replicas or make a single host highly available.

## Important files

- `packages/studio-server-shared/deployment-status-types.ts` — browser/server contract.
- `packages/studio-server-api/src/deployment-status.ts` — topology validation and status assembly.
- `packages/studio-server-api/src/routes/deployment-status.ts` — authenticated API route.
- `packages/studio-server-web/dashboard/app-settings/tabs/DeploymentStatusSettingsTab.tsx` — Settings UI.
- `packages/studio-server-web/dashboard/DeploymentReplicaReadinessPanel.tsx` — synchronization detail view.
- `deploy/studio-server/helm/templates/_env.tpl` — Helm's explicit replicated-topology metadata.
