# Provider-neutral Knowledge Source API

Canonical maintainer contract for durable retrieval sources, provider adapters, graph nodes, and host overrides.

## Ownership

Core owns the provider-neutral types and lifecycle:

- `packages/core/src/integrations/KnowledgeStore.ts`: public documents, source references, evidence, filters, requests, capabilities, and store/registry interfaces
- `packages/core/src/integrations/KnowledgeStoreProvider.ts`: provider registry and one-root-run connection controller
- `packages/core/src/integrations/KnowledgeStoreValidation.ts`: portable boundary validation
- `packages/core/src/integrations/ManagedKnowledgeStore.ts`: deterministic chunking, immutable version activation, idempotency, serialization, and multi-query fusion
- `packages/core/src/model/nodes/*Knowledge*.ts`: the six built-in workflow nodes
- `packages/core/src/plugins/pinecone/PineconeKnowledgeStore.ts`: the first provider adapter

The app owns named-connection editing and local credentials. Node and web-app packages only propagate host registries into core.

The connection editor renders each provider field as an independently spaced label/control/help group. Keep the modal layout on its root container so provider forms retain the same vertical rhythm as fields are added or removed.

## Project and Secret Boundary

`ProjectMetadata.knowledgeStores` is a record keyed by stable connection ID. Each value contains a display name, provider ID, owning plugin ID, and provider-specific portable non-secret configuration. Several connections can use the same provider. Older connections without `pluginId` fall back to the provider ID.

Connection, provider, owning-plugin, configuration-field, metadata, and filter-field identifiers reject JavaScript's `__proto__`, `prototype`, and `constructor` object keys. These identifiers cross ordinary settings/project record boundaries, so accepting the reserved names would make editor and runtime lookup semantics depend on object prototypes.

All remaining dynamic-key reads use own-property checks. Names such as `toString` and `valueOf` are therefore valid provider field names and resolve defaults or explicitly stored values rather than accidentally reading `Object.prototype`; the editor and runtime use the same rule. Defaults apply only when a field is absent: an explicitly stored `null`, `undefined`, or wrong-type value cannot silently turn into the provider default.

Named connections count as plugin usage even though their workflow nodes are provider-neutral core nodes. The app's plugin-spec derivation therefore retains or adds the owning provider plugin; if that owner is unresolved, existing plugin specs are preserved conservatively until usage can be proven.

Provider credentials never belong in `Project`. The editor stores them under:

```text
settings.pluginSettings[providerId].knowledgeStoreCredentials[connectionId]
```

Provider registration rejects secret fields in `connectionConfigSpec`; secrets must use `credentialConfigSpec`. Duplicating a connection copies portable configuration but intentionally starts with empty credentials. The runtime controller reads only declared string credentials from the local settings record and supplies them as `KnowledgeStoreProviderContext.credentials`; adapters must not duplicate knowledge of the settings storage path.

The editor's connection test receives the same provider and owning-plugin identity that will be persisted with the connection, plus normalized unsaved configuration and credentials. A provider test must still be side-effect-free with respect to source data. Pinecone's test also validates that a successful response is JSON object data, so an HTTP proxy returning a `200` HTML/error page cannot produce a false-positive connection result.

Project deserialization first validates the generic connection-record shape, unpadded stable IDs/names/configuration keys, provider/plugin IDs, and portable configuration so malformed metadata cannot crash the editor. Structural validation failures retain their specific diagnostics through the public `deserializeProject(...)` boundary instead of becoming a generic load error. Project-backed connections are then revalidated against the installed provider when first resolved in every root run. Unknown fields, missing required values, wrong scalar types, invalid provider/plugin ownership, and undeclared data do not reach provider factories. This keeps hand-edited and programmatically produced project files on the same boundary as the editor UI.

## Runtime Resolution

Every top-level `GraphProcessor.processGraph(...)` creates a fresh `KnowledgeStoreController`. Nested graphs, delegated tool graphs, and async branches share that controller. It lazily resolves each project-backed connection once per project object and connection ID within the root run, so referenced projects may safely reuse names such as `primary` for different stores. Host registry IDs remain root-run-wide overrides.

Resolution precedence is:

1. `knowledgeStores[connectionId]` supplied by the host
2. project connection definition plus the registered provider factory

The controller cache is not persistence. Reusing a processor for another top-level run creates a new controller and provider instance. Provider clients can maintain their own external pools if construction is expensive.

Host registries are accepted by core and Node `runGraph` / `createProcessor`, `runRivetWebAppAction`, static web-app handlers, and WebSocket sessions. `createProcessorOptions(context)` can return a request-scoped registry; it overrides a static web-app registry. This is the recommended authenticated and multi-tenant seam.

Registries contain live callback objects and are never serialized to a remote executor. Remote Node runs resolve project provider configuration on the remote runtime.

## Data and Node Surface

Three scalar `DataValue` types are first-class and also receive array/function variants:

- `knowledge-source`
- `knowledge-document`
- `knowledge-evidence`

The built-in nodes are:

- Knowledge Source: creates a connection/source/version reference
- Knowledge Document: validates text and flat portable metadata
- Sync Knowledge Source: complete-source synchronization
- Get Knowledge Source Status: authoritative manifest lookup
- Search Knowledge: single/multi-query retrieval and normalized evidence
- Build Knowledge Context: bounded prompt packing and citation mapping; requested metadata fields are included only when they are own properties of the validated evidence record

The editor gives all six Knowledge nodes the same database icon in their canvas headers. Keep that cue at the shared title-label layer rather than duplicating header rendering in individual node definitions.

Static metadata and filter settings use the shared `jsonObject` editor definition. It renders the stored object as formatted JSON, commits only syntactically valid JSON objects, and keeps invalid draft text visible with a validation message while the developer corrects it. Do not use the scalar `anyData` text editor for object-backed settings; JavaScript object coercion would render values such as `{}` as `[object Object]`.

Missing sources and inactive exact versions are normal status/search outputs. Authentication, provider, malformed data, and transport failures are errors. Tool graphs must not throw merely to communicate that initialization is required.

Node boundaries validate high-level results from host-provided stores as well as plugin stores. Returned source identity, committed versions, counts, messages, evidence, query groups, and metadata must satisfy the public contracts before becoming typed graph outputs. Optional document/evidence fields are rejected when present with the wrong type instead of being silently discarded, versions remain bounded, top-level and per-query evidence IDs must be unique, and successful query groups must match the normalized requested queries in order. `KnowledgeSourceStatus` is discriminated by `exists`: an existing source must return its non-empty `activeVersion`, while a missing source cannot return one. When an expected version is supplied, Rivet derives the match from the returned active version and rejects a contradictory provider flag. The public TypeScript contract mirrors these runtime invariants so malformed host adapters fail during development instead of later in a graph run.

## Portable Contracts

Metadata is a flat record of null, finite number, boolean, string, or a homogeneous scalar array. Providers may support a narrower subset and must reject unsupported values explicitly before a write.

Filters use a provider-neutral AST:

- comparison: `{ field, operator, value }`
- logical: `{ and: [...] }`, `{ or: [...] }`, `{ not: ... }`
- comparisons: `eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `exists`

Validation rejects ambiguous objects, empty logical groups, wrong array/scalar operator values, non-finite numbers, and nested metadata. `ManagedKnowledgeStore` validates declared provider capabilities before issuing searches. Connection-default reranking is best effort; required reranking fails if unsupported.

## Managed Lifecycle

`ManagedKnowledgeStore` gives thin provider drivers a safe high-level lifecycle:

1. Normalize documents, source metadata, and chunking settings.
2. Resolve stable document IDs and reject duplicates before any provider write.
3. Hash their stable canonical representation into `ks1-<sha256>`.
4. Read and validate the active durable manifest.
5. Return `unchanged` without writes when the version already matches.
6. Chunk all documents deterministically.
7. Upload chunks under the immutable version.
8. Commit the new manifest with a unique activation ID only after every chunk write succeeds.
9. Re-read the manifest and require that exact activation ID, not merely the same content version, so same-version Force Refresh races cannot report false success.
10. Verify the same activation remains active before deleting the prior version.

Failed uploads leave no active partial version. Orphan chunks can be overwritten by a retry because IDs are deterministic. Cleanup failure becomes a warning after activation; cancellation is never downgraded to a warning.

Same-source syncs are serialized within the store instance. Drivers can also declare a stable `operationScope`; every managed store instance with that scope shares a same-source queue in the current JavaScript runtime. The Pinecone driver scopes coordination by index host, so separate root runs in one process do not race each other. Cancelling a queued operation does not release later operations past an earlier running sync. Different sources can sync independently.

Runtime-local serialization cannot coordinate separate servers or browser processes. Provider backends or application hosts still own distributed concurrency. The post-commit manifest check prevents a losing writer from falsely reporting its version as active, but retention cleanup assumes externally coordinated writers when several runtimes can update the same source.

Search always reads the durable manifest. It never relies on browser storage and never searches an arbitrary exact version that is not active. Node boundaries reject a host store that substitutes another version for a pinned search or returns final evidence absent from all per-query groups. Multi-query searches use bounded concurrency, preserve query order, and fuse duplicate evidence with reciprocal-rank fusion. String arrays emitted through `any`-typed Code, Destructure, and similar dynamic ports remain separate validated queries rather than being coerced into one newline-joined string; non-string members still fail at the node boundary. If one provider query fails, Rivet aborts its unfinished sibling requests before propagating the failure.

## Pinecone Adapter

The Pinecone provider targets serverless indexes with integrated embedding. It uses:

- `POST /records/namespaces/{namespace}/upsert` for NDJSON text records
- `POST /records/namespaces/{namespace}/search` for text search and optional reranking
- vector fetch/delete endpoints for manifest lookup and version cleanup
- one namespace per logical source through a template containing `{sourceId}`; the placeholder expands to a readable slug plus a stable hash so different source IDs cannot collide after sanitization

Record fields use the non-system `rivet_` prefix. Only `_id` begins with `_`, because Pinecone reserves leading underscores for system fields. User metadata cannot collide with the reserved prefix. Rerank result counts are capped to the requested search result count, and Pinecone-only numeric comparison constraints are validated before a request.

Pinecone is eventually consistent. Every activation receives a random commit ID, so manifest polling can distinguish a Force Refresh from an older manifest even when the content version and timestamp match and Pinecone omits LSN headers. When Pinecone returns log sequence number headers, the poll also requires the read's indexed LSN to cover the manifest write. Since writes are ordered within a namespace and the manifest follows all chunk batches, this establishes that the earlier version writes are reflected before success and cleanup. Existing schema-v1 manifests without a commit ID remain readable.

Requests require an HTTPS index host, carry the configured Pinecone API version, retry retryable HTTP/network failures with abort-aware backoff, honor `Retry-After`, and retain the original provider response body in `PineconeKnowledgeError`. Successful fetch/search responses, including the fetch endpoint's required vector map and returned user-metadata values, are shape-checked instead of being mistaken for a missing source, an empty search, or silently discarded metadata. Write bodies are consumed, NDJSON batches and manifest metadata remain below provider limits, and unsupported Pinecone metadata/filter shapes fail locally.

The adapter deliberately does not own index creation/deletion. Index lifecycle, cloud/region, embedding model, deletion protection, and schema remain infrastructure concerns.

## Provider Extension Contract

A plugin registers `KnowledgeStoreProviderDefinition` during `register()`:

- stable provider ID and display name
- portable connection fields
- separate credential fields
- supported executors
- `createStore(...)`, whose context includes validated per-connection credentials
- optional editor connection test

Registration is a runtime boundary even for JavaScript plugins: Rivet validates the provider identity, field arrays, executor list, callbacks, field types/labels/flags/defaults, and select-option shapes before publishing the provider to projects or nodes. Rivet stores a deeply frozen snapshot of the validated definition, so later plugin or UI mutations cannot invalidate those guarantees. Malformed definitions fail with provider-specific diagnostics rather than later editor `TypeError`s.

Use `ManagedKnowledgeStore` when the backend can expose manifest, chunk upsert, search, and version delete primitives. Implement `RivetKnowledgeStore` directly only when the backend already owns equivalent source/version semantics.

Provider callbacks must propagate cancellation, report backend failures without silent fallback, avoid logging document/query payloads, and enforce tenant authorization in the host or provider boundary.

Credential field requirements and string defaults are enforced during runtime connection resolution as well as in the editor. A provider that supports another fallback, such as an environment variable, should leave its per-connection credential optional and resolve that fallback inside `createStore`.

Managed drivers should provide `operationScope` whenever several store instances can address the same backend. The scope must be stable for that backend inside one runtime and must not contain credentials.

## Verification

Coverage lives in:

- `packages/core/test/integrations/ManagedKnowledgeStore.test.ts`
- `packages/core/test/integrations/KnowledgeStoreProvider.test.ts`
- `packages/core/test/model/nodes/KnowledgeNodes.test.ts`
- `packages/core/test/model/GraphProcessor.knowledgeStores.test.ts`
- `packages/core/test/plugins/pinecone/PineconeKnowledgeStore.test.ts`
- Node API, HTTP web-app, and WebSocket tests

When the runtime or browser client changes, run focused tests, package type checks/builds, docs typecheck, repository style checks, and the generated web-app client freshness check.
