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
owns fully scoped model keys, node-specific validation, footer actions/stats/font
controls, AI-assist entry, and app theme selection. Product behavior belongs here,
not in the low-level editor. Compact, non-resizable node fields must provide an
explicit `height` in their core editor definition; the app resolves that value to
a fixed viewport height instead of letting the node-settings flex layout stretch
it. Fields without an explicit height use the 500px fallback. JSONPath node
settings editors are resizable alongside JavaScript and JSON editors.

### Node settings ownership

Duplicated projects can reuse graph and node IDs. `NodeEditor` therefore keys its
panel by project, graph, node, type and workspace replacement lifetime, not by
node ID alone. [`NodeEditorSessionContext.tsx`](../packages/app/src/components/nodeEditor/NodeEditorSessionContext.tsx)
checks live selection, open-tab membership, node existence, editability,
variant/library scope and workspace revision. Library-source editing has its own
authority and includes the exact prefab ID, not just the source node's ID.

[`nodeEditorSession.ts`](../packages/app/src/utils/nodeEditorSession.ts) gives
each owner an irreversible lifetime token. A → B → A retires the old token even
when React batches the round trip. A renewed session for A must not make A's old
callbacks writable again. Session-bound mutation and close callbacks capture that
lifetime; a latest-callback ref must not lend them a replacement token.

Code, ordinary node-string fields, title and description update canonical data
synchronously. Debounce expensive validation/preview work, not the authoritative
text that Save, switching, Undo and recovery capture. A node edit applies its field
diff against the latest owning node, using the callback's captured render baseline
or an explicitly supplied live baseline. It must not replay an old full-node
snapshot over newer sibling settings. Metadata blur/confirmation never replays a
separate buffer; Escape restores the pre-edit value, including an absent field.
Project-scoped command history merges typing edits without sharing Undo between
clones; library updates use the atomic `updateNodeLibraryState` owner.

That library transaction reads the latest project, references and live active
graph overlay, then publishes sources, reconciled instances and recoverable wires
together. It does not reconcile the active graph from its stale saved snapshot
first. Consecutive source/visual edits preserve newer sibling fields; usage checks
read live sources, and rejected mutations cannot attach payloads or change selection.

AI generation, editor-definition loading, spellcheck and Subgraph reference/preview
requests check their session and request generation before publishing. AI also
checks the intervening node-data revision. Cancellation releases its UI immediately
even if a provider ignores abort; late results cannot write, notify success or clear
a newer request's busy state. Subgraph guards cover referenced-project writes as
well as node edits. Spellcheck checks the mounted editor identity; an obsolete
completion must not remove newer markers. Ordinary autofocus remains enabled.

### Buffers and models

Warm model/view state is session-only and fully owner-scoped. Model keys include
project, graph, node, field, language, variant/library context and authoritative
content generation. An owner change initializes from that owner's source before
attaching Monaco. A same-ID authoritative reload uses a fresh generation; a
read-only variant never reuses the editable buffer.

[`codeEditorModelCache.ts`](../packages/app/src/utils/monaco/codeEditorModelCache.ts) retains at
most 12 unattached warm models. Attached models have leases and cannot be evicted
by cache pressure. Same-owner invalid JSON drafts can retain cursor/undo/error
state in this cache without becoming valid canonical node data. This is not a
durable recovery guarantee: reload or eviction can discard an invalid draft.
Source acknowledgements are separate from visible draft text; authoritative
Undo/Redo or replacement synchronizes even while focused without emitting a false
user edit. Mount, model synchronization and unmount never submit a stale buffer.

Folding state survives a warm panel close/reopen but is never written to project YAML.
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
hooks, components, or node editors. Pure scanner/geometry/reducer/model tests and
session-context component tests cover ownership and stale callbacks. Real Monaco,
focus, autofocus, rapid tab switching, model reuse and iframe event delivery need
browser checks. `node-editor-ownership.spec.ts` and `node-editor-lifecycle.spec.ts`
exercise cloned projects, immediate switch/Save/close, focused Undo/Redo, reload,
read-only variants and delayed AI. See
[the regression commands](./studio-server/development.md#node-settings-ownership-regressions).
