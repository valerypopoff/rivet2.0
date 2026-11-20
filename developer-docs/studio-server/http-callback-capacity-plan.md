# HTTP callback capacity and failure diagnostics

Status — capacity and diagnostic work remains planned, November 20, 2026. The separate [HTTP response cleanup](http-call-response-cleanup-plan.md) is implemented and locally validated; it has not been deployed by this work.

## Intended outcome

Keep **Settings → Deployment → Concurrent runs per execution replica** adjustable during operation. Every HTTP Call node continues to execute the URL, method, headers, and body selected by its workflow. Applications that call Rivet and receive HTTP calls from Rivet must retain enough independent capacity to complete that cycle under load.

The implementation has two owners. Storyteller API removes its circular worker dependency and controls overload at its own boundary. Rivet improves generic HTTP failure evidence while preserving execution admission and HTTP behavior.

## Evidence and limits

The investigated recording is `8fb0bff4-a871-4482-86b2-41aa78ae15f0`, with request ID `loadtest-local-stage16-vu3-iteration463`. It ran on November 20 from 13:14:45.401 to 13:15:23.303 UTC.

- Its `Http Call - graphQL` node issued a `PutRivetStorage` mutation to `http://storyteller-api-sidecar.storyteller-api-test.svc.cluster.local/graphql`. The request failed after 54 milliseconds with `TypeError: fetch failed`.
- The destination had one API Pod. PHP-FPM logged zero idle workers and then its `pm.max_children = 16` limit at 13:14:50 UTC.
- At the failed callback's timestamp, application spans showed 16 incoming requests still awaiting Rivet. All were from the 16-user load-test stage.
- Both application and sidecar readiness probes called `/up`. They timed out repeatedly, with a two-second timeout and three-failure threshold. The first recorded failures preceded the callback.
- An earlier call in the same recording took 21.652 seconds and returned HTTP 200. The API and sidecar had zero container restarts. Historical CPU and RAM samples support worker exhaustion while waiting for network work.
- The recording retains the outer error stack. The server log abbreviates the deepest cause. The precise socket error code remains unavailable. Worker exhaustion is established, and loss of healthy service routing is a strongly supported explanation of the immediate network failure.

The observed dependency is `client → API worker → Rivet → another request to the same API`. The target's GraphQL protocol does not change that dependency.

## Source alignment before implementation

The local Storyteller checkout at `F:/Programming/Storyteller/storyteller-new-api` was on `6fa234531dee9996347e2a79ea93e213dadccb24`. The inspected test deployment reported application version `v0.0.291` and commit `351da04198a5082231e92bf0dcf4831fb5bd9ea4`. That deployed commit was absent from the local object database.

1. Obtain the deployed source from its authoritative repository and inspect the intended delivery branch. Preserve the existing local branch and work.
2. Locate the actual GKE manifests and image build source used by the test deployment. The local overlays describe a different ingress setup from the observed cluster. Update the owning deployment definitions.
3. Record the baseline for both repositories, the installed images, their source commits, service selectors, callback destination, and current effective Rivet limits.
4. Inventory every inbound route that can wait for Rivet and every API operation the captured workflow invokes. Include secondary flows, background branches, and existing published revisions that may be restored.

The following Storyteller paths exist locally and provide starting points. Verify them against the aligned source before editing.

| Responsibility                              | Starting point in Storyteller API                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Synchronous Rivet call and outgoing headers | `app/Infrastructure/Rivet/Client/RivetClient.php`                                      |
| Integration configuration                   | `config/rivet.php`                                                                     |
| Generation entry point                      | `app/GraphQL/Mutations/GenerateUnits.php`                                              |
| Image and FastCGI routing                   | `image/Dockerfile`, `image/nginx/storyteller-api.conf`                                 |
| Local routing                               | `docker-compose.yml`, `docker/nginx/default.conf`                                      |
| Delivery                                    | `deploy/overlays/`, `.gitlab-ci.yml`, `.gitlab-ci.development.yml`                     |
| Request/authentication contracts            | `tests/Unit/Infrastructure/Rivet/Client/`, `tests/Contract/GraphQL/`, `tests/Feature/` |

The deployed client currently derives `X-Api-Host` from `config('app.url')`. The captured published graph's `graphQL/getGraphQLUrlAndToken` reads `headers["x-api-host"]` and appends `/graphql`. That is a verified integration seam for routing this workflow without rewriting the generic HTTP node.

## Architecture

```text
Client
  → Storyteller public API and its PHP workers
    → Rivet, governed by the existing live execution limit
      → Storyteller internal callback service and its own PHP workers
```

Use a separate callback Deployment and Service, reusing the same reviewed application image and shared persistence. This gives the callback workload independent PHP workers and Pod readiness. The public and callback roles share normal domain code, authentication, and storage contracts.

Both roles have bounded admission. Saturation returns an explicit overload response at the receiving boundary. Rivet's per-replica limit remains an execution ceiling, and the API retains responsibility for its own capacity.

For an unrelated HTTP destination, its own capacity and response contract still apply. Keep Rivet's HTTP node generic. This repair adds no GraphQL-specific routing, hidden destination rewriting, or automatic global retry policy to Rivet. A separate per-destination throttle would require its own demonstrated need and design.

## Phase 1 — Isolate API callback execution

1. Add a deployment role for callback-serving API instances. Reuse the application bootstrap and domain implementations, with a small explicit role gate at the server boundary.
2. Serve the required lower-level API operations from this role. Preserve their existing request and response contracts. Reject operations that start a Rivet generation from the callback role before invoking business logic. Test aliases, multiple operations, and batched requests if the existing API supports them.
3. Preserve the existing authorization checks and scoped callback token. The observed `EnsureGraphqlWhitelist` checks user access, so verify and implement the role restriction independently of that user allowlist.
4. Give the callback Deployment its own selector, PHP-FPM pool, resource budget, readiness checks, and internal ClusterIP Service. Maintain its isolation from the public workload during scaling and rolling replacement.
5. Reuse the existing database, Redis, and object store. Verify that callback state is shared and durable and that request/session state required by a callback is independent of the original PHP process.
6. Inventory locks held across a Rivet call. Release avoidable database transactions and broad locks before waiting. A callback that needs a lock held by its caller would recreate the circular wait after worker separation.

Initial callback replica and worker counts are measured deployment choices. Record callback duration, peak parallel requests, database demand, and memory per worker before choosing those values. Keep enough callback capacity for the supported load and for one instance draining or failing during a rollout.

PHP's [`pm.max_children`](https://www.php.net/manual/en/install.fpm.configuration.php) bounds simultaneous requests in a pool. More Rivet execution capacity does not raise this receiving-service limit. Size each role against its measured workload and shared database capacity.

## Phase 2 — Route this integration explicitly

1. Introduce an API-owned callback base URL setting in `config/rivet.php`. A proposed name is `RIVET_CALLBACK_BASE_URL`. Preserve the current `APP_URL` behavior when the setting is absent so existing installations retain their current routing.
2. Validate the configured base URL and compose paths with the same existing rules. Preserve any base path. Keep credentials out of the URL.
3. Have `RivetClient` set the outgoing `X-Api-Host` from this configuration. Use the API's trusted configuration as its source. Preserve the request ID, user callback token, and public application URL used elsewhere in the product.
4. Point the test environment at the internal callback Service. Verify a previously published workflow reads that host through the existing header path and reaches the new service.
5. Verify preview/editor runs and alternate integrations separately. Their selected callback destination must be intentional and observable.
6. Audit older endpoint revisions for literal API URLs. Record any revision that needs a separately reviewed update. Preserve the legacy service while those callers still rely on it.

Rivet continues to use each node's explicit URL. The application supplies its own callback address through the existing integration contract. Other HTTP destinations keep their configured behavior.

## Phase 3 — Bound demand and preserve health checks

Implement per-Pod admission in the API's existing Nginx layer, ahead of PHP-FPM. Use a shared counter for the application server, accounting for every route that reaches PHP. Include internal redirects and direct front-controller requests in the verification.

- Bound the number of outstanding public application requests below the public pool's worker capacity, reserving space for short operational requests.
- Set a separate limit for the callback role from measured callback capacity. Bound any socket/FastCGI backlog and waiting time.
- Return a stable overload status and `Retry-After` when admission is full. Ensure clients surface that outcome. A rejected generation must return before it invokes Rivet or creates generation side effects.
- Keep counters correct across keep-alive, HTTP/2, client disconnection, slow uploads, streaming responses, and internal redirects.
- Use the active-request limit from `limit_conn`; a requests-per-second throttle measures a different quantity. Nginx documents per-server keys and concurrent stream accounting in its [connection limit module](https://nginx.org/en/docs/http/ngx_http_limit_conn_module.html).

Confirm that each Nginx instance fronts exactly the PHP pool whose admission it controls. Derive the limit from that role's configured pool and reserved headroom. Verify the effective rendered configuration during startup and deployment checks.

An Nginx request ending does not by itself prove its PHP work ended. Explicitly test disconnects during a blocking Rivet call and track the actual PHP worker lifetime. Retain bounded upstream execution and cleanup policies for abandoned requests, and do not release any application-owned permit before its work ends. Do not introduce a second distributed permit system unless this test establishes that the existing boundary cannot meet the required bound.

Keep `/livez` focused on process health and `/up` focused on readiness. Ensure health checks have reserved capacity and do useful bounded checks of PHP availability. Saturating public generation must leave the callback role available. Saturating either role must produce controlled overload responses rather than a cascading loss of every service endpoint.

Preserve current public success response formats. Use HTTP 503 with `Retry-After` for temporary API capacity rejection, and test the existing caller's handling. Keep Rivet's existing admission responses unchanged. Review GraphQL clients' handling of overload responses because HTTP 200 and application success have separate meanings. For required write callbacks, confirm the workflow checks an unsuccessful HTTP or application response. The inspected save node currently has `errorOnNon200` disabled, so response handling requires an explicit workflow review before relying on overload responses for that path. Make the correction in the affected workflow using its normal HTTP settings and response checks, preserving generic HTTP node defaults. A callback rejection must not silently turn a required write into a successful run or trigger a replay of the entire workflow.

## Phase 4 — Improve generic failure evidence in Rivet

The implemented [HTTP response cleanup](http-call-response-cleanup-plan.md) releases unused retry/error replies in the generic HTTP Call node. Its transport and performance checks passed locally. It preserves this plan's retry policy and does not replace the receiving-service capacity or remaining failure-diagnostic work.

Use the existing error and recording infrastructure.

| Responsibility                               | Rivet starting point                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| HTTP execution and configured retry behavior | [HttpCallNode.ts](../../packages/core/src/model/nodes/HttpCallNode.ts)                                       |
| Nested error formatting                      | [errors.ts](../../packages/core/src/utils/errors.ts)                                                         |
| Recorded node and terminal errors            | [ExecutionRecorder.ts](../../packages/core/src/recording/ExecutionRecorder.ts)                               |
| Protected server diagnostics                 | [execution-http-support.ts](../../packages/studio-server-api/src/routes/workflows/execution-http-support.ts) |
| Live execution policy                        | [published-execution-settings.ts](../../packages/studio-server-api/src/published-execution-settings.ts)      |

1. Extend or reuse the shared formatter to retain the nested network cause and available error code, syscall, destination host, and port. Handle `AggregateError`, cycles, malformed thrown values, cross-realm errors, and bounded output.
2. Use the same bounded failure description for the recorded node error and relevant protected server diagnostics. Retain the existing recording error string field and recording format compatibility.
3. Include existing run, node, and correlation identifiers in logs where available. Keep request bodies, authorization headers, and URL credentials out of diagnostic metadata.
4. Preserve abort semantics and distinguish cancellation from a network failure. Preserve configured HTTP status handling, caught-error outputs, and response types.
5. Keep retries explicit. The transport may lose an acknowledgement after a write succeeds, so a failed connection does not establish that a mutation had no effect. An operation-specific idempotency contract is required before retrying it automatically.
6. Format extra evidence only on failure. Preserve the ordinary successful execution path and the existing in-memory admission check.

This phase improves attribution for any HTTP target. Worker-capacity repair in the receiving application remains necessary to break the confirmed circular wait.

## Phase 5 — Verify adjustable concurrency

Keep the existing live setting and subscription behavior described in [the published execution concurrency plan](published-execution-concurrency-plan.md).

- A raise applies to new admissions after each execution replica receives it.
- A lower value preserves accepted runs and admits new work when active use falls below the new limit.
- Limits remain per execution replica across published endpoints, web-app actions, and scheduled runs.
- Rivet continues to return the existing capacity and draining responses. The UI remains usable while another service reports overload.
- Actual replica count, HTTP fan-out, callback duration, and provider capacity determine supported throughput. A chosen UI value is not a capacity reservation in another service.

## Phase 6 — Local regression and capacity proof

First create a deterministic reproduction with real PHP-FPM and Nginx, a small pool, and a controlled Rivet substitute. The substitute waits and calls back before responding. All test persistence uses disposable fixtures.

| Scenario                                      | Required evidence                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Original shared pool reaches its worker limit | Reproduce callback starvation and readiness delay before the repair                         |
| Public pool saturated after separation        | Accepted calls complete through the callback service and health checks respond              |
| Callback pool saturated                       | Bounded wait or explicit overload, with no indefinite accumulation                          |
| Callback role receives a generation operation | Reject before it can call Rivet and recreate the cycle                                      |
| Client disconnects during generation          | Admission recovers and existing side-effect policy is preserved                             |
| Callback succeeds but its response is lost    | Failed/uncertain outcome is visible and a mutation is not blindly repeated                  |
| Callback Pod is replaced                      | Service routing and in-flight outcomes are truthful while another healthy replica can serve |
| Previous frozen endpoint revision             | Header-based routing uses the configured service without changing the snapshot              |
| Network failures and non-2XX responses        | Existing HTTP node output contracts remain intact and the cause is inspectable              |
| Recorded network error and legacy recording   | Both remain playable and the output modal displays the error                                |

Then use real local Rivet and synthetic application data for the full cycle. Drive both routes: requests through Storyteller API and direct Rivet endpoint requests. Direct requests can create a different callback load because they consume no public API worker first.

Keep the deterministic CI reproduction small and fast. Run the larger capacity matrix as a separate local or staging check.

Exercise at least 16, 32, and 64 offered concurrent requests. With two Rivet execution replicas, explicitly test UI values of 16, 32, and 64, including a change from 32 to 64 during active work and a reduction to eight while more than eight runs are active. Also exercise the total configured ceiling and excess demand: two replicas at 64 permit up to 128 accepted runs, subject to actual routing and draining. Include callback fan-out and uneven traffic distribution. Do not infer full-capacity success from a test that offered fewer requests than the configured ceiling. Treat capacity rejections as deliberate outcomes and separate them from failures of accepted work.

Measure callback queue time, callback p50/p95/p99, total accepted-run latency, actual PHP active/idle counts, admission rejections, readiness failures, CPU, memory, database load, and recording availability. Establish a paired baseline at the same workload. Low-load runs should retain their existing latency within measurement noise. Choose and record the supported high-load envelope from these results.

Reuse relevant suites and add focused regressions for this incident.

- Storyteller API `RivetClientTest`, `RivetClientRequestIdTest`, generation contracts, auth tests, and `make test-all`.
- Rivet HTTP node, shared error, recorder, recorded playback, and published admission tests. Use the existing managed published-execution integration test for policy propagation.
- Render the actual deployment templates and check service selectors, roles, network access, pool limits, and independent readiness. An application mock alone cannot verify PHP worker isolation.
- Run the required headless `studio-server:ui:observe` check when verifying recording display or changing the Deployment settings behavior.

## Phase 7 — Staging and production sequence

1. Complete local proof and align both delivery pipelines with the reviewed source. Read the applicable CI pre-push notes before committing or pushing changes.
2. Deploy the callback role and Service first in staging, with its shared-state and authentication checks. Confirm readiness before switching callers.
3. Change the caller's callback base URL and verify the recorded destination on an ordinary saved workflow. Keep public API URLs and unrelated HTTP targets stable.
4. Repeat the original 16-user scenario, then the supported higher-concurrency matrix, with requests and data isolated to staging. Exercise callback replacement and live Rivet setting changes.
5. Record measured resource requirements and image digests. Include callback replicas in normal rollout, monitoring, and cleanup procedures.
6. For production, install and verify callback capacity before changing the API caller configuration. Observe accepted-run success, callback latency, overload rates, readiness, and recordings through the transition.
7. Keep the prior application image and routing available until accepted work drains and compatibility checks pass. On regression, restore the previous caller configuration while maintaining callback service availability for work already using it. Drain callback instances before retirement.
8. Deliver the Rivet diagnostic improvement through the ordinary Rivet release pipeline. Maintain independent rollback capability for application routing and Rivet diagnostics.

Staging load tests and production changes belong to the implementation and release steps after this plan is reviewed.

## Completion criteria

- [ ] Implement against the verified Storyteller source and actual deployment definitions.
- [ ] Reproduce the original shared-worker failure locally.
- [ ] Accepted request cycles make progress under the supported load through independently provisioned callback workers.
- [ ] Excess demand is bounded before consuming the workers needed to finish accepted work.
- [ ] Public API saturation preserves callback and operational health capacity.
- [ ] Generic HTTP behavior and the live Rivet concurrency setting retain their contracts.
- [ ] Existing frozen revisions and recordings remain usable.
- [ ] Network failures retain useful bounded causes and correlation details.
- [ ] Local and staging tests establish the supported concurrency and latency envelope.
- [ ] Rollout and rollback are rehearsed with in-flight requests and callback workers draining.
- [ ] Update owning developer documentation in both repositories with effective topology and measured limits.
