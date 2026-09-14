# Trusted clients and development authentication

## Authority

Server Settings → General accepts only client IP literals and CIDR networks.
`trustedClients` bypasses the existing operator, workflow bearer, and web-app gates.
Hostnames are not authorization evidence. Public/no-gate modes remain independent.
An empty list disables bypass; an unavailable client identity falls back to ordinary
authentication. Shared NAT/VPN addresses authorize every client represented by them.
Protected web-app HTTP origin checks and all web-app WebSocket origin checks still
apply to trusted clients. Explicitly public HTTP web apps keep their existing policy.

`client-networks.ts` uses ipaddr.js with strict `net.isIP` literal validation.
It normalizes network host bits and IPv4-mapped clients, rejects zone identifiers,
hostnames, nonstandard IPv4 forms, mapped CIDR syntax and universal `/0` ranges.
Lists have at most 100 entries. No local/private/container network is implicit.

Nginx overwrites `X-Rivet-Client-IP` in every API/gate forwarding location. The API
accepts this value only with valid proxy authentication, and rejects duplicate or
invalid address values. The legacy `X-Rivet-Token-Free-Host` flag is never authority.
The API evaluates current settings instead of trusting an independently cached
proxy Boolean. `/api` also enforces operator policy; only the executor-authenticated
environment and profile-health service routes retain their existing service access.

## Forwarding proxies

With direct access to the Rivet proxy, the transport peer is the client. Ignore
incoming address headers. Behind an ingress, set the deployment variable
`RIVET_TRUSTED_FORWARDING_PROXIES` to comma-separated **immediate/trusted forwarding
proxy addresses or CIDRs**, not bypass clients. Compose passes this to the proxy;
Helm accepts it in `env`. Keep direct access around that ingress restricted.

The generated include uses nginx `set_real_ip_from`, `real_ip_header
X-Forwarded-For`, and `real_ip_recursive on`. The ingress must overwrite incoming
forwarding headers or append its verified transport peer correctly at every hop.
Nginx chooses the nearest untrusted hop, not an arbitrary leftmost address. If a
trusted forwarding peer produces no usable rewritten client address, the internal
client header is empty: the proxy IP cannot become a fallback bypass client.
This also applies when an all-trusted chain rewrites the address to a different
forwarding proxy: the final address must be outside the forwarding-peer ranges.
Both executor WebSocket locations overwrite the proxy token and verified client
header, and all authenticated API handoffs strip the retired hostname hint.
Invalid directives fail nginx startup. Changing forwarding peers requires a proxy
restart; it is deliberately not a browser-editable capability.

`RIVET_TRUST_INCOMING_FORWARDED_HEADERS` still concerns URL host/protocol construction,
not permission to assert client IPs. Configuring it alone does not enable IP trust.
Do not whitelist a shared ingress/Docker bridge/pod network as clients to compensate
for missing provenance. Configure ingress forwarding or keep ordinary login.

## Migration and rollout

API/type/UI names are Trusted clients and `/api/app-settings/trusted-clients`.
The durable domain key `trusted host` and `settings/trusted-hosts.json` are retained
intentionally for encrypted-row identity and in-place file migration. Old
`trustedHosts` become `legacyTrustedHosts` display information; no DNS conversion
is attempted and no client access is inferred. Saves preserve that information.
The old settings API is removed, and writes using the old hostname field are rejected.
The current-request diagnostic endpoint is operator-only and returns no secrets.

Malformed trusted-client content disables the optional bypass policy and exposes
`policyError` to authenticated administrators. It does not block ordinary login.
The repository's narrowly scoped `recoverParseError` hook runs only after content
has been read/decrypted; filesystem, database and decryption failures are not
converted to healthy defaults. Other mandatory settings retain their fail-closed
behavior. Reloading invalid content revokes trusted-client connections.

Reads preserve malformed files/managed rows unchanged. Save a corrected list
(including an explicitly empty list) to repair the policy; a partial write without
`trustedClients` cannot clear the error. Back up the original data first if needed.
The error participates in the snapshot revision so repair is distinct from an
already-valid empty policy. Managed bootstrap from malformed local content persists
a disabled/error marker while preserving the original file; an explicit save clears
it. Existing managed rows retain their database revision for compare-and-swap repair.

Before upgrade, verify normal key/OAuth administrator login. After upgrade, log in,
read the verified client address displayed in Settings, and enter the intended
client/network policy. Do not copy example networks into a live deployment.
If hostname bypass was the only entry path, configure a known `RIVET_KEY` and
`RIVET_SERVER_UI_AUTH_MODE=key` through the deployment administrator, then restart
the participating services. Never recover by enabling unrestricted bypass.

Roll out API/proxy/executor together. A new API with an old proxy has no verified
client handoff and requires normal authentication. New proxy snapshots return an
empty legacy `trustedHostsCsv` for old proxies. Upgrading only the proxy does not
repair an old API's trust model; keep the public edge restricted during mixed-version
rollout and do not claim the security fix complete until all components are updated.
Rolling back to old binaries restores their vulnerabilities.

Deployment acceptance is separate from local verification. Before exposing an
upgraded installation, verify normal administrator login, the observed client IP
through its actual ingress, rejection from an untrusted network despite forged
headers, and revocation of an established debugger/event stream. On managed
deployments, also verify cross-replica policy propagation and database outage/recovery.
The isolated Docker checks below validate the shipped proxy templates; mocked
PostgreSQL tests do not substitute for the installation's real network and database.

## Long-lived access

`watchAuthorization` rechecks outside the opening request's AsyncLocalStorage
snapshot. Trusted-client/OAuth notifications revoke on the local replica; a five-second
timer catches expiry and repository errors. Replica convergence uses the existing
settings backend notification/polling contract. Web-app client frames also check
cached authorization before parsing/dispatch. A trusted-client socket cannot silently
switch its run-ownership scope to a different principal; it must reconnect.

Workflow-tree SSE, evaluation-library SSE, runtime-library job SSE (both storage
backends), and the latest debugger close on revoked operator authorization.
`watchOperatorStreamAuthorization` owns response-lifetime authorization for operator
event streams and releases subscriptions on finish/close. Revoking a log viewer
does not cancel the underlying install/remove job. Managed job streaming permits
only one outstanding storage poll, discards results after revocation/disconnect,
and closes an already-started stream if its job disappears instead of sending a
second HTTP response.

Settings refresh failures, including filesystem metadata errors and managed
read/decryption failures, invalidate the cached policy until a successful refresh.
An unchanged file signature must not prevent recovery from a transient read error.
Malformed optional policy content still follows the explicit disabled-policy repair
path; storage failures are not silently converted to empty/default settings.
Managed revision-index polling has its own cached-policy boundary: a failed poll or
failed application of a revision blocks synchronous cached reads. A stalled poll
also expires the index after `max(15 seconds, 3 × configured poll interval)`, measured
with a monotonic clock from the index query's start. A late result cannot renew an
already-old snapshot. New HTTP request snapshots fail closed; authorization watchers
recheck outside old request snapshots and close affected transports on their next check.
Normal request snapshots already in use retain the existing per-request consistency.

After a synchronization failure, the next successful poll refreshes values even
when their database revisions have not changed. An individual failed domain refresh
invalidates its backend revision acknowledgement for the same reason. Healthy
unchanged polls still read only the revision index. This prevents both stale grants
during an outage and permanent lockout after a transient read failure. Loss of LISTEN
alone does not disable access while complete polling remains healthy. This is a
deliberate availability tradeoff: operators should restore database synchronization,
not work around the failure by enabling unrestricted access.

Latest-debugger upgrade authorization is outside Express middleware. Unreadable
mandatory authorization settings reject the upgrade with HTTP 503, invalid targets
with 400, and ordinary denied credentials with 401; none may escape the HTTP upgrade
callback and crash the API. Existing debugger sockets retain their revocation checks.
The hosted executor authenticates upgrades against the control API's `/ui-auth/check`
and rechecks every five seconds. Its authorizer admits at most 16 concurrent checks
and 64 FIFO waiters; brief bursts wait instead of incorrectly revoking valid clients.
The three-second deadline includes queue wait and response cleanup. Disconnects
remove waiters or abort active fetches. Only the auth endpoint's explicit HTTP 204
response authorizes a client; redirects, HTTP 200, errors and saturation deny access.
No previous successful result is reused after policy changes. Failed checks terminate
the connection; ordinary standalone executors retain
their previous behavior. Existing disconnect/run ownership semantics remain in force;
revocation is not a new global graph cancellation mechanism.

## Dummy OAuth

Dummy login requires `RIVET_ENABLE_DEVELOPMENT_AUTH=true` **and** an explicitly
configured `RIVET_DEVELOPMENT_AUTH_CLIENTS` list on the API. Defaults deny all.
Compose forwards both variables from deployment configuration; Helm accepts them
under `env`, and the Kubernetes launcher carries them into generated values.
Forwarding peer selection uses Nginx's
[recursive real-IP rules](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
with explicit trusted peers, never an unrestricted forwarded-header trust setting.
Use a separate isolated development deployment, a loopback-only host binding, or
a properly restricted VPN/tunnel. Container loopback and host loopback are not
interchangeable; verify the observed address instead of assuming the Docker gateway
is safe. These deployment variables must not be changed through browser settings.

Both OAuth implementations check this capability during login/callback and session
use. Their dummy state/session version includes the deployment policy, invalidating
older dummy sessions. `dummyAllowNonLocalhost` remains readable for storage compatibility
but no longer grants access and is not offered as a UI switch. A cookie minted on
the allowed development path cannot authorize a public-path request. External
provider identity verification is a separate work item, not changed here.

## Verification

Run `yarn test:style` before runtime tests. Focused API coverage is in
`src/tests/trusted-clients.test.ts` and `src/tests/hosted-client-authorization.test.ts`,
plus settings/OAuth/proxy suites. Node gateway
coverage checks revocation before action dispatch. For real network provenance run:

```sh
node deploy/studio-server/scripts/verify-trusted-client-proxy.mjs
```

It uses an isolated Docker network, no published ports, distinct client/edge containers,
and the production client-address generator. It starts **all three complete templates**
through the real bootstrap, generates public-route includes, and runs `nginx -t`.
IPv4/IPv6 forwarding chains include missing, malformed and all-trusted provenance.
The separate DNS failover fixture renders those templates without starting that bootstrap;
it therefore supplies a minimal, syntactically valid fixture for the generated
`RIVET_CLIENT_ADDRESS_INCLUDE_FILE`. It has no forwarding peers but declares the same
nginx variables, keeping DNS replacement coverage independent of client-address
provenance while still requiring every template placeholder to resolve.
Real WebSocket upgrades exercise both executor routes with the production hosted
authorizer and a controlled HTTP identity provider: trusted clients, ordinary cookies,
forged hints, rejection and live revocation. It removes only its own fixtures and
runs in the deployment-contract CI job. This is not a live Kubernetes rehearsal.

API tests additionally cover actual dashboard/job SSE and latest-debugger revocation,
preservation of normally authenticated SSE sessions, malformed-policy login, settings
read-failure recovery, and managed replica notification/CAS behavior.
`src/tests/runtime-library-stream.test.ts` uses deferred storage reads and controlled
timers to verify single-flight polling, closure during lookup, missing jobs, and
shared initial/polled terminal delivery. Managed tests
use the repository backend fixture, not a live multi-replica PostgreSQL deployment.
`src/tests/managed-settings-sync.test.ts` additionally exercises the real PostgreSQL
settings backend/repository against mocked driver I/O and controlled clocks: failed
revision queries, failed recovery, unchanged-revision recovery, and stalled queries.

For browser verification with real authentication and persistence (no HTTP mocks):

1. Build API/shared and web from this checkout.
2. Set `RIVET_TRUSTED_CLIENT_BROWSER_FIXTURE=1`, then run
   `yarn workspace @valerypopoff/rivet-studio-server-api exec tsx src/tests/helpers/trusted-client-browser-server.mts`.
   This prints its ephemeral API port and owns temporary storage seeded with an
   invalid trusted-client policy. Stop it with Ctrl+C to remove that storage.
3. Serve the web build with `yarn workspace @valerypopoff/rivet-studio-server-web preview --host 0.0.0.0 --port 4187 --strictPort`.
4. Start a disposable production-template Nginx proxy bound only to host loopback.
   Mount the production proxy script directory and template, run
   `/opt/rivet/proxy/normalize-workflow-paths.sh`, and set `RIVET_KEY=fixture-key`.
   Set API/execution upstream host/port to the fixture and web upstream to port 4187
   (Docker Desktop uses `host.docker.internal`; Linux needs a host-gateway mapping).
   Set the usual executor upstream variables and `RIVET_PROXY_RESOLVER=127.0.0.11`.
   Use a **user-defined Docker network** for the embedded Docker resolver.
   If the Docker engine cannot reach the host, run the fixture in `node:24-bookworm`
   on that network with the checkout mounted read-only at `/repo`, working directory
   `/repo`, `RIVET_TRUSTED_CLIENT_BROWSER_PORT=8080`, and the same Yarn/tsx command.
   Give it the network alias `api`; serve the web `dist` directory using an isolated
   Nginx container aliased `web`. Use API/execution port 8080 and web port 80.
   No API port needs to be published. The fixture owns its temporary data.
5. With `PLAYWRIGHT_BASE_URL` pointing to that proxy,
   `RIVET_TRUSTED_CLIENT_BROWSER_FIXTURE=1`, `PLAYWRIGHT_HEADLESS=1`, and
   `PLAYWRIGHT_SLOW_MO=0`, run
   `yarn studio-server:ui:observe trusted-clients-live.spec.ts`.
   It verifies real key login, visible policy repair, invalid hostname rejection,
   persisted IP settings, and the verified-client display.
   The test types the fixed non-secret fixture key, never the developer's dotenv key.
   It edits again immediately after saving: modal feedback clears on bubbling
   change/click, not input capture, so a feedback rerender cannot restore the old
   controlled textarea value before its own change handler reads the new input.
6. Remove only the disposable proxy and stop both fixture servers. Never point this
   seeded-data test at a production deployment.

Run the standard headless `yarn studio-server:ui:observe` settings scenario against
a web app built from the changed checkout; it checks IP/network save/revert and the
verified-address display. Also build API, Node, shared, hosted executor and web;
verify Helm rendering and migration-ledger contracts when their paths change.
