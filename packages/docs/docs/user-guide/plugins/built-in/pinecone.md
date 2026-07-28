---
sidebar_label: Pinecone
---

# Pinecone Plugin

The Pinecone plugin supports both the legacy low-level vector integration and provider-neutral [Knowledge Sources](../../knowledge-sources.md).

For a Knowledge Source connection, create a serverless Pinecone index with integrated embedding, then add a named store under **Project Settings → Knowledge stores**. Configure:

- **Index Host**: the HTTPS data-plane host for the index, without an API path.
- **Namespace Template**: must contain `{sourceId}`; each logical source gets an isolated namespace. Rivet expands the placeholder to a readable source slug plus a stable hash, preventing different IDs from colliding after sanitization.
- **Integrated Embedding Text Field**: must match the index field map, commonly `chunk_text`.
- **API Version**: defaults to `2026-04`.
- **Rerank Model**: optional provider-side reranking model.

The connection API key is stored in local Rivet settings, not in the project.
When it is blank, runtime execution can use the plugin's global Pinecone API
key. For a headless host, expose `PINECONE_API_KEY` to the process—for example,
put `PINECONE_API_KEY=...` in a `.env` file that the host loads before running
the graph. Programmatic hosts can instead supply a `knowledgeStores` entry and
own authentication themselves.

Rivet uploads text through Pinecone's integrated-embedding records endpoints. It writes immutable content versions and a reserved manifest record, waits for the manifest to be readable, and searches only the active version. It does not create or delete Pinecone indexes.

Pinecone metadata supports strings, finite numbers, booleans, and arrays of strings. Rivet's portable knowledge metadata contract is broader, so the Pinecone adapter rejects unsupported values such as null or number arrays before upload.
