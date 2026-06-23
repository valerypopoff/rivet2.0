# Plugin System

> Detailed internal reference for plugin contracts and loading behavior across core, app, and sidecar flows.

## Purpose

Rivet plugins extend the system by registering node types and exposing configuration and categorization metadata.

The plugin system spans multiple packages:

- core defines plugin contracts and registry behavior
- the app loads app-installed plugin specs and publishes an editor registry
- the app-executor and node runtime must construct compatible registries for execution

Because of that, plugin work is cross-package by default.

## Core Contracts

The main type definitions live in:

- [`packages/core/src/model/RivetPlugin.ts`](../packages/core/src/model/RivetPlugin.ts)
- [`packages/core/src/model/PluginLoadSpec.ts`](../packages/core/src/model/PluginLoadSpec.ts)
- [`packages/core/src/model/NodeDefinition.ts`](../packages/core/src/model/NodeDefinition.ts)
- [`packages/core/src/model/NodeRegistration.ts`](../packages/core/src/model/NodeRegistration.ts)
- [`packages/core/src/model/NodeImpl.ts`](../packages/core/src/model/NodeImpl.ts)

## `RivetPlugin`

Current `RivetPlugin` shape:

- `id`
- optional `name`
- optional `register(registerFn)`
- optional `configSpec`
- optional `configPage`
- optional `contextMenuGroups`

### What each field does

- `id`: stable plugin identity used in project specs and UI state
- `name`: human-facing display name
- `register(...)`: contributes plugin node definitions to a registry
- `configSpec`: declares plugin-level configuration fields
- `configPage`: controls grouping/description in settings UI
- `contextMenuGroups`: adds node-picker grouping metadata

## Plugin Configuration

Plugin configuration specs are declared through `configSpec`.

### Supported config shape families

Current families are:

- string
- secret
- number-like base spec
- boolean-like base spec

For string/secret values, `pullEnvironmentVariable` can be used to request env-backed defaults.

### Runtime access

At execution time, nodes read config through:

- `context.getPluginConfig(name)`

That helper is populated by `GraphProcessor` using:

- the plugin owning the node type
- runtime settings
- config/env fallback logic from core utilities

### App integration

The app also hydrates some plugin settings from environment variables through Tauri-side helpers when available.

That means config fallback behavior is partly a core concern and partly an app/platform concern.

## Plugin Node Contracts

Plugins provide nodes via `PluginNodeDefinition<T>`.

That definition contains:

- `impl`
- `displayName`

### `PluginNodeImpl`

Plugin node implementations are object-based and currently provide:

- `getInputDefinitions(...)`
- `getOutputDefinitions(...)`
- `process(...)`
- `getEditors(...)`
- `getBody(...)`
- `create()`
- `getUIData(...)`

Unlike built-in nodes, plugin nodes do not subclass `NodeImpl` directly. They are wrapped by the registry into `PluginNodeImplClass`.

Plugin nodes that create input ports from user-authored `{{var}}` interpolation must use the same [`createInterpolationInputDefinition(...)`](../packages/core/src/model/interpolationInputDefinition.ts) helper as built-in nodes. This is the compatibility hook that lets the app recognize interpolation-created ports and preserve existing wires across clear token renames. The helper keeps the visible id/title/data-type behavior unchanged but marks the definition as interpolation-derived for app-side edit reconciliation. Fixed/toggle ports should not carry this marker. The built-in OpenAI `Thread Message` plugin node follows this rule for its text interpolation ports while leaving `fileIds` and `metadata` toggle ports unmarked.

## Registry Behavior

`NodeRegistration` is the bridge between plugin declarations and executable nodes.

### Relevant APIs

- `register(...)`
- `registerPluginNode(...)`
- `registerPlugin(...)`
- `create(...)`
- `createDynamic(...)`
- `createImpl(...)`
- `createDynamicImpl(...)`
- `getPluginFor(...)`
- `getPlugins()`

### Important behavior

- duplicate node types are rejected
- plugin node registration creates a generated wrapper class
- registry stores plugin ownership per node type
- runtime execution later uses that plugin ownership to resolve config for a node

### Why `createDynamicImpl(...)` matters

The app uses `createDynamicImpl(...)` in several places where node types are not fully known at compile time or may come from plugins.

So plugin support is not just "load the node in the picker." It also affects many editor/runtime utility paths.

## Plugin Load Specs

Projects store plugin intent via `PluginLoadSpec`.

Current load-spec families:

- built-in
- uri
- package

### Built-in plugin spec

Contains:

- `type: 'built-in'`
- `id`
- `name`

### URI plugin spec

Contains:

- `type: 'uri'`
- `id`
- `uri`

### Package plugin spec

Contains:

- `type: 'package'`
- `id`
- `package`
- `tag`

### Package plugin installation sidecar

The desktop app installs package plugins with a bundled pnpm sidecar, not with a user-installed global `pnpm`.

Relevant files:

- `packages/app/src/hooks/useLoadPackagePlugin.ts`
- `packages/app/src-tauri/tauri.conf.json`
- `packages/app/sidecars/pnpm/`

The sidecar policy is documented in [`BUILD-AND-CI.md`](./BUILD-AND-CI.md) and in [`packages/app/sidecars/pnpm/README.md`](../packages/app/sidecars/pnpm/README.md). If package-plugin loading changes, keep that sidecar contract and checksum metadata in sync.

## Built-In Plugins

Built-in plugins are exported from core and currently include:

- `anthropic`
- `autoevals`
- `assemblyAi`
- `pinecone`
- `huggingFace`
- `gentrace`
- `openai`
- `google`

Their implementations live under [`packages/core/src/plugins/`](../packages/core/src/plugins/).

These plugins are not "special cased out of band." They still participate via the plugin contract and registry.

## App-Side Plugin Loading

The app's main plugin-loading path is [`useProjectPlugins.ts`](../packages/app/src/hooks/useProjectPlugins.ts).
Plugin availability is app-level, while project YAML plugin specs are derived from actual plugin-node usage.

### Current sequence

1. read persistent app-installed specs from `appPluginSpecsState`
2. seed `pluginsState` with one loading entry per spec
3. start a generation-tracked async load pass so stale completions from an older plugin set cannot overwrite the current UI state or active editor registry
4. call `assembleRegistry(specs, loadPlugin)` from `RegistryAssembly.ts`, which creates a fresh built-in registry and then loads/registers each plugin via a caller-provided loader
5. record per-plugin success/failure in `pluginsState` as results arrive, including the runtime `RivetPlugin` so node types can be mapped back to their app-installed spec
6. ignore the finished result completely if a newer generation has superseded it
7. show aggregate failure toasts for the active generation
8. publish the assembled registry into the app's `projectNodeRegistryState`
9. increment `pluginRefreshCounterState`

### Implications

- plugin availability is rebuilt whenever app plugin specs or retry state changes
- registry state is explicit and app-installed, not project-installed
- editor behavior that depends on node constructors must tolerate registry refreshes
- the app and sidecar share the same `assembleRegistry()` helper, keeping registry construction logic in one place
- built-in plugin lookup stays in `plugins.ts` via `resolveBuiltInPlugin(id)`, while `RegistryAssembly.ts` stays independent of the plugin catalogue to avoid import cycles through plugins that depend on execution APIs
- the app normalizes wrapped default exports for external plugin modules before invoking the initializer, so editor-side loading matches sidecar/runtime behavior for mixed CJS/ESM plugins
- the generation guard is now part of the app-side contract: older async plugin loads must never replace newer plugin state or the active editor registry

### App-installed vs project-used plugins

`appPluginSpecsState` is persisted app state. Adding a plugin from Settings > Plugins writes there, so the plugin's nodes appear in the node picker for every project. Removing a plugin from Settings > Plugins removes that spec from `appPluginSpecsState`; it unregisters the plugin from the app registry, but it does not directly edit any project YAML.

`projectPluginsState` still writes the existing `Project.plugins` YAML field, but users do not manually add or delete entries there. [`pluginUsage.ts`](../packages/app/src/utils/pluginUsage.ts) derives project plugin specs by scanning project graphs, asking the loaded registry which plugin owns each node type, and mapping the runtime plugin id back to the app-installed `PluginLoadSpec`. It also centralizes plugin spec identity, display labels, details, and search matching so Settings > Plugins and the missing-plugin modal describe specs consistently.

Save, run, and remote-upload paths derive project plugin specs before serializing or sending a project. This prevents a newly added plugin node from racing ahead of the background sync hook.

Stale project specs are removed once Rivet can prove they are unused. If every node type in the project is known to the current registry and none belongs to a declared plugin, the derived `Project.plugins` list drops that spec even when the plugin is not installed in this app. Unresolved project specs are preserved only while unknown node types remain, because those nodes may belong to a missing, removed, or failed plugin and Rivet cannot safely prove the plugin is unused yet.

### Missing app plugins

Opening a project whose derived graph usage still requires plugins not present in `appPluginSpecsState` shows [`MissingAppPluginsModal`](../packages/app/src/components/MissingAppPluginsModal.tsx). The modal derives the current project plugin list from graph usage before comparing it to app-installed specs, so stale YAML-only plugin declarations do not show a false install prompt. Missing specs are listed with explicit Install buttons.

Rivet does not install project-declared plugins automatically. If the user closes the modal, unknown plugin nodes continue to render through the normal "Unknown node type ... are you missing a plugin?" fallback.

## URI Plugin Loading

URI plugins are loaded in the app with dynamic import.

Current expectations:

- the module must resolve to a `RivetPluginInitializer`, either directly or through one or two nested `default` wrappers created by CJS/ESM interop
- initializer is invoked with the full core API namespace
- resulting plugin must have an `id`

This path is especially useful for plugin development against a local dev server.

## Package Plugin Loading

Package plugins are primarily a desktop-app capability.

Current flow:

- package spec is resolved by app plugin loading
- installation/loading work is delegated through `useLoadPackagePlugin`
- Tauri/native capabilities are used to fetch registry metadata, download/extract tarballs, manage the installed package directory, and install production dependencies when needed
- the app currently reads the installed main file, converts it to a `data:` import, and normalizes the initializer through the same helper used by URI plugin loading
- reinstall decisions are path- and version-aware: the loader checks local package state, installed dependency presence, the completion marker file, and skips reinstall for git-working-copy plugins

Related runtime assumptions appear in multiple places:

- app plugin loader
- Tauri plugin extraction support
- `app-executor` package-plugin lookup under app data directories

## Sidecar and Runtime Plugin Loading

### App executor

`packages/app-executor/bin/executor.mts` uses `assembleRegistry(specs, loadPlugin)` from core's `RegistryAssembly.ts` to build a fresh registry for each graph run:

- the `assembleRegistry()` call creates a built-in registry and loads each plugin spec via a callback
- built-in plugins are resolved through `resolveBuiltInPlugin(id)` from the core plugin catalogue
- URI and package plugins are dynamically imported through `importPluginInitializer(specifier, pluginId)`, a local helper that normalizes CJS/ESM default-export wrapping
- package plugins are loaded from the already-installed package files in the app-data plugin directory, using `pathToFileURL(mainPath)` so Windows file URLs are constructed correctly
- the assembled registry is passed directly to `createProcessor()` without mutating the global

For package plugins, the sidecar expects installed plugin files under the app-data plugin directory structure.

### Node runtime

`rivet-node` consumers can also pass a custom registry or rely on
built-ins/plugins already present in the registry they use. The default
TypeScript runtime is the only supported Node runtime path; plugin execution is
owned by the assembled registry passed to `GraphProcessor`.

## Plugin Ownership and Config Lookup

One subtle but important runtime detail:

- `GraphProcessor` resolves the plugin owning a node type through `registry.getPluginFor(node.type)`
- it then builds `getPluginConfig(...)` into the `InternalProcessContext`

That means:

- config resolution is based on node type ownership in the registry
- incorrect registry registration can break execution-time config lookup even if the node renders fine

## Current Refactor Seams

Meaningful plugin-system seams:

- core contracts in `RivetPlugin.ts`
- `NodeRegistration` and its generated plugin wrappers
- app plugin loading in `useProjectPlugins`
- project plugin derivation in `pluginUsage.ts`
- missing app-plugin prompt in `MissingAppPluginsModal`
- package-plugin installation/loading paths
- sidecar runtime plugin loading in `app-executor`
- plugin config resolution in `GraphProcessor`

## Known Architectural Tensions

Visible in current code:

- plugin loading publishes shared registry state in the app
- package plugin installation/loading spans frontend, Tauri, and sidecar behavior
- plugin config resolution depends on registry ownership and runtime settings being kept aligned
- built-in plugins and external plugins share most plumbing but not always the same loading path

## Practical Refactor Guidance

- Treat plugin changes as cross-package work by default.
- Keep plugin contracts, registry behavior, app loading, and sidecar loading in sync.
- Be careful changing plugin IDs or node type IDs; those are persistence/runtime identifiers.
- Preserve the distinction between app-installed availability, project-used YAML specs, node registration, plugin metadata, and plugin configuration resolution.
- Test both editor-side availability and runtime execution when touching plugin code paths.
