# Real Rivet response-reset diagnostic

This is an isolated investigation, not a release gate or a rollout. It compares
two real synchronous Rivet executions while changing only one disposable
ClusterIP Service selector. It does not restart a backend, rebuild application
images, access production, or change the retained staging application.

## Test shape

Use the exact affected API image and the pinned diagnostic Nginx/Node images.
Each backend initializes a disposable filesystem project and runs the actual
published-workflow API, Code-node admission receipt, Delay node, output delivery
and recording persistence. The workload is the same 16-KiB input shape as the
captured reset. This covers real application execution with filesystem storage;
it does not reproduce managed PostgreSQL/object storage or the external LB.

There are at most five workflow POSTs, without retries:

1. Complete one quick request on each route, both reaching backend A.
2. Start two 295-second requests together and observe both admitted by A.
3. Change the disposable `execution` Service selector from A to B once, with
   UID/resourceVersion/selector preconditions. An uncertain acknowledgement is
   read back rather than repeated. Observe fresh GETs reach B before issuing
   the one quick post-change workflow POST.
4. Let both accepted long executions finish normally. The changed route passes
   through the ClusterIP; the unchanged route passes through the same proxy
   directly to A's observed Pod IP. All complete bodies, Content-Length and
   echoed input values are checked. Owners must retain their incarnation/UID.
5. Record final process-local active run counts and response settlement. A first
   failure stops new workflow POSTs but does not abort accepted graphs. Collect
   private logs and remove only the disposable namespace with verified ownership.

There are no A/B Services: even the state probes use direct Pod IPs. An extra
Service referencing A could conceal the original backend-removal condition.
The proxy and both API Pods use required node anti-affinity and 500m CPU / 512Mi
memory requests with 512Mi memory limits. The client uses 50m / 128Mi. No external
load balancer, database, persistent disk, ACME certificate or cloud IAM change is
part of this bundle. The diagnostic ServiceAccount can only get/patch the named
`execution` Service in its new namespace; backend/proxy Pods receive no token.

Response deadlines allow 30 seconds beyond the requested graph duration for
diagnosis. This does not change the release qualifier's 300-second total limit
or qualify an over-budget response. The client Job has a 420-second deadline,
zero retries, and fixture Pods have a 900-second lifetime bound. Accepted-run
settlement is bounded by the original observer start plus work duration and
45 seconds, rather than starting another full wait after a failure.

Backend stdout records request IDs, owner incarnation, socket IDs, request
completion, response finish/close/error and socket end/close/error with byte
counters. Nginx logs the same request ID. Payloads, environment variables and
credentials are not logged. These events can narrow the failure layer; they
are not a packet capture and cannot by themselves identify who emitted a TCP
reset. If attribution remains ambiguous, report that rather than guessing.

## Local checks and offline preparation

Use an existing cached API image pinned to a digest and an existing Node
24.22.1/OpenSSL tools image. The commands never pull images or run kubectl.
Outputs must be new directories under ignored `artifacts/`. The prepared TLS
key is disposable, private and valid for one day; do not reuse an expired bundle.

```sh
node --test deploy/studio-server/scripts/rivet-response-reset.test.mjs

node deploy/studio-server/scripts/rivet-response-reset.mjs local --api-image API_DIGEST --tools-image CACHED_TOOLS_IMAGE
node deploy/studio-server/scripts/rivet-response-reset.mjs local --api-image API_DIGEST --tools-image CACHED_TOOLS_IMAGE --truncate-response

node deploy/studio-server/scripts/rivet-response-reset.mjs prepare --api-image API_DIGEST --tools-image CACHED_TOOLS_IMAGE --output artifacts/NEW_DIRECTORY

# Prepare the repaired variant; this is still offline and sends no cloud requests.
node deploy/studio-server/scripts/rivet-response-reset.mjs prepare --retain-backend --api-image API_DIGEST --tools-image CACHED_TOOLS_IMAGE --output artifacts/NEW_RETAINED_DIRECTORY
```

Local mode uses one-second graph delays and an internal Docker TCP router to
approximate connection-preserving Service selection. It cannot emulate GKE's
dataplane. All five positive-control responses must complete. The injected
negative control must fail only the changed-route long response while the other
four complete; failure exit status is expected. Both controls must settle graph
work and verify cleanup. The separate regression injects a failure during the
routing observation and verifies that no post-change workflow is started.
Real backend processes enter through symlinked mounts as with ConfigMap
projection. The established ownership-checked Docker cleanup also runs after
setup, execution or log-collection failure.

Local execution and later staging setup use the same `createRivetResetProxy`
phase coordinator. After observing the backend addresses it creates the final
immutable `proxy-config` ConfigMap, then the proxy Service and Pod, exactly once.
The local adapter mounts that generated configuration into the actual Nginx
container. It no longer substitutes a separate static Docker configuration.
`proxy-creation.private.json` records the local create sequence. A failed create
stops the phase with its original error; no patch, update or automatic replay
is used to install proxy configuration.

`prepare` freezes sources, TLS and an immutable API image reference into
`pending.private.json`, writes only the infrastructure phase, and records its
digest in `identity.private.json`. Proxy/client activation requires fresh A/B
Pod observations, after infrastructure is actually approved and created:

```sh
node deploy/studio-server/scripts/rivet-response-reset.mjs complete --output artifacts/PREPARED_DIRECTORY --pod-inventory PRIVATE_POD_LIST_JSON
```

`complete` is also offline. It checks the frozen bundle digest, namespace/labels,
unique Pod UIDs, readiness, live processes, separate nodes and valid IPs. It
then writes the new immutable proxy ConfigMap, Service and Pod to
`proxy.private.json`, and the Job to `client.private.json`. The shared source
ConfigMap and backend Pods are not edited. Backend/client projections contain
only source modules; the proxy projects only its own `nginx.conf`.

## Later staging execution

Not authorized by local preparation. Obtain the operation-specific allowance
and bounded cleanup plan before any create. Verify the staging cluster identity,
image pull access, current capacity and TLS lifetime first. Reuse existing
installation access; the bundle contains no new production or project IAM grant.

Create the infrastructure phase once and record the namespace UID. It excludes
the proxy ConfigMap, proxy Service/Pod and client Job. Wait for
both live API Pods to be Ready, save their actual Pod-list JSON privately, and
complete the offline proxy/client phases. **Create** the proxy phase once and
observe the proxy Ready on its own third node before creating the client Job
once. Never apply `pending.private.json` directly: its proxy configuration has
not yet been bound to the observed A Pod IP. Never replay an uncertain create.

A programmatic operator should call `createRivetResetProxy` with its existing
namespace-owned, journaled POST-only create adapter, then wait for proxy
readiness. Do not reuse the historical operator's ConfigMap PATCH sequence.
Its run is closed. Older bundles without a dedicated `proxy-config` must be
prepared again locally rather than adapted during a paid attempt.

The prepared replacement operator was also executed offline against an
in-memory Kubernetes API in three scenarios: success, rejected proxy-config
creation, and a client Job create whose acknowledgement was lost after the Job
was accepted. These checked exact create order, no setup PATCH or replay,
preservation of the first error, settlement of the original client and cleanup.
Its plan-only mode checks bundle/source/TLS consistency without loading cloud
credentials. Live execution separately requires a fresh operation-specific
approval and creates an exclusive intent file before cloud writes. This local
operator check does not supply provider diagnostic or release acceptance.

Both the operator transport and diagnostic client retain safe Kubernetes Status
reasons, bounded cause fields and audit IDs. These are available as
`error.status`, `error.kubernetesStatus` and `error.auditId`; the main error
message includes HTTP status, reason and audit ID for existing cause reporters.
Raw Status/cause messages can echo submitted source or credentials and are not
retained. If a failed selector write is followed by a failed read-back, preserve
the original write error. No new retry policy is introduced.

Save client/backend/proxy logs, owners and admitted requests, resource requests,
Pod placements, restart counts and the result before normal namespace deletion.
Verify the exact namespace UID/label before deleting and verify absence after.
The retained application, quarantine, baseline and release pointers stay intact.

Interpret failure according to the paired responses and server/proxy events.
A changed-route-only failure implicates that routing path but still needs trace
correlation. Failure on both routes warrants investigation of shared application,
proxy or network behavior. A pass rules out only this actual-Rivet scenario under
the observed placement; it does not establish the original cause or qualify a
release. Choose the next action from the evidence instead of automatically
repeating a full rollout.

## Local validation status

The November 8 final Docker controls completed five of five positive responses;
the injected reset failed exactly one response while the other four completed.
Both settled accepted graph work and independently verified resource cleanup.
The diagnostic/transport suites passed 39 Linux/Node 24 tests, including failures
before and after admission. The adjacent Windows API suites passed 45 tests;
the buffered-shutdown regression also passed on Linux after reproducing the
pre-fix reset. The actual changed shutdown helper delivered all 16,777,391 bytes
of the real API reproduction. API typechecking, source rollout checks, test-style,
formatting, documentation links and two headless browser fixture checks passed.
These are local results only; no new cloud test, application build or production
deployment was performed.

## First provider attempt: setup stopped before requests

One later approved staging attempt passed workload admission and started both
real API backends on separate nodes. Setup then stopped at the operator's
guarded ConfigMap update that binds the unchanged proxy route to A's observed
Pod IP. Kubernetes rejected the PATCH and read-back confirmed the old template
remained. The original exception was lost behind a secondary assertion; the
available audit event only says the request was rejected. A malformed request
and a failed patch precondition have not been distinguished.

The proxy Pod and client Job were never created: zero diagnostic workflow
requests ran, so this supplies no evidence about the original response reset.
The one attempt closed in 2m50s including evidence collection and normal cleanup.
Independent verification found its namespace absent and all eight retained
staging Pods Ready with the application quarantine/owner unchanged. No retry,
image rebuild or production change followed.

The missing local coverage was this Kubernetes-only ConfigMap update. The local
follow-up now removes that update entirely: a dedicated rendered proxy ConfigMap
is created once after observing the backend IP, using the same phase coordinator
in local Docker and later staging preparation. Regression coverage includes the
offline completion CLI, independent source/proxy projections, original-error
preservation and stopping after a failed create. This repairs setup locally;
it does not retroactively supply a diagnostic result for the failed attempt.

The create-only follow-up passed 47 diagnostic/transport regressions on Linux
and the corresponding Windows checks. The actual Docker positive control
completed five responses; the deliberate truncation failed only its intended
response while the other four completed. Both verified accepted-work settlement
and cleanup. Offline CLI completion emitted only the new proxy ConfigMap,
Service and Pod, without changing its frozen input. Read/write retry checks,
autoscaler packaging/startup and image-input classification, the source rollout
gate and two headless browser fixture checks also passed. A fresh offline bundle
was prepared; no additional cloud attempt or production deployment was started.

## Create-only provider diagnostic: route-specific reset reproduced

The later one-shot run of the create-only setup completed in 7m59s including
cleanup. All five workflow POSTs ran exactly once. The changed-route long
response stopped at 295.048 seconds with HTTP 200 and 11,929 of 16,568 body bytes;
the simultaneous unchanged-route response completed all 16,568 bytes at
295.062 seconds. The other three responses completed normally, including the
fresh request to backend B after the Service selector change. All accepted
work settled, with zero active runs on both backends.

Backend A and B and the proxy occupied three different nodes. Their identities
were stable and restart counts stayed zero. No backend retirement or shutdown
was requested. Both long responses on A emitted normal response finish/close
events and reported 16,927 bytes written to their sockets, including headers.
These are local socket-write observations, not proof that the peer received
those bytes. Nginx recorded an upstream connection reset only on the changed
ClusterIP path; its direct-to-A control response completed.

This reproduces the failure with actual Rivet execution and filesystem storage,
without an external LB, managed storage or requested backend shutdown. It
narrows investigation to the Service-handoff path and its interaction with
connection closure; the application events do not identify the TCP reset's
emitter. The separate buffered-shutdown fix does not explain this reproduction.
Keep the complete-body check and investigate a narrow repair using these traces
before another cloud attempt, rather than repeating an unchanged rollout.

The namespace was deleted normally, its absence independently verified, and
all eight retained staging Pods remained Ready with quarantine/owner unchanged.
No retry, application rebuild, release qualification or production deployment
followed. The repaired create-only setup worked in GKE. A read-only preflight
initially stopped at an obsolete requirement for spare existing nodes; existing
autoscaler policy and fresh regional quota established capacity before workload
creation, without a manual cluster or quota change.

## Local repair of the backend-reference removal condition

The HA chart now keeps a private, readiness-independent ClusterIP reference to
both execution pools on their real HTTP port. The legacy handoff observes that
reference for 60 seconds before removing the original public reference, and
verifies its UID/specification and original owner endpoints throughout response
drain. This repairs the unsafe lifecycle ordering described by
[Cilium's backend-reference issue](https://github.com/cilium/cilium/issues/23761).
Local server finish events cannot prove the exact reset emitter, so the
mechanism remains an evidence-supported diagnosis until provider validation.

Offline `prepare --retain-backend` adds the corresponding `execution-connections`
Service to the diagnostic infrastructure, selecting only API A and B on port
8080 with `publishNotReadyAddresses: true`. The public execution selector still
changes A→B once; the unchanged route still uses A's Pod IP. The default variant
keeps the original no-extra-reference scenario for comparison. No extra Pods,
workflow requests or write permissions are introduced. The flag is intentionally
preparation-only: the local Docker router does not implement Cilium backend maps,
and a local HTTP pass must not be represented as a dataplane fix proof.

Local regression coverage includes real Helm rendering and the complete paired
rollout fixture, absent/headless/wrong-port/pool-restricted references, continuous
propagation, reference loss during response drain, ownership/recovery and unknown
writes. Linux Node 24 also exercises the real buffered-response/socket tests.
These checks establish configuration, ordering and response-preservation behavior
locally. They do not replace a later GKE verification of the network condition.

The retained-reference follow-up is prepared as a fresh one-shot operation,
without reopening the closed run. Before client start its operator observes the
exact private Service UID/specification and the two original Pod UID/IP/port
references continuously for 60 seconds, then records a second proof after work
settles. A failed proof stops acceptance while cleanup still runs. Five offline
launcher scenarios cover success, rejected proxy creation, uncertain client
creation and missing/lost references. Frozen runtime modules, image references
and still-valid diagnostic TLS may be reused for offline packaging without a
local image download. Fresh live readiness and a new operation-specific allowance
remain separate requirements before any create. No provider result is implied
by this preparation.

## Retained-reference provider verification passed

The separately approved retained-reference check completed once in 9m55s,
including setup and cleanup, using the same affected API image and unchanged
runtime modules. All five workflow responses completed. Both simultaneous
long requests returned all 16,568 bytes: the changed route in 295.071 seconds
and the unchanged route in 295.106 seconds. Fresh post-change traffic reached
backend B; both backends settled to zero active runs. No upstream connection
reset or Pod restart was recorded.

The private Service UID and original A/B UID/IP/HTTP-port references were
confirmed for 60.471 continuous seconds before client start, observed again
during execution and verified after accepted work settled. API A, API B and
proxy occupied three distinct nodes. The namespace was deleted normally and
its absence independently verified. All eight retained staging Pods were Ready
afterward with the application quarantine and owner unchanged. One client Job
ran; no retry, rebuild, qualification publication or production change followed.

The earlier no-extra-reference diagnostic delivered only 11,929 bytes through
its changed route. The complete retained-reference response supports the
backend-reference repair in this GKE scenario; this is not a packet capture or
an identification of a specific TCP reset emitter. Node placements differed
between the runs. The test covers filesystem-backed actual API execution, not
the external LB, managed storage or the whole worker/proxy replacement process.

The isolated investigation has supplied its next decision. Publish the final
repaired candidate after authorization, then pass its full timed staging rollout
before deploying production. No unchanged diagnostic repeat is required, and
the diagnostic's 9m55s duration is not a rolling-update performance result.
