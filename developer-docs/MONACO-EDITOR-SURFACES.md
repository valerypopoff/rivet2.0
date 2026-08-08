# Monaco And Editor Surfaces

Canonical ownership guide for Rivet's editable and read-only Monaco instances.

## Low-Level Editor

[`components/CodeEditor.tsx`](../packages/app/src/components/CodeEditor.tsx) owns the
Monaco instance, model attachment, view-state persistence, display options, and
disposal. It must not import node editors, app state, or product components.

[`editorCapabilityModel.ts`](../packages/app/src/utils/monaco/editorCapabilityModel.ts)
purely resolves enabled features. [`editorCapabilities.ts`](../packages/app/src/utils/monaco/editorCapabilities.ts)
installs them and returns disposables. Every command/provider/listener/widget added
to an editor must be owned by one `EditorDisposableStore` and removed on model or
editor teardown.

## Node Settings Wrapper

[`editors/CodeEditor.tsx`](../packages/app/src/components/editors/CodeEditor.tsx)
owns node/project model keys, node-specific validation, footer actions/stats/font
controls, AI-assist entry, and app theme selection. Product behavior belongs here,
not in the low-level editor. Compact, non-resizable node fields must provide an
explicit `height` in their core editor definition; the app resolves that value to
a fixed viewport height instead of letting the node-settings flex layout stretch
it. Fields without an explicit height use the 500px fallback. JSONPath node
settings editors are resizable alongside JavaScript and JSON editors.

Model/view state is session-only and project-scoped. Folding state survives panel
close/reopen while the project remains open, but is never written to project YAML.
Fullscreen output font size has a separate persisted app preference from editable
node-editor font size.

## JSON String Preview

Range scanning is tolerant and per-literal; unrelated invalid JSON or interpolation
must not suppress eligible strings. Geometry, Monaco conversion, interaction state,
views, and styles live under `renderDataValue/jsonStringPreview/`.

The button anchors to the end of the eligible literal. Popovers use viewport-space
geometry and a portal; never mix Monaco content coordinates with a portal's viewport
coordinates. Before an editable node-settings replacement, revalidate the current
literal against the model so a stale range cannot overwrite later edits. Fullscreen
output remains read-only.

## Language Services And Commands

- Markdown folding, JSON-schema `required` definitions, interpolation diagnostics,
  JSON-template validation, spellcheck, and text tools are Monaco capabilities.
- Monaco's built-in **Disable Ambiguous Highlight** banner action is rebound by
  [`unicodeHighlighting.ts`](../packages/app/src/utils/monaco/unicodeHighlighting.ts).
  Monaco standalone updates a shared configuration service that already-created
  editors do not observe, so Rivet applies the setting directly to every current
  Monaco editor and to later editors in the same app session. It deliberately
  keeps Monaco's command id and is session-only, matching Monaco standalone's
  in-memory configuration behavior.
- Spellcheck is on-demand and local. CSpell dictionaries are loaded lazily.
- Escape is consumed by the nearest closable editor surface before the node panel.
- Format commands delegate to Monaco; JSON escape/unescape use native JSON APIs.

## Architecture Enforcement

`check-editor-boundaries.mjs` rejects low-level Monaco imports from app state,
hooks, components, or node editors. Pure scanner/geometry/reducer/model tests are the
default. Add browser tests only for browser-owned focus, portal, resize, or drag
behavior.
