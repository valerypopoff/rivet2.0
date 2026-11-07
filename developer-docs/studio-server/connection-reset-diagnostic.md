# Focused connection-reset diagnostic

This is an investigation of the incomplete response seen on November 7, not a
release gate or a production update. It does not access the retained Rivet
installation, reset its baseline, remove its quarantine, or reuse its lock.
It uses a new disposable namespace and the pinned Node 24.22.1 and Nginx 1.30.6
runtime images. No application image build, database, external load balancer,
certificate issuance, persistent disk, or new cluster is needed.

## What it tests

1. Keep two small HTTP backends, A and B, alive throughout the test. Route an
   internal Nginx proxy through one ClusterIP Service initially selecting A.
2. Complete one control request over each of fresh HTTP/1, pooled HTTP/1 and
   negotiated HTTP/2. Each uses a 16-KiB input and a 16,568-byte JSON response.
3. Start three more requests over the same transport variants. A sends an
   11,959-byte prefix and holds the rest. Record acceptance, owner UID,
   process incarnation, node, socket and transport before changing routing.
   Acceptance and first-failure events are emitted immediately to private
   container logs. Nginx log lines include the same request IDs.
4. Change only the disposable execution Service selector from A to B, using
   UID/resourceVersion/selector preconditions. Issue the PATCH once. If its
   acknowledgement is lost, read back its state without repeating it.
5. Observe a fresh read reach B, verify both original owners remain alive,
   release A's three pending responses, and require all their bytes to arrive.
6. Save the result and private proxy logs, then delete only the diagnostic
   namespace. There are exactly six workflow POSTs, with no retries. A failure
   closes new work and lets accepted requests settle.

The response hold replaces an arbitrary multi-minute sleep: the endpoint change
is demonstrably inside the response window. Holds expire after 30 seconds;
an expiry or a failed setup/observation produces an inconclusive result rather
than evidence that ordinary rollouts are broken. Requests have a 45-second
deadline. The Job has a three-minute deadline and `backoffLimit: 0`.
All fixture Pods have a ten-minute lifetime limit as a fallback; explicit
namespace cleanup is still required.

The local runner substitutes a TCP connection router for the ClusterIP. It
preserves established connections while changing the destination for new ones;
it does **not** reproduce GKE/Cilium connection tracking. A local pass validates
the diagnostic. A provider pass only rules out this isolated endpoint-switch
case under the observed placement. Neither proves the original fault fixed,
qualifies a release, or tests full Rivet behavior, retirement, the external load
balancer or 300-second duration. Record node placement; a same-node result does
not cover every cross-node path.

## Local validation and offline preparation

The tools image must already exist locally and provide Node 24.22.1 and OpenSSL.
The command refuses to pull images or overwrite a previous output directory.
All local networking is confined to one internal Docker network; cleanup checks
ownership before removing its exact containers/network. The self-signed test
key is disposable and is deleted after local execution. Prepared bundles contain
that test key and must stay under the ignored `artifacts/` directory.
Node processes are launched through projected symlink paths locally as well as
in Kubernetes. Entry-point detection canonicalizes both paths, while importing
the fixture as a module remains inert. The regression covers normal Node
resolution and `--preserve-symlinks-main`.

```sh
node .yarn/releases/yarn-4.17.1.cjs exec node --test deploy/studio-server/scripts/connection-reset-diagnostic.test.mjs

node deploy/studio-server/scripts/connection-reset-diagnostic.mjs local --tools-image EXISTING_TOOLS_IMAGE
node deploy/studio-server/scripts/connection-reset-diagnostic.mjs local --tools-image EXISTING_TOOLS_IMAGE --truncate-response
node deploy/studio-server/scripts/connection-reset-diagnostic.mjs prepare --tools-image EXISTING_TOOLS_IMAGE
```

The negative control deliberately resets one held response after the selector
change. Exit status 1 and one incomplete response are expected; the other five
responses must complete, accepted work must settle, and cleanup must succeed.
The affected transport depends on arrival order and must be read from evidence.

`prepare` generates three JSON files and `identity.private.json` with their SHA-256
fingerprints; it never calls
kubectl or a cloud API. Infrastructure, proxy and client are separate to ensure
Services/backends exist before Nginx resolves its upstream and to ensure no
synthetic work starts before readiness. The diagnostic account can only get and
patch the named `execution` Service in its own new namespace. Backend/proxy Pods
have no service-account token. No existing account or IAM policy is edited.

## Later staging execution

**Not authorized by local preparation.** Obtain the operation-specific staging
allowance and approval for the disposable namespace and its exact local Role/
RoleBinding first. Verify the current staging cluster UID and Kubernetes access
using the established operator path. Check the certificate still has enough
lifetime for the whole operation, image access, available capacity and a bounded
cleanup path before creating anything. Do not apply these files to production.

After those checks, on the approved staging context:

1. Create `infrastructure.private.json` once. Record the new namespace UID.
   Wait for Pods A and B to become Ready within the approved setup deadline.
   Use `diagnosticPodReady` from `lib/connection-reset-diagnostic.mjs`: a
   terminal Pod, exited diagnostic container or deletion is an immediate setup
   failure, even if a stale Ready condition remains. Do not wait out the deadline.
2. Create `proxy.private.json` once and wait for its Pod to become Ready.
3. Create `client.private.json` once. Save its Job status and logs privately.
   Do not retry a failed Job or replay a partially acknowledged create.
4. Capture the proxy log and Pod/node inventory before cleanup. Read the JSON
   result: `passed`, `failed` (a response failed), or `inconclusive` (setup,
   mutation or observation could not establish the scenario). In particular,
   status 200 without a complete body is a failure.
5. Recheck the exact namespace UID/ownership, delete that namespace normally,
   and verify absence. Preserve the first failure if collection or cleanup also
   fails. No forced deletion, prefix-based cleanup, or retained-app changes.

An unexpected state stops further mutations. Preserve the evidence and resolve
that state before proposing another attempt. Do not turn a diagnostic result
into a production deployment or a full qualification automatically.

## Local result on November 8

The positive Docker control completed all six responses and one selector
change. The negative control identified one truncated 11,959-byte response;
the other five responses completed. Both settled accepted work and removed
their local resources. The probe portion took under one second in each case;
container setup/cleanup is additional. These are local observations only.

## November 8 staging attempt: inconclusive before traffic

The first staging setup passed API access, manifest validation and server-side
Pod admission. Both backend Pods then exited with code 0 without starting their
HTTP servers. The client Job was never created, so no protected requests or
Service-selector change were exercised. This does not establish a Rivet
rollout or network failure.

The cause was reproduced locally with Linux/Node 24.22.1: ConfigMap projection
uses symlinks, while the fixture entry-point guard compares
`fileURLToPath(import.meta.url)` directly with `process.argv[1]`. Those paths
differ for a projected file, so the CLI body is skipped. The regular-file Docker
mount used in the original local controls did not exercise this condition.
Before a new attempt, make entry-point detection projection-safe and add a
regression using Kubernetes-style symlinked paths. Also treat a backend Pod
that exits before readiness as an immediate setup failure rather than waiting
out the readiness deadline. Do not patch/restart this failed setup as a retry.

A separate local credential-adapter assumption about an embedded CA was fixed
before any resource creation; the existing staging endpoint uses public CA
trust. Strict TLS and the verified staging cluster identity were retained.
No application image build, retained-application change, qualification
publication or production deployment was performed.

Cleanup was independently verified: the entire disposable namespace was absent,
and all eight retained staging Pods were Ready. No automatic retry or production
deployment occurred.

The follow-up repair canonicalizes the entry-point paths and adds the projected
path/import regression. The local Docker runner now uses that same symlink
layout for its actual backend, router and client processes. The shared Pod
readiness predicate rejects both terminal Pod phases and exited containers
immediately. These changes affect tooling only; application images are reused.

## Repaired staging diagnostic on November 8

After the projected-path and terminal-Pod fixes passed on Windows and Linux,
one fresh staging diagnostic passed. All six HTTP/1 fresh, HTTP/1 pooled and
HTTP/2 responses were complete (16,568 bytes each), including the three held
across one confirmed Service selector change. The probe took 760ms, the client
Job took six seconds, and setup/evidence collection/cleanup took 89 seconds in
total. The namespace was independently verified absent afterward, and all
eight retained staging Pods were Ready. There was no application image rebuild,
automatic test retry, qualification publication or production deployment.

Both backend owners were on the same node. This is a successful isolated
endpoint-switch diagnostic under that placement; it does not establish the
cause of the earlier reset or qualify the full rolling-update process. The next
milestone is one timed staging rolling update with the existing complete-request
and accepted-work checks, not an expanded standalone diagnostic matrix.
