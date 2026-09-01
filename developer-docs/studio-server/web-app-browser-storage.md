# Published web-app browser storage

Published and latest Rivet web apps persist Chat-owned state and Stored Values in a dedicated IndexedDB database named `rivet-web-app-browser-storage`. This is browser-local application state. It is not a workflow artifact, a recording, an Evaluation dataset, or server-managed storage.

## Scope and privacy boundary

The storage scope preserves Rivet's existing boundary: browser origin, normalized pathname, UI graph id, and the component or Stored Value key where applicable. Consequently:

- data is local to one browser profile and origin;
- a published app and its latest-draft app have independent pathname scopes;
- two devices or browser profiles do not synchronize;
- clearing site data, private-browsing teardown, browser eviction, or profile loss can remove the data;
- the server never writes browser Stored Value payloads to PostgreSQL, object storage, recordings, logs, or shared Kubernetes volumes;
- host-provided storage callbacks remain authoritative and bypass this browser database.

Rivet does not request `navigator.storage.persist()`. Browser quota and eviction behavior remain browser decisions; inspect the live estimate rather than assuming a fixed capacity. See [MDN's storage quota and eviction reference](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

## IndexedDB record model

Core exposes one `WebAppBrowserStorage` contract for Chat and Stored Values. Its IndexedDB implementation has metadata, chunk, migration, and staging stores. Portable JSON is UTF-8 encoded and split into 256 KiB chunks.

Each write creates a new generation:

1. write the new generation's chunks and staging metadata;
2. reconstruct and validate its byte count and JSON payload;
3. atomically switch the active record metadata to that generation;
4. remove superseded chunks after the commit.

Writes are serialized per scoped key. A stale asynchronous write cannot replace a newer committed generation. `BroadcastChannel` publishes only record revisions, never contents or user-defined key names. Other tabs reload the record after their own pending write finishes; a tab with an unsaved memory-only value keeps that live value rather than letting a remote revision erase it. Focus-time revision checks use the same rule for browsers where `BroadcastChannel` is unavailable. This is last-committed-generation behavior, not collaborative merging.

Only portable JSON is accepted. Cycles, functions, sparse arrays, non-finite numbers, and unsupported object or binary instances fail before the active generation changes.

If IndexedDB cannot open, or a durable write fails, the page keeps the current live value in memory and renders a persistent non-blocking warning. That memory copy is not reported as durable and disappears on reload. Quota exhaustion has its own warning. Warnings and diagnostics never include Chat contents, Stored Value payloads, or user-controlled key names.

## Legacy `localStorage` migration

Runtime initialization enumerates only exact Rivet-owned legacy keys produced by the existing Chat, response-trace, and Stored Value key builders. It validates each payload with its current schema before importing it.

After a verified import, IndexedDB becomes authoritative immediately. The original `localStorage` value is retained, frozen and not dual-written, for 30 days so an older published renderer can be rolled back safely. A later initialization removes only successfully imported Rivet-owned keys whose cleanup deadline has passed. Unrelated host-site keys and invalid legacy values are never removed.

Migration state is versioned and idempotent. Reloading cannot overwrite a newer IndexedDB generation with an older legacy value, and interrupted imports resume safely. One corrupt legacy record does not block valid records in the same web app; the corrupt source remains untouched and produces a privacy-safe diagnostic. If a later retry imports it successfully, the warning clears immediately.

While one exact Chat or Stored Value legacy record remains unconfirmed, Rivet reads IndexedDB first. Only a missing IndexedDB record may fall back to that exact, still-unmigrated legacy key; the read immediately retries its import. The migration ledger is recorded only after the imported records are durable; a memory-only write leaves the legacy source eligible for a later retry. As soon as the ledger is recorded, a missing IndexedDB record remains missing—Rivet never resurrects a deliberately deleted value from the frozen rollback copy.

When IndexedDB is available, new Chat saves and Set Stored Value writes always target IndexedDB, even after an interrupted migration. Rivet does not dual-write them to localStorage. If IndexedDB is unavailable before the first successful migration, the page continues to read and write the existing legacy storage for that page session.

## Chat state versus Stored Values

Chat persistence includes the existing bounded subset:

- messages;
- draft text;
- pin indexes;
- retained response-inspection traces in their separate bounded scope.

Response-trace insertions and pruning are serialized as one bounded read-modify-write path, so near-simultaneous trace updates cannot drop an earlier trace.

The renderer hydrates this state before presenting an empty conversation. It writes only when Chat-owned state changes, so unrelated graph/UI updates do not repeatedly serialize the history.

Stored Values are graph-visible portable JSON used by `Get Stored Value` and `Set Stored Value`. Expected browser capacity is larger than the old `localStorage` ceiling, but that does not make hundreds of megabytes of Chat messages practical to render or send to an LLM. Chat history, Stored Values, and the context selected for an LLM request remain separate concerns.

## Browser-storage RPC v2

Current published web apps negotiate `browser-storage-rpc-v2` on the existing resumable action WebSocket. Old browsers and servers continue to use the legacy full `storageSnapshot`/`storagePatch` protocol.

With RPC v2:

- `Get Stored Value` checks the action-local write overlay, then the action cache, then requests only the dynamic key actually read;
- `Set Stored Value` updates the overlay, so a later read in the same action observes it;
- a returned action patch is accepted only after one browser-side atomic, durable commit; otherwise the app reports the save failure rather than claiming that the Stored Value survived reload;
- graph failure, cancellation, timeout, disconnect, invalid framing, or capacity rejection disposes the action cache and incomplete transfer without committing it; storage-free actions can still finish and be resumed after a disconnect, while a later Stored Value read, write, or pending storage commit fails explicitly;
- JSON control frames identify the action and transfer while binary frames carry ordered raw UTF-8 chunks;
- duplicate, missing, out-of-order, oversized, cross-session, and cross-action chunks are rejected.

HTTP and old WebSocket clients retain the legacy protocol up to the 4 MiB safe fallback size. A new browser prefers RPC v2 whenever it is negotiated. If the legacy snapshot is larger than 4 MiB, execution fails before the graph starts with an update/transport message; Rivet never silently truncates state.

The default limits are:

| Setting                                             |               Default | Meaning                                                           |
| --------------------------------------------------- | --------------------: | ----------------------------------------------------------------- |
| `RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_TIMEOUT_MS` |               `60000` | Maximum lifetime of one storage transfer                          |
| `RIVET_WEB_APP_BROWSER_STORAGE_MAX_VALUE_BYTES`     | `268435456` (256 MiB) | Maximum encoded size of one value                                 |
| `RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTION_BYTES`    | `536870912` (512 MiB) | Maximum aggregate storage bytes transferred by one action         |
| `RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTIVE_BYTES`    | `536870912` (512 MiB) | Per-execution-replica reservation ceiling across active transfers |

Keep the value limit less than or equal to the action limit. Size the active ceiling with the published-execution admission limit and the real memory budget of each execution replica. Declared sizes reserve capacity, but actual bytes are counted independently. Capacity exhaustion is retryable; invalid or oversized payloads are not.

## Deployment and observability

The API action host alone receives the RPC limit settings. The browser receives the effective value, action, and transfer-timeout limits during capability negotiation and enforces them too. A browser-side timer fails a stalled inbound commit instead of waiting indefinitely for the action socket to close. Compose and Helm proxy paths for published and latest app action WebSockets must preserve upgrades, binary frames, long-lived reads, disabled buffering, and timeouts longer than the configured transfer timeout.

If a browser disconnects, incomplete transfers and their action-local values are discarded immediately. A graph that has not used browser storage may finish and later be reattached through its normal run-resume path; any later `Get Stored Value` or `Set Stored Value` fails at that node, and a pending storage commit cannot be reported as durable.

The API exposes privacy-safe metrics when metrics are enabled:

- `rivet_web_app_browser_storage_rpc_negotiations_total`;
- `rivet_web_app_browser_storage_rpc_transfers_total`;
- `rivet_web_app_browser_storage_rpc_transfer_bytes_total`;
- `rivet_web_app_browser_storage_rpc_transfer_size_buckets_total`;
- `rivet_web_app_browser_storage_rpc_transfer_duration_seconds`.

Negotiation metrics distinguish RPC v2 from the legacy snapshot fallback. Transfer labels contain only direction, outcome, and retryability. Outcomes distinguish completed, cancelled, capacity-rejected, invalid, too-large, and unavailable transfers. Browser diagnostics likewise report only operation/outcome and never values or user-controlled keys.

## Compatibility matrix

| Browser runtime        | Server                | Behavior                                                                    |
| ---------------------- | --------------------- | --------------------------------------------------------------------------- |
| New                    | New                   | IndexedDB plus on-demand RPC v2 over WebSocket                              |
| Old                    | New                   | Accepted legacy snapshot/patch protocol                                     |
| New                    | Old                   | Negotiates down; runs only while the legacy snapshot is at most 4 MiB       |
| HTTP-only action       | Any compatible server | Legacy snapshot/patch protocol with the same 4 MiB safety boundary          |
| Host storage callbacks | Any                   | Host remains authoritative; browser IndexedDB is bypassed for Stored Values |

A server that already offers RPC v2 but predates the timeout field may still advertise only value and action byte limits. The browser accepts that legacy shape and applies the safe 60-second default locally; it does not reject the entire action connection.

Editor-originated graph actions do not use the published-web-app RPC bridge. They use the editor/host storage boundary and must not be treated as public endpoint storage transfers.

## Verification

Relevant local gates include:

```text
yarn workspace @valerypopoff/rivet2-core exec tsx --test test/model/WebAppBrowserStorage.test.ts test/model/WebAppBrowserStorageRpc.test.ts test/model/UiGraphActionProtocol.test.ts
yarn workspace @valerypopoff/rivet2-node exec tsx --test test/webAppBrowserStorageRpc.test.ts test/webAppClientStorageRpc.test.ts test/webAppClientTransport.test.ts test/webAppSocketGateway.test.ts
yarn workspace @valerypopoff/rivet-studio-server-api run test:files src/tests/browser-storage-deployment-contract.test.ts src/tests/metrics.test.ts
yarn studio-server:verify:kubernetes
```

UI changes also require the headless `yarn studio-server:ui:observe` gate. A release touching the public WebSocket/proxy path should complete the managed Kubernetes rehearsal before promotion, not only the static Helm contract tests.
