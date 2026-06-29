---
id: serve-app
sidebar_label: serve-app
---

# Rivet CLI - `serve-app` Command

Serve a project-contained Rivet web app from a `.rivet-project` file.

## Quick Start

```bash
# Serve the only web app in a project
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project

# Serve a specific web app by name or ID
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project "Support assistant"

# Mount under a base path
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project --base-path /apps/support

# Bind to localhost only
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project --host 127.0.0.1

# Reread the project on each request while editing
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project --dev
```

## Description

Rivet web apps are declarative UI screens saved inside a Rivet project. `serve-app` serves the same renderer used by the Node package web-app handler and runs button actions through the ordinary Node runtime.

The command is a small local/reference host. It is useful for trying a web app from the command line, creating simple deployments, or checking how a wrapper server should adapt the Node web-app APIs.

Use [`rivet doctor`](./doctor.md) first when you want a quick sanity check of the project, and see [CLI recipes](./recipes.md) for copy-paste serving examples.

## Routes

By default, the command serves:

```text
GET  /
GET  /app.json
POST /actions/run
GET  /healthz
```

If `--base-path /apps/support` is used, the web app routes move under that base path:

```text
GET  /apps/support/
GET  /apps/support/app.json
POST /apps/support/actions/run
```

`/healthz` stays at the server root.

## Web App Selection

If the project has exactly one web app, the `uiGraph` positional argument can be omitted.

If the project has several web apps, pass the web app name or ID:

```bash
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project "Customer intake"
```

## Project References and Datasets

`serve-app` passes the resolved `.rivet-project` path to the Node runtime, so graph actions can resolve project references relative to that file.

The command also loads the adjacent `.rivet-data` file when one exists. Dataset mutations are kept in memory unless `--save-datasets` is passed.

```bash
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project --dataset-file ./prod.rivet-data --save-datasets
```

In `--dev` mode, the project and dataset provider are recreated for each web-app request so edits to the UI graph, target graph, and adjacent data file are picked up without restarting the server. Without `--dev`, the project and dataset provider are loaded once when the server starts.

## Options

### Server Configuration

- `--port <port>`: The port to run the server on. Default is 3000.
- `--host <host>`: The host interface to bind to. Default is `0.0.0.0`, which is suitable for Docker and remote access. Use `127.0.0.1` for local-only serving.
- `--dev`: Rereads the project file and recreates the dataset provider on each request. Useful while editing the project.
- `--base-path <path>`: The base URL path where the web app routes are mounted. Default is `/`. `/healthz` is reserved for the CLI health endpoint.
- `--revision-key <key>`: Embeds an opaque revision key in the page and rejects action requests that send a different key with `409` and `code: "revision_mismatch"`.
- `--bearer-token <token>`: Requires `Authorization: Bearer <token>` on web app requests. If omitted, `RIVET_CLI_BEARER_TOKEN` is used when set.
- `--cors-origin <origin>`: Adds CORS headers for an allowed origin. Can be repeated. Use `*` to allow any origin.

### Dataset Configuration

- `--dataset-file`: Use a specific `.rivet-data` file instead of the adjacent project data file.
- `--save-datasets`: Persist dataset mutations back to the dataset file.
- `--require-dataset-file`: Fail if the dataset file does not exist.

### Provider Configuration

- `--openai-api-key`: The OpenAI API key to use for OpenAI-backed graph actions. If omitted, Node execution falls back to `OPENAI_API_KEY` where supported.
- `--openai-endpoint`: Endpoint override for legacy OpenAI-compatible Chat behavior. If omitted, Node execution falls back to `OPENAI_ENDPOINT` where supported.
- `--openai-organization`: OpenAI organization ID. If omitted, Node execution falls back to the environment where supported.

For LLM Chat, the node's API key source controls where the key comes from. If a graph action connects the LLM Chat API Key input port, send that key through the web-app data mapping instead of relying on these CLI OpenAI options.

## Auth Caveat

`--bearer-token` protects every web-app route except `GET /healthz`, including the HTML page. This is useful for API clients and reverse-proxy tests, but normal browser navigation cannot attach an `Authorization` header to the initial page load by itself. For browser-facing deployments, prefer a reverse proxy, cookie-based auth, or a wrapper server that owns authentication before delegating to Rivet's web-app handler.

## Wrapper Servers

Production wrapper servers usually should not shell out to the CLI. They should use the Node package web-app APIs directly:

- `createRivetWebAppHandler(...)`
- `renderRivetWebAppHtml(...)`
- `runRivetWebAppAction(...)`

Those APIs let wrappers own authentication, endpoint slugs, published revision resolution, recordings, telemetry, and deployment policy while Rivet owns the declarative renderer and UI-action protocol.
