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
```

## Description

Rivet web apps are declarative UI screens saved inside a Rivet project. `serve-app` serves the same renderer used by the Node package web-app handler and runs button actions through the ordinary Node runtime.

The command is a small local/reference host. It is useful for trying a web app from the command line, creating simple deployments, or checking how a wrapper server should adapt the Node web-app APIs.

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

## Options

### Server Configuration

- `--port <port>`: The port to run the server on. Default is 3000.
- `--host <host>`: The host interface to bind to. Default is `0.0.0.0`, which is suitable for Docker and remote access. Use `127.0.0.1` for local-only serving.
- `--base-path <path>`: The base URL path where the web app routes are mounted. Default is `/`. `/healthz` is reserved for the CLI health endpoint.
- `--revision-key <key>`: Embeds an opaque revision key in the page and rejects action requests that send a different key.
- `--bearer-token <token>`: Requires `Authorization: Bearer <token>` on web app requests. If omitted, `RIVET_CLI_BEARER_TOKEN` is used when set.
- `--cors-origin <origin>`: Adds CORS headers for an allowed origin. Can be repeated. Use `*` to allow any origin.

### Dataset Configuration

- `--dataset-file`: Use a specific `.rivet-data` file instead of the adjacent project data file.
- `--save-datasets`: Persist dataset mutations back to the dataset file.
- `--require-dataset-file`: Fail if the dataset file does not exist.

## Wrapper Servers

Production wrapper servers usually should not shell out to the CLI. They should use the Node package web-app APIs directly:

- `createRivetWebAppHandler(...)`
- `renderRivetWebAppHtml(...)`
- `runRivetWebAppAction(...)`

Those APIs let wrappers own authentication, endpoint slugs, published revision resolution, recordings, telemetry, and deployment policy while Rivet owns the declarative renderer and UI-action protocol.
