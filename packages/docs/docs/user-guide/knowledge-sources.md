---
title: Knowledge Sources
---

# Knowledge Sources

Rivet's Knowledge Source API lets a workflow synchronize and search long-lived text without being tied to one vector-database provider. Graphs work with typed sources, documents, and evidence; a project plugin or programmatic host supplies the actual store.

## Configure Named Stores

Open **Project Settings → Knowledge stores** and add a named connection. A project can contain several connections—for example, one production corpus, one private customer corpus, and one experimental provider. Knowledge Source nodes select a connection by stable ID rather than relying on a single project-wide database.

Provider-specific non-secret settings are saved in the project. Credentials remain in local Rivet settings. A deployed Node host can replace either with a request-scoped store implementation.

Connection IDs are trimmed, portable record keys. Rivet rejects the reserved JavaScript object keys `__proto__`, `prototype`, and `constructor` rather than allowing a project file whose settings behave differently across hosts.

The editor supports adding, editing, duplicating, testing, and removing connections. Duplicates intentionally do not copy credentials. A connection also keeps its provider plugin attached to the project even though the Knowledge nodes themselves are provider-neutral.

## Typical Workflow

1. Create one Knowledge Document per source document or chapter and collect them with an Array node.
2. Create a Knowledge Source with the named connection and your stable logical source ID.
3. Send the complete current document collection to Sync Knowledge Source.
4. Use Get Knowledge Source Status when control flow needs to distinguish a ready source from a source that must be synchronized.
5. Send one or several natural-language queries to Search Knowledge.
6. Pass the evidence through Build Knowledge Context before inserting it into an LLM prompt.

Sync is content-addressed and idempotent. Repeating identical content does not re-upload it. A changed source is uploaded as a new immutable version and becomes active only after all writes succeed.

Document IDs must be unique within a synchronized source. Rivet checks this before uploading, preventing two documents from producing colliding chunk records.

## Missing Sources and Versions

Missing knowledge is application state, not an exception. Status returns `Exists: false`, and Search returns `Source Found: false`, empty evidence, and a useful message. This makes it straightforward for an agent tool to say that initialization is needed without failing its graph.

Leaving a Knowledge Source version blank always resolves the durable active manifest. Pinning a version gives reproducible behavior. Rivet will not silently substitute the active version when the pinned version is absent.

## Multi-query Retrieval

Search Knowledge accepts a string array. Use this for complementary formulations, names and aliases, or semantic and literal forms. Empty and duplicate query strings are removed, the remaining queries run concurrently, and the final evidence is deduplicated and fused in a deterministic order. The per-query groups remain available for debugging. Exact-version searches reject results from a substituted version, and final evidence must originate in those query groups. If one provider request fails, unfinished sibling requests are cancelled before the search fails.

Metadata filters are provider-neutral. A provider reports unsupported operators before making a request. The same applies to required reranking.

## Programmatic Stores

Core and Node execution APIs accept a `knowledgeStores` registry:

```ts
import type { RivetKnowledgeStoreRegistry } from '@valerypopoff/rivet2-node';
import { runGraph } from '@valerypopoff/rivet2-node';

const knowledgeStores: RivetKnowledgeStoreRegistry = {
  privateCorpus: myAuthenticatedStore,
};

await runGraph(project, { knowledgeStores });
```

`createProcessor`, `runRivetWebAppAction`, web-app handlers, and WebSocket sessions accept the same option. For authenticated or multi-tenant web apps, return a request-scoped registry from `createProcessorOptions(context)`. A request-scoped registry overrides a static handler registry, and a host store overrides project provider configuration with the same connection ID.

Provider implementations own durable storage, cross-request concurrency, authorization, tenant isolation, billing, and retention. Rivet owns graph-level contracts, version activation, portable filtering, cancellation, and normalized evidence.

Managed providers serialize updates to the same source across their store instances inside one Rivet runtime when the provider supplies a coordination scope. Deployments with several server processes must still coordinate concurrent writers in their backend or request-routing layer.

## Pinecone

Enable the Pinecone plugin and configure an integrated-embedding index host. Rivet uses one collision-resistant namespace per source, uploads text through Pinecone's records API, stores a small committed manifest record with a unique activation ID, searches only the active version, and waits for that exact committed manifest to become readable before reporting success. Malformed successful Pinecone responses—including malformed returned metadata—fail explicitly instead of appearing as a missing source, an empty search, or silently omitted fields.

The Pinecone adapter does not create or delete indexes. It expects a serverless index whose integrated embedding field matches the configured Text Field. Pinecone accepts strings, finite numbers, booleans, and string arrays as metadata; the adapter reports unsupported portable metadata values before upload.

## Related Nodes

- [Knowledge Source](../node-reference/knowledge-source.mdx)
- [Knowledge Document](../node-reference/knowledge-document.mdx)
- [Sync Knowledge Source](../node-reference/sync-knowledge-source.mdx)
- [Get Knowledge Source Status](../node-reference/get-knowledge-source-status.mdx)
- [Search Knowledge](../node-reference/search-knowledge.mdx)
- [Build Knowledge Context](../node-reference/build-knowledge-context.mdx)
