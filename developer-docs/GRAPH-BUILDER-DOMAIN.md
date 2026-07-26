# Transactional Graph Builder Domain

The model-free Plan B domain lives in
`packages/app/src/domain/graphBuilder`. Import it through that directory's
`index.ts`; individual source files are implementation details.

## Contract ownership

`graphBuilderSchemas.ts` is the runtime source of truth for:

- `GraphBuilderDecision`
- `GraphPatchProposal` and the host-owned `GraphPatch`
- operation and node-reference contracts
- diagnostics and validation results
- bounded projections and read results
- patch-application and public session results
- active-graph authorization

The protocol version is `GRAPH_BUILDER_PROTOCOL_VERSION`. Model/provider output
must be accepted through the exported `parseGraphBuilder*` functions, not a
TypeScript cast or plain `JSON.parse`. Those functions first enforce portable
JSON limits and prototype safety, then run the strict Zod schema. Unknown
properties, dangerous dictionary keys, unsafe/non-finite numbers, excessive
depth/size, duplicate patch-local IDs, and duplicate canonical read requests
are rejected. Values inside the set-like arrays of a read request must also be
unique. That semantic check deliberately remains in the host parser rather than
using JSON Schema `uniqueItems`, because otherwise provider response-format
compatibility would become part of the runtime authority contract. The checked
policy prompt tells the model not to repeat those values.
The portable-data preflight also rejects sparse arrays, extra or hidden
properties, symbol keys, and accessor properties without invoking their
getters. Portable byte accounting and canonical serialization operate on
private data-only clones, so a polluted inherited `toJSON` hook cannot replace
validated arrays or undercount their encoded size. Full authoring-project
identities apply the same data-only array and serialization rules, so
compare-and-swap fingerprints cannot silently omit array metadata, execute an
accessor, or be replaced by prototype behavior while being calculated.
Referenced-project maps are canonicalized directly before catalog cloning or
enumeration, so an accessor-bearing map fails closed without executing the
accessor.

Canonical identities use sorted portable JSON. The current
`fnv1a64:` digest is a deterministic, non-cryptographic lookup identity. Any
authority or conflict check must also retain and compare the canonical string;
the digest alone is not collision-proof. Composite identities use JSON-encoded
string tuples rather than delimiter concatenation, so control characters
inside otherwise valid graph, node, and port identifiers cannot make distinct
endpoints alias one another. Preview connection rows use the same tuple
identity for UI reconciliation; their human-readable labels are display text
only.

## Transaction kernel

`GraphBuilderTransactionKernel` owns a private clone of
`GraphBuilderAuthoringProject` (`Project` without dataset payloads). It mutates
only the authorized active graph and never accesses React, Jotai, storage,
networking, graph execution, or the editor.

Construct it with:

```ts
new GraphBuilderTransactionKernel({
  project,
  activeGraphId,
  authorization,
  semantics,
  idGenerator,
  initialDraftRevision,
});
```

Its public state API deliberately returns clones:

```ts
kernel.getDraft();
kernel.getDraftRevision();
kernel.applyPatch(hostOwnedPatch);
```

`applyPatch`:

1. Strict-parses and canonically fingerprints the host envelope.
2. Replays an identical `patchId` or raises `GraphBuilderProtocolError` when the
   same ID is reused with different content.
3. Rejects stale revisions or unauthorized operations.
4. Applies ordered operations to a candidate clone.
5. Resolves patch-local `created` references through host-allocated node IDs.
6. Re-resolves dynamic ports and validates connections after relevant changes.
7. Normalizes through the captured semantics and verifies its derived effect
   closure.
8. Runs mandatory touched-scope validation.
9. Atomically promotes the complete candidate, or retains the prior draft
   byte-for-byte.

An applied candidate advances `draftRevision` once. A canonical no-op does not.
Rejected patches are retained in the in-memory idempotency ledger too, so a
later state change cannot make redelivery of the same rejected identity perform
new work. Deltas retain exact total counts but bound each returned item list;
`truncated` tells preview/repair consumers when they must inspect the private
draft rather than assuming the sample list is complete.

The initial exact operations are:

- `createNode`: one captured authoring choice, host ID, registered defaults, and
  a host placeholder position.
- `updateNodeSettings`: authoring-adapter fields only; ID, type, and envelope
  cannot change.
- `updateNodeEnvelope`: title, disabled, conditional, split-run enablement, and
  split limit only.
- `deleteNode`: removes the node and every incident connection.
- `connect`: exact endpoints, current ports, no duplicate edge, no occupied
  single-input port, and mandatory semantic validation.
- `disconnect`: removes exactly one matching endpoint tuple; missing and
  ambiguous tuples reject.

Settings that would invalidate an existing connection reject unless an earlier
explicit `disconnect` in the same patch removed that connection.

## Injected authoring semantics

The app adapter supplies one immutable `GraphBuilderAuthoringSemantics` snapshot:

- `createNodeFromAuthoringChoice`
- `applyNodeSettings`
- `resolvePorts`
- `validateConnection`
- `normalizeCandidate`
- `validateCandidate`

The kernel passes defensive clones to these methods. Adapter failures,
malformed results, incomplete mandatory validation, missing ports, or invalid
normalization effects reject the whole candidate. Base projects and adapter
node/normalization results cross the data-only authoring boundary before they
are cloned or inspected. Dynamic port results separately cross the portable
JSON boundary and must use unique, nonempty, trimmed, bounded port IDs plus
known unique Rivet data types; accessor-bearing or hidden port metadata fails
without executing. `GraphValidationResult`
therefore includes `completeness: "complete" | "incomplete"` in addition to
diagnostics and blocking keys. Diagnostic identities must be unique. Long
host-derived identities use a deterministic hash suffix instead of plain
truncation, preventing distinct graph paths from collapsing to the same
blocking key or preview-list identity.

Catalog capture owns frozen copies of adapter aliases, setting descriptors,
descriptor paths, and enum values. Caller-owned adapter arrays cannot mutate
authorization or projection behavior after the catalog fingerprint is fixed.
The registry contract fingerprints only editor preferences that affect
authoring output. Changing unrelated editor UI behavior, such as whether newly
created nodes open their settings panel, does not invalidate an active session.
Plugin adapters are runtime-validated during capture: aliases, callbacks,
setting kinds, paths, projections, and enum values must match the public
adapter contract, and duplicate enum values fail closed instead of becoming
latent fingerprinted behavior. Only own properties of the host-supplied
adapter dictionary grant plugin authoring authority; prototype-inherited
entries are ignored. Adapter properties are normalized from own contract fields
only, and required setting-descriptor fields must also be own properties.
Dynamic built-in metadata and project graph-existence checks use the same
own-property rule so names such as `toString` cannot resolve through
`Object.prototype`. Candidate node indexes use null-prototype records for the
same reason: model-authored connection endpoint IDs must match an actual node,
never an inherited object member.
Catalog choices and referenced-resource entries use explicit code-unit
ordering, so the captured fingerprint does not depend on the host locale when
plugin or project identifiers contain Unicode.
Node-type search likewise preserves Unicode letters and numbers, so localized
plugin names and non-Latin policy queries remain discoverable.

Creation should route through the editor's extracted `createAddedNode`
semantics. Port resolution must use effective nodes, complete incident
connections, the full captured authoring project, referenced projects, and
`getInputDefinitionsIncludingBuiltIn`. Connection type/topology rules and
candidate validation remain app-owned injected policy; the transaction kernel
does not duplicate them.

The normalizer may only change `data` on nodes created or settings-updated by
the patch. It may not change identities, envelopes, graph metadata,
connections, sibling graphs, UI graphs, prefabs, or other project state.

## Integration boundary

The session controller owns policy turns and creates a `GraphPatch` by adding
`patchId` and `expectedDraftRevision` to a parsed proposal. The editor gateway
receives only a validated private draft/delta and remains responsible for the
single compare-and-swap commit, history, recoverable editor state, selection,
and layout.

The policy runner executes its checked project with a four-node-type registry
and forwards only LLM transport settings needed by the selected provider.
Plugin environment/settings and legacy global Chat headers are deliberately
omitted from that processor context; installing a plugin or configuring an
unrelated Chat node cannot grant the policy workflow a new capability, inject
an undeclared header, or make plugin credentials visible to it.
The policy prompt has one shared source used by policy-asset generation,
freshness checks, runtime sealing, and runner fixtures. Runtime validation also
rejects drift in node execution envelopes, graph-input defaults, dormant
project data/prefabs/UI graphs/knowledge stores, and inert LLM retry/tool
settings before a processor is created.
`policyAssetContract.ts` similarly owns the exact policy identities, expected
edges, model-injection allowlist, and sealed LLM fields shared by the
independent runtime and CI validators. The manifest parser rejects identity
drift at module load. Validation logic remains independent so a checker bug is
not automatically mirrored, while the underlying contract data cannot
silently diverge. The parsed manifest and every shared array/object in that
contract are deeply frozen runtime authority; another app module cannot mutate
the selected graph identity or sealing allowlists after import.
The policy LLM also seals both alternate custom-provider credential lookup
names empty. It may receive only the captured shared custom-provider key from
the minimal processor settings resolver; a serialized policy asset cannot name
an unrelated programmatic setting or process environment variable.
Missing provider configuration is rejected before the policy asset is loaded,
and an asset load failure becomes a sanitized `invalid-asset` result without
constructing a processor. Raw loader paths, provider errors, and their causes
remain host-internal.

During the rollback window, the legacy Graph Creator policy uses the same
editor-safety boundary through
`features/graphBuilder/legacyDraftRunner.ts`. That runner is production code,
has no React/Jotai/editor-state dependency, accepts an injected
`LegacyGraphBuilderAgentExecutor`, and mutates only its cloned full authoring
project. The production executor factory in
`legacyGraphCreatorAgentExecutor.ts` supplies the bundled Rivet policy,
minimal registered AI Assist generator, runtime settings, and physical-call
accounting observer. Open-ended runtime settings are applied before the
executor's host-owned graph, inputs, abort signal, tools, registry, and
observer, so an unexpected settings key cannot replace those execution
boundaries. Deterministic tests and evaluation may inject a fake agent without
replacing the mutation implementation.

Legacy one-operation tools expose the current `draftRevision`, and progress
contains host-derived draft deltas rather than a published graph. Completion
without the explicit `finalMessage` event is a failure. A successful run
returns `ready-for-preview` or `no-change`; it cannot commit. The React adapter
retains session ownership with the ready draft and routes Apply through
`prepareGraphBuilderCommit` plus `tryCommitGraphBuilderDraftState`, exactly like
Plan B. This preserves existing undo history and makes cancellation, provider
failure, handler failure, Discard, and stale editor/plugin identity zero-write
outcomes. Cancellation also detaches the runner from an agent that ignores its
abort signal while retaining a rejection observer on that abandoned promise,
so the UI settles promptly without permitting a late unhandled rejection.
An abort that already won is checked before the legacy agent is invoked, so it
cannot spend a provider call or execute draft tools.
Environment-backed settings resolution is also an editor-identity boundary:
after it resolves, the adapter rechecks cancellation, component/session
ownership, and the complete captured base identity before constructing the
agent executor. A project or graph switch during credential lookup therefore
becomes a zero-provider-call conflict instead of running against a stale
snapshot. Both Plan B and rollback adapters race this injected settings task
against their startup abort signal. Cancel or component disposal therefore
settles the host `start()` promptly even when an environment provider ignores
cancellation or never resolves. The abandoned promise remains rejection
observed, and no executor or controller is constructed from a late result.
Legacy draft finalization uses the same deterministic SCC-aware layout helper
as Plan B and applies it only to node IDs absent from the captured base.
Settings-only edits preserve every coordinate, and a reachable directed cycle
cannot trap the synchronous rollback path in an unbounded layout traversal.

The controller is also the runtime trust boundary for asynchronous results:

- caller-supplied session IDs are validated against the portable identifier
  contract, and all derived turn, attempt, read, patch, and repair-diagnostic
  correlation IDs use the shared bounded-identifier derivation;
- successful and failed physical policy calls contribute validated
  complete/partial/unavailable usage before their result is consumed;
- elapsed wall-clock duration is clamped to a nonnegative value, so a host
  clock correction cannot violate the evaluation event schema or increase the
  reported remaining budget above its configured maximum;
- malformed usage fails closed, while exceeding a reported post-call budget
  terminates as `budget-exhausted`;
- a policy runner `invalid-decision` error, or a successful runner result whose
  decision still fails the local parser, consumes the bounded repair budget and
  records only a safe local diagnostic before another policy attempt;
- read results are portable-schema parsed and must reproduce the exact
  host-assigned request ID, request index, and draft revision;
- Cancel, Discard, deadline expiry, active-work inactivity expiry, and
  clarification expiry publish their terminal state immediately and abort
  outstanding work. Controller waits race those abort signals, so even an
  adapter that ignores abort cannot keep `start()`/`resume()` pending, later
  promote a patch, or overwrite the outcome;
- the wall clock is rechecked after asynchronous boundaries, after synchronous
  policy-turn preflight, and before terminal promotion or Apply. Active-work
  inactivity is cleared while clarification or a ready preview waits on the
  user, while the hard session deadline continues to bound both states;
- user requests and clarification answers are bounded before they can enter a
  policy turn or the non-evictable transcript. Their replay-visible limit
  diagnostics use locale-independent base-10 formatting, so the same rejected
  input produces the same typed failure text on every host;
- policy-attempt accounting is reserved only after the complete host-side turn
  passes byte and transcript preflight, so a rejected local envelope never
  masquerades as a physical provider call;
- contradictory `ready`/`no-change` transitions consume a repair attempt and
  provide a deterministic host diagnostic to the next policy turn. Final
  whole-draft validation is portable-schema parsed again before preview;
- session-state subscribers receive cloned snapshots, and exceptions from both
  initial and subsequent notifications are isolated from controller ownership;

The React adapter captures editor context before acquiring session ownership
and fails closed if capture itself throws. It rechecks ownership and canonical
identity after asynchronous settings resolution, then deep-clones resolved
runtime settings so later settings-store mutation cannot change the in-flight
session. Modal progress, cancellation, close confirmation, and captured-model
display are derived only from the implementation mode latched when that session
started. Brief stale state in the inactive rollback adapter during an
asynchronous reset cannot make the opposite mode appear busy or cancel the
wrong session. Only a controller in
`ready-for-preview` may enter the synchronous, non-cancelable `committing`
state. The editor commit gateway re-canonicalizes the prepared graph immediately
before both commit-ID replay and publication. Replay identity also includes the
complete captured base identity, captured owner session, draft revision,
candidate graph, and user-visible summary, so a graph mutated after
publication, a changed precondition, or a different owner cannot reuse an
earlier ledger outcome. The gateway compares exact canonical content; the
non-cryptographic digest is never the authority for Apply idempotency. Its
cross-session replay ledger is capped because entries retain canonical graph
content. The ledger retains an isolated outcome copy and returns a fresh copy
for every initial or replay response, so consumer mutation cannot corrupt
idempotent replay. All non-evictable patch/read identities remain owned by the
bounded live session controller instead. A commit-time eligibility loss is
reported as `failed/commit-ineligible` with the private preview retained; only
a canonical base-identity mismatch is reported as `conflicted`.

Apply, undo, and redo also preserve editor-only disconnected-connection
recovery state. A recovery entry survives an unrelated Graph Builder commit
only while both endpoint nodes still exist and the connection is still absent
from the committed graph. Entries whose endpoint was deleted, or whose
connection is live again, are removed from the post-commit snapshot. The
history command retains the exact before/after recovery maps so undo and redo
cannot silently discard unrelated recoverable wires.

Terminal metrics are an optional product integration, not a hidden transport.
`GraphBuilderMetricsEvent` has an explicit version and terminal outcome, and
products inject a `GraphBuilderMetricsSink`. The default named no-op sink keeps
the desktop behavior local. A sink exception is swallowed after the session
result is fixed and must never affect generation or Apply.

The editor snapshot marks a graph as transient only when it is absent from the
persisted project and the captured live graph is empty. Authoring semantics
receive the resulting graph-ID allowlist once. Persisted graph boundaries stay
immutable, while the authorized transient graph may create and repair its
boundary over several private patch batches before the single Apply.

Preview details come from the bounded host-derived `GraphDraftDelta`, never
from provider prose. The transaction kernel derives this delta cumulatively
from the immutable session base to the current private draft; patch-local
deltas remain transcript details and a later no-op cannot erase earlier
preview changes. Public preview state contains the cumulative delta,
diagnostics, revision, and summary, but never clones or exposes the complete
private project. The UI displays exact total-count fields, the sampled
node/connection identities, and a truncation marker. A commit conflict retains
that same private preview so the user can inspect what was not published.
The committed-state **View graph** action centers the authoritative active
graph before closing the modal; it is not merely a relabeled Close action.
Read payload portability and byte limits are enforced once at the executor
boundary after a read-specific builder returns its value.
Every ordering that contributes to fingerprints, diagnostics, catalog/read
payloads, or evaluation artifacts uses the shared locale-independent UTF-16
code-unit comparator. Host locale therefore cannot change a policy turn,
authoritative identity, preview ordering, or replay/evaluation result.

Do not:

- hand model output directly to `applyPatch` without the parser/controller
  envelope;
- expose raw `node.data` replacement;
- reach into the live editor from a semantics adapter;
- evict patch ledger entries before the session is disposed;
- treat the non-cryptographic proposal digest as an authority check by itself;
- silently continue after incomplete validation.

Focused tests live beside the domain files and cover schema/prototype safety,
authorization, symbolic references, revision/idempotency behavior, atomic
rejection, no-ops, connection preservation, delete effects, preconditions,
normalization effect closure, and fail-closed validation.
