# Rivet API Reference

The Rivet API Reference is for developers who want to run Rivet projects from code, embed Rivet in another app, build plugins, or use Rivet's runtime packages directly.

If you only want to use the desktop app, start with the [User Guide](/).

To get started with integrating Rivet into your existing TypeScript or JavaScript application, see the [Integration - Getting Started](./api-reference/getting-started-integration.mdx) page.

## Runtime Packages

The public runtime packages are published under the `@valerypopoff` npm scope:

- `@valerypopoff/rivet2-core` contains the graph model, execution engine, built-in nodes, plugin contracts, serialization, and shared runtime APIs.
- `@valerypopoff/rivet2-node` adds Node-specific defaults, filesystem loading, Node native APIs, MCP support, Code-family `require()` support, and remote-debugger helpers.
- `@valerypopoff/trivet` provides programmatic graph test utilities and Trivet test serialization.
- `@valerypopoff/rivet2-cli` runs and serves Rivet graphs from the command line.

## `@valerypopoff/rivet2-core`

Rivet core contains the graph model, processor, built-in nodes, plugin contracts, serialization, and shared runtime APIs. It ships ESM, CJS, and TypeScript declaration outputs.

The Rivet application uses Rivet core to run graphs directly in the application.

See the [Rivet core overview](./api-reference/core/overview.mdx) for more information.

## `@valerypopoff/rivet2-node`

Rivet node is the Node.js runtime adapter for Rivet core. It includes helper APIs to load Rivet projects from the filesystem, execute graphs, attach a remote debugger server, provide Node-native APIs, and supply Node defaults for MCP, project references, plugin environment values, and Code-family `require`.

You will most likely want to use Rivet node in your application. All types from Rivet core are re-exported from Rivet node, so you can use Rivet node as a drop-in replacement for Rivet core.

See the [Rivet node overview](./api-reference/node/overview.mdx) for more information.

## `@valerypopoff/trivet`

Trivet is the graph-oriented test package used by Rivet's Trivet Tests workspace and by programmatic test runners. It provides test-suite/test-case/result types, serialization helpers, `runTrivet(...)`, and graph-runner helpers for validating one Rivet graph with another graph.

See the [Trivet Library](./user-guide/trivet-library.md) page for more information.

## `@valerypopoff/rivet2-cli`

The Rivet CLI is a command-line interface for running Rivet graphs from the command line. It is built on top of Rivet node and provides a convenient way to run graphs from the command line, as well as a local HTTP server for running graphs via HTTP requests.

See the [Rivet CLI overview](./cli.md) for more information.

## Embeddable Source Checkout

Wrapper applications can vendor this repository as a local `rivet/` source folder and import from source-level app seams such as `packages/app/src/host`. This is useful for custom wrappers that need to ship a custom Rivet 2 checkout instead of depending on published npm package versions.

The npm package names describe the runtime package boundaries. A source-vendored wrapper can resolve those package boundaries to its local checkout and built artifacts so the wrapper uses the exact Rivet source tree it ships.

### Requirements

The repository toolchain targets Node.js `22.22.3`. Published runtime packages keep
their own `engines` ranges; use the package range for integrations and the pinned
Node 22 release when developing Rivet itself.
