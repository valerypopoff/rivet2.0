# Transactional Graph Builder Domain

The transactional Graph Builder is a host-owned editing session around a
private, revisioned virtual graph workspace. The model sees full-fidelity,
data-only YAML projections of Rivet `NodeGraph` values and proposes exact
unified diffs or, when a diff would be unusually fragile, one bounded complete
document replacement. It never receives the live editor project, a filesystem
handle, or a commit capability.

The primary implementation lives in:

- [`src/domain/graphBuilder`](../packages/app/src/domain/graphBuilder) for
  model-free schemas, limits, canonical values, deltas, diagnostics, and
  validation contracts;
- [`virtualGraphWorkspace.ts`](../packages/app/src/features/graphBuilder/virtualGraphWorkspace.ts)
  for virtual documents, exact diff application, secret preservation, draft
  revisions, and project-wide deltas;
- [`sessionController.ts`](../packages/app/src/features/graphBuilder/sessionController.ts)
  for the bounded policy loop and lifecycle;
- [`readExecutor.ts`](../packages/app/src/features/graphBuilder/readExecutor.ts)
  for revision-correlated reads and node templates;
- [`authoringCatalog.ts`](../packages/app/src/features/graphBuilder/authoringCatalog.ts)
  and
  [`authoringSemantics.ts`](../packages/app/src/features/graphBuilder/authoringSemantics.ts)
  for registry-aware construction and candidate validation;
- [`editorGateway.ts`](../packages/app/src/features/graphBuilder/editorGateway.ts)
  for the final compare-and-swap publication and history command.

## Ownership boundary

The model may choose only one typed decision per policy turn:

- `request-context`
- `apply-patch`
- `replace-document`
- `ready`
- `no-change`
- `clarify`
- `cannot-complete`

The normal mutation decision is:

```ts
{
  type: 'apply-patch';
  baseRevision: number;
  unifiedDiff: string;
  summary?: string;
}
```

The bounded fallback is:

```ts
{
  type: 'replace-document';
  baseRevision: number;
  path: string;
  content: string;
  summary?: string;
}
```

The older `GraphPatch` operation contracts remain exported for the hardened
legacy rollback implementation and internal compatibility tests. They are not
the model-facing authoring language for the transactional implementation.
The same separation applies to reads:
`graphBuilderTransactionalDecisionSchema` and
`parseGraphBuilderTransactionalDecision(...)` accept only the five reads
listed below, while the broader `graphBuilderDecisionSchema` remains available
to legacy/internal consumers that still use `get-node-specs`,
`inspect-draft`, or `inspect-draft-diff`. The policy runner must always use the
transactional parser so the checked prompt and accepted model output cannot
drift apart.

Host code owns:

- the base project snapshot and identity;
- the canonical virtual-document text;
- graph and node IDs already present in that text;
- per-session draft and document revisions;
- secret values represented by placeholders;
- node templates derived from the live registry;
- parsing, normalization, validation, and diagnostics;
- preview construction, Apply eligibility, commit idempotency, undo, and redo.

The model owns only the requested edits expressed against a document revision
it has read. Model prose never controls deltas, validation, or publication.

## Virtual graph workspace

[`VirtualGraphWorkspace`](../packages/app/src/features/graphBuilder/virtualGraphWorkspace.ts)
creates one editable document for every existing graph in the captured
authoring project:

```text
graphs/<percent-encoded-graph-id>.yaml
```

Each document is a deterministic YAML envelope:

```yaml
version: 1
graph:
  metadata: ...
  nodes: ...
  connections: ...
```

The `graph` value is the complete portable `NodeGraph`, including node data,
visual data, metadata, connections, and graph fields that the host does not
otherwise interpret. It is deliberately NodeGraph-shaped rather than a
hand-maintained settings projection. Code, prompts, schemas, and plugin-owned
portable node fields therefore survive a read/edit/parse cycle without needing
an adapter for every field.

This YAML is an in-memory authoring representation. It is not the
`.rivet-project` serialization format, is never written directly to disk, and
does not grant access to project metadata, project data, UI graphs, plugins,
referenced projects, or other files.

Document paths are normalized relative paths. Absolute paths, backslashes,
empty segments, `.` / `..` traversal, unknown documents, and graph-ID changes
are rejected. The current scope edits existing graph documents; it does not
create or delete graph files or mutate project-level resources.

### Active document and bounded reads

Every policy turn includes:

- the current draft revision;
- an index of editable graph documents with path, graph ID, display name,
  digest, UTF-16 length, and line count;
- the beginning of the active graph document, up to the active-document line
  and byte limits;
- the cumulative project delta and current diagnostics.

If the active document is larger than the inline window, or another graph is
needed, the model uses `read-virtual-document` with an exact path and a 1-based
line window. If a byte bound ends inside one unusually long logical line, the
result returns `nextOffset`; the next request uses that value as `startOffset`
instead of line fields. Reads are bounded and return the observed draft
revision, document digest, UTF-16 offsets/length, line counts, and truncation
state. A model must read missing or stale text rather than guess it.

Each canonical document caches its line-start offsets when the workspace
builds or rebuilds that document. Line-window reads index that cache directly,
and `startOffset` cursor reads use a binary search over the same offsets rather
than rescanning the full YAML string on every continuation.

The current implementation bounds an internal graph document at 4 MiB, one
read at 2,000 lines and 12 KiB, and the inline active document at 2,000 lines
and 64 KiB. These are safety limits, not a claim that every large graph can be
edited in one policy turn.

## Secret preservation

Before a graph becomes model-visible, non-empty fields classified as
secret-like are replaced by stable host-owned objects:

```yaml
apiKey:
  $graphBuilderSecret: host-secret:<stable-digest>
```

The original value remains only in session memory. A patch must leave each
surviving placeholder unchanged at its exact semantic location. Introducing a
new secret-like value, changing a placeholder, moving it, or removing it while
its owner survives rejects the whole patch. Deleting the owning node is
allowed. After parsing, the host restores preserved values before candidate
validation.

The classifier deliberately excludes null and empty values. Its string-valued
lookup-policy exemptions are an exact reviewed allowlist:
`apiKeyEnvVarName`, `apiKeyProgrammaticName`, `apiKeySource`,
`customProviderApiKeyEnvVarName`, and
`customProviderApiKeyProgrammaticName` after key normalization. It does not
exempt arbitrary fields merely because their names end in `Source` or
`EnvVarName`. Boolean `use...Input` policy switches remain model-editable.
Once another field name is classified as secret-like, a non-empty number or
boolean is protected just like a string or object. This is a defense-in-depth
heuristic, not a universal secret-discovery system. New node families that
store credentials under unusual field names should provide a reviewed
classification seam before Graph Builder authoring is enabled for them.

Secret placeholders protect stored project fields. They cannot protect a
secret that the user pastes into the natural-language request, and they do not
replace transport-level credential isolation in
[`policyRunner.ts`](../packages/app/src/features/graphBuilder/policyRunner.ts).

## Exact document-edit protocol

### Unified diff

An `apply-patch` decision contains one standard unified diff for one known
virtual document. Headers identify the same normalized path:

```diff
--- a/graphs/example.yaml
+++ b/graphs/example.yaml
@@ -10,3 +10,3 @@
 ...
```

The host requires:

- the exact current `baseRevision`;
- one file header pair and one or more non-empty hunks;
- exact hunk line counts;
- exact context at the declared offsets;
- no fuzzy matching, timestamps, absolute paths, traversal, or extra files;
- a bounded diff body.

[`graphBuilderUnifiedDiff.ts`](../packages/app/src/domain/graphBuilder/graphBuilderUnifiedDiff.ts)
owns this syntax contract. Both the transactional decision schema and
`VirtualGraphWorkspace` call the same parser, so a diff cannot pass the
model-facing schema and then fail because the workspace recognizes a different
header, integer, line-ending, or no-newline-marker dialect. Applying a parsed
diff still performs the separate exact-context check against the current
revision.

Each policy decision changes one graph document. A complex session may submit
several accepted diffs, including diffs for different graphs. This keeps
individual repair diagnostics precise while the workspace still produces one
cumulative, project-wide preview and one final atomic Apply.

### Complete-document fallback

`replace-document` carries the normalized path and complete canonical YAML
content for one known graph document. The policy may use it only after reading
the entire current document and only when an exact diff would be larger or
more error-prone than returning the file. It must not construct a replacement
from truncated context.

The controller enforces that rule with a private current-revision coverage
ledger keyed by normalized path, document digest, and total UTF-16 length. The
active inline window and every successful `read-virtual-document` body that
was actually retained for delivery to the model add exact offset intervals.
Coverage can accumulate over several policy turns and survives transcript
compaction because the ledger is independent of transcript bodies. Compacted
read summaries neither add nor remove authority.

When a draft edit advances the revision, coverage is cleared and rebuilt
against the new path/digest/length descriptors. Failed reads and full bodies
that the turn-size fitter replaced with budget-error results never count. A
replacement is authorized only when the current ledger contains one
gap-free `[0, totalLength)` interval for its exact path and digest.

Replacement is not a weaker trust path. It uses the same revision check,
strict YAML and graph parsing, secret-placeholder restoration, normalization,
validation, delta, replay, review, preview, and Apply gates as a unified diff.
The model-facing decision size remains bounded even though the private
workspace can retain a larger internal document.

Patch IDs are host-created and idempotent. Reusing the same ID and exact
revision/edit returns the recorded result. Reusing an ID with different
content or a different edit kind fails closed.

## Patch transaction

For a fresh diff or replacement, the virtual workspace:

1. verifies the expected draft revision;
2. applies the exact diff or accepts the complete replacement text;
3. parses one strict YAML 1.2, data-only document with aliases disabled;
4. verifies the document envelope and complete `NodeGraph` shape;
5. restores host-owned secret values;
6. replaces only the targeted graph in a cloned private project;
7. invokes deterministic candidate normalization;
8. calculates the attempted project delta;
9. validates every graph changed by the candidate or normalizer against the
   live registry and complete project context;
10. promotes the candidate and rebuilds all canonical documents only if
    validation is complete and non-blocking.

The structural gate validates the complete standard `ChartNode` envelope
before semantic code receives it. Required identity, title, data, and visual
position fields must have their runtime types; optional execution flags,
split-run limits, visual width/color/z-index, variants, and prompt-designer
tests are validated when present. Split limits must be positive safe integers,
visual numbers must be finite and safely bounded, and variant/test-group IDs
must be unique inside their owning node. Node-specific `data` remains the
registry-aware validator's responsibility.

An applied edit advances the draft revision exactly once. A no-op or rejected
edit does not advance it. Parse failures, stale revisions, context mismatches,
secret-placeholder violations, invalid ports, unsupported node types, invalid
async topology, boundary violations, and incomplete validation are returned as
bounded, host-authored diagnostics. No partial candidate is retained.

For persisted graphs, existing Graph Input/Output node identities and data
types remain immutable, while new boundary nodes may be added. This supports
requests that extend a graph without silently invalidating existing callers.
Only a captured transient canvas has a fully mutable boundary while its initial
interface is being authored. The current normalizer does not perform hidden
cross-graph boundary propagation.

## Registry-aware templates and validation

Direct YAML authoring removes the need to expose every node setting through a
custom operation schema, but it does not permit the model to invent node
shapes.

The model can use:

- `search-node-types` for canonical authoring choices;
- `get-node-templates` for complete host-created node objects and their
  current port/specification context;
- `get-diagnostics` for current blocking and advisory findings;
- `list-project-resources` for bounded, non-secret resource metadata;
- `read-virtual-document` for exact graph text.

Document reads normally use `startLine`/`lineCount`. When a returned window
ends in the middle of one unusually large logical line, its exact
`nextOffset` cursor can be supplied as `startOffset` on the next read;
offset and line-window fields are mutually exclusive.

Templates are constructed through the same captured authoring catalog and live
node registry as the editor. The model copies a complete template into a
document, assigns a graph-local unique ID, and changes only task-required
portable fields. Existing plugin nodes are visible in full-fidelity documents,
but creating a node still requires a registry-backed template. Unknown,
unregistered, or unsafe node choices fail validation.

Candidate validation uses the complete private project, effective prefab nodes,
referenced-project context, dynamic port definitions, connection coercion
rules, compiled Data Bus topology, conditional inputs, async-branch
restrictions, loop/tool semantics, and graph boundary rules. In particular,
Data Bus relay cycles and effective-provider conflicts are rejected before a
draft can be accepted, rather than being deferred to execution. The YAML parser
is only a structural gate; it is never a substitute for Rivet semantic
validation.

Direct document editing uses the same Code and Expression data shape as the
editor. The active executor, rather than node-level permissions, determines
which JavaScript APIs exist at runtime; Graph Builder can therefore create,
clone, and update Code source normally.

Delegate Tool Call keeps the same candidate-level invariants when authored
through YAML as when configured through its editor adapter. New or reconfigured
delegates must use Auto Delegate mode, fallback and passthrough settings must
be booleans, and passthrough errors require external-call fallback. The checks
also cover variant data so a later variant selection cannot bypass the
authoring boundary.

## Session lifecycle and review

[`GraphBuilderSessionController`](../packages/app/src/features/graphBuilder/sessionController.ts)
serializes policy decisions against one private workspace. The normal path is:

```text
created
  -> gathering-context / editing
  -> apply-patch / replace-document
  -> reviewing
  -> ready-for-preview
  -> committing
  -> committed
```

After every accepted document edit, the controller schedules another policy turn in
`reviewing`. The model must compare the complete accepted draft with every
requirement in the original request. It may read more context or submit another
edit. A mutation decision is nonterminal; only a later `ready` decision can
request preview.

This review gate prevents a coherent first stage of a multi-stage request from
being presented as the completed rebuild. A `ready` summary is presentation
text only; the host derives the actual changed-graph and node/connection counts.

Reads, decisions, and patch results are correlated with session, turn,
request-index, and observed-revision values. Policy responses are parsed as one
exact JSON object through the local schema. Invalid envelopes, provider
failures, rejected edits, and stale reads consume bounded repair/attempt
budgets rather than starting unbounded retries.

The controller also owns wall-clock, inactivity, transcript, turn-size, token,
cost, and clarification limits. Cancellation aborts in-flight work and prevents
late results from mutating the draft. Once synchronous publication begins,
commit outcome wins over a later cancel request.

The default active-work limits are 32 provider attempts, four consecutive
repair failures, 15 minutes of wall-clock work, and four minutes without
provider/read activity. Streaming partial output refreshes only the inactivity
timer; it never extends the wall-clock deadline. An applied edit resets the
consecutive repair streak while total repair attempts remain in metrics. The
read bodies retained by turn-size fitting are sent once through
`contextResults` on the immediately following provider call and are omitted
from that call's transcript copy to avoid duplication. After the immediate
slot is cleared, current-revision read bodies may return to transcript history
for follow-up work. As soon as an accepted edit advances the revision, older
read bodies are represented only by compact digest records; this avoids paying
for stale graph text during mandatory review and does not affect the separate
coverage ledger.

## Preview, Apply, and history

The preview is a cumulative base-to-draft
`GraphBuilderProjectDraftDelta`. It groups exact, bounded graph deltas and
host-authored diagnostics for every changed graph. The draft itself remains
private; React receives display data, not a mutable project reference.

Active-work timers stop after a validated preview is ready. Review is
user-paced and does not expire the private preview; Apply still rechecks the
captured live editor identity and all commit gates.

Apply:

1. revalidates every changed graph against the complete draft context;
2. rechecks the captured project/editor/plugin/reference/policy identity;
3. verifies that the prepared canonical content has not changed;
4. publishes every changed graph through one editor command;
5. records one undoable history action;
6. preserves editor-only active-graph state and related-graph snapshots needed
   for undo/redo.

If identity or eligibility changed, Apply fails without publishing anything
and retains the private preview for inspection. A repeated commit ID with the
same canonical content replays the recorded outcome; a different payload under
the same ID is a protocol error.

Discard, cancel, failure, expiration, and closing a confirmed nonterminal
session publish nothing. The Graph Builder never writes a project file
directly. Normal editor save/autosave behavior remains the only persistence
path after a successful Apply.

## Policy runtime and trust boundary

The checked
[`graph-builder-policy.rivet-project`](../packages/app/graphs/graph-builder-policy.rivet-project)
contains the minimal LLM policy call. The host currently uses the conservative
exact-JSON text variant for every provider, then validates the result with
`graphBuilderTransactionalDecisionSchema`. A checked parity test keeps the
decision and read discriminants printed in `policyPrompt.ts` identical to
those accepted by this model-facing schema. The policy graph has no tools, native API,
plugins, external calls, datasets, code runner, Stored Value store, Knowledge
Store registry, project references, editor cache, or commit callback.

The policy turn contains model-visible graph content. Every embedded string,
including node code, prompt text, plugin descriptions, retrieved documents,
and prior model text, is untrusted data and cannot override the system
protocol. Credentials are resolved only by the policy runner's narrow settings
adapter and never enter the policy turn, transcript, or graph output.

## Legacy rollback

[`legacyDraftRunner.ts`](../packages/app/src/features/graphBuilder/legacyDraftRunner.ts)
and the bundled
[`graph-creator.rivet-project`](../packages/app/graphs/graph-creator.rivet-project)
remain a separately selectable rollback implementation during rollout. They
also edit a private authoring-project draft and share the final editor commit
gateway, so failure and cancellation do not partially publish a graph.

The legacy tool loop still uses the operation contracts and its own policy
behavior. Do not route transactional virtual-document decisions through the
legacy agent, and do not describe legacy operation support as a restriction of
the virtual workspace.

## Current limits and future extension rules

The implemented transactional scope supports:

- full-fidelity editing of every existing graph document in the captured
  project;
- sequential single-document diffs or complete replacements across several
  graphs;
- changed-graph validation in complete project context, project-wide preview,
  atomic Apply, undo, and redo;
- safe editing of existing node fields plus template-backed node creation.

It does not yet support:

- creating, deleting, or renaming graph documents;
- project metadata, project data, UI graph, node-library, plugin, knowledge
  store, MCP, dataset, or referenced-project mutation;
- direct filesystem access or direct `.rivet-project` replacement;
- transactional isolation across different app windows or external file
  writers;
- guaranteed secret discovery for arbitrary plugin-defined field names;
- fuzzy patch application.

Very large documents can require several `nextOffset` continuation reads over
several policy turns. Only successful read bodies retained for actual model
delivery add coverage; turn-size-rejected bodies do not. Once the current
path/digest/length ledger covers the full document, later transcript
compaction does not revoke that authorization. Any accepted edit advances the
revision and resets all accumulated coverage, so a later replacement must
cover the new canonical document again.

Any extension must add an explicit virtual resource type, authorization and
validation policy, bounded read/write contract, preview representation, and
history semantics. It must not weaken exact revision checks or let the model
bypass the host-owned Apply gateway.
