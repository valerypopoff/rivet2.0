# Share graph input/output rename orchestration

## Objective and baseline

Consolidate the duplicated graph traversal, rename detection, caller reconciliation, and external-graph snapshot construction used by Graph Input and Graph Output renames. Preserve all existing behavior, especially input collision resolution, output fan-out, and merged-edit Undo/Redo.

This plan is based on commit `504e6443acd650175140193769bf19dbefdab859`. The working tree was clean when inspected. Current production file sizes, including comments and blank lines, are:

| File | Lines |
| --- | ---: |
| `packages/app/src/domain/graphEditing/graphInputRenamePropagation.ts` | 304 |
| `packages/app/src/domain/graphEditing/graphOutputRenamePropagation.ts` | 257 |
| Combined propagation modules | 561 |
| `packages/app/src/commands/editNodeCommand.ts` | 594 |

Aim for approximately 150–200 fewer production lines across the affected files, including the new shared module, imports, types, and any retained adapters. This is an estimate, not permission to compress readable code or change behavior. Report the measured result after formatting. Exclude tests, documentation, and unrelated changes from that calculation.

This task introduces no runtime feature, dependency, schema migration, version bump, commit, or push. Implementation must preserve unrelated working-tree changes present when it begins.

## Implementation status (2026-09-14)

- [x] **DONE — shared production ownership.** The two production propagation modules have been replaced by `graphPortRenamePropagation.ts`; the old modules were deleted after their only consumers moved to the shared module. It owns boundary-ID extraction, live-current-graph overlay, direct `Subgraph` traversal, port-order migration, and changed external-graph snapshots while retaining separate input and output connection rules.
- [x] **DONE — command and history integration.** `editNodeCommand.ts` calls the shared helper in the existing input-then-output order, uses the shared result types, rebuilds merged callers from the original snapshot, and preserves the original-to-original merged case. It also persists an explicit active-graph snapshot: a later command cannot validate a recursive caller against stale project state and drop a connection restored by a merged rename.
- [x] **DONE — browser-level acceptance and documentation.** `graph-port-rename.spec.ts` exercises real editor commands, collision ownership, defaults, port order, fan-out, bend metadata, unrelated connections, recursive callers, merged edits, and persisted Undo/Redo. `developer-docs/APP-ARCHITECTURE.md` and `developer-docs/studio-server/development.md` describe the final ownership and focused browser entry point.
- [x] **DONE — focused verification.** All 59 shared/domain/rename-command/history/recovery/port-order tests, `yarn test:style`, App lint/build, the headless `graph-port-rename.spec.ts` suite, local documentation-link checks, and `git diff --check` passed. App lint has one pre-existing warning in `RivetAppLoader.tsx`, with no errors.
- [x] **DONE — complete characterization matrix.** The added explicit fixtures cover an absent current graph, no-op and exact-ID handling (including whitespace and disabled duplicates), several callers in one graph, both input-collision orders, frozen inputs, and a recursive output caller returning to its original ID.
- [x] **DONE — reproducible final measurement.** Physical lines, including blank lines and comments, total 1,000 (`graphPortRenamePropagation.ts`: 348; `editNodeCommand.ts`: 652), versus 1,155 at the declared baseline commit: **155 lines removed (13.4%)**, within the estimate. Counting nonempty lines separately gives 1,016 before and 893 after: **123 nonempty lines removed (12.1%)**. PowerShell `Measure-Object -Line` excludes empty lines; use `@(git show "<commit>:<path>").Count` for baseline physical lines and `[System.IO.File]::ReadAllLines(<path>).Length` for current files. These are two measurements of the same change, not different baselines.

## 1. Establish the compatibility contract — DONE

Read both propagation modules, `subGraphPortOrder.ts`, and the complete rename-related path in `editNodeCommand.ts` before editing. Capture existing outputs using explicit fixtures and retain the current tests.

### Rename detection

- Detect a rename only when the same edited node exists on both sides with the expected boundary node type and string-valued `data.id` fields.
- Equal IDs are a no-op for ordinary propagation. Missing or non-string IDs must not become empty-string renames.
- Preserve exact string matching, including whitespace, case, and explicitly empty strings. Do not trim or add validation.
- If another boundary node of the same type still exposes the old ID in the next live node list, do not propagate the rename. The existing check includes disabled nodes; do not substitute a runtime port-definition filter.
- A missing current graph ID returns copied current arrays and no external snapshots.
- A node changing from Graph Input to Graph Output, or vice versa, is not an ordinary rename within either side.

### Traversal and caller eligibility

- Visit project graphs in their existing enumeration order.
- Overlay the current graph with the provided live next nodes/connections; its stored project copy can be stale.
- If the current graph is absent from the project map, include a synthesized current graph using the existing metadata fallback.
- Reconcile only direct `subGraph` nodes whose stored `data.graphId` equals the target graph ID. Preserve existing treatment of disabled callers.
- Include recursive callers inside the edited graph and multiple callers within one external graph.
- Preserve graph metadata, node order, connection order, unrelated node fields, and connection metadata such as bends.
- Do not extend propagation to Graph Reference, Call Graph input objects, referenced projects, aliases, runtime output maps, or UI-graph binding reconciliation.

### Input-specific behavior

Keep a plainly named `rewriteConnectionsForSubGraphInputRename` implementation:

- An existing connection at the new input ID takes precedence, regardless of its position relative to old-ID connections.
- Keep the first existing new-ID connection and remove later duplicates at that caller/input.
- If no new-ID connection exists, move only the first old-ID connection and discard later old-ID duplicates.
- Preserve unrelated connections, including their existing duplicates and ordering.

Keep `renameSubGraphInputData` as an input-only operation. Move the old default when the new key is absent; retain the existing new default when both keys exist; remove the old key. Preserve the existing property-presence checks and shallow copy behavior, including values such as `undefined` or `null`. Do not add new normalization or prototype-handling behavior during this refactor.

### Output-specific behavior

Keep a separate `rewriteConnectionsForSubGraphOutputRename` implementation:

- Rewrite the source port for every matching outgoing connection and preserve fan-out to different destinations.
- Preserve the existing endpoint-key and iteration-order algorithm: discard a duplicate only when the current or previously seen connection for that key was rewritten.
- Keep the first encountered connection when a rewrite creates a collision, including that connection's additional metadata.
- Preserve unrelated pre-existing duplicate connections. Do not replace the algorithm with graph-wide deduplication or an input-style one-connection rule.

### Port order and snapshots

Reuse `renameSubGraphPortOrder` without changing its behavior. It only acts when the stored order includes the old ID, rewrites in order, and retains the first occurrence of each resulting string ID. It does not always prefer the position of the pre-existing new-ID entry; document this accurately.

Preserve the current copy contract: return fresh result arrays, retain unchanged element references, and avoid mutating inputs. Reconciliation currently returns a graph wrapper and copied arrays even when `changed` is false; retain that observable behavior initially.

Only changed external graphs appear in `projectGraphSnapshots`. Their `previousGraph` is a detached `structuredClone` of the stored original; their `nextGraph` is the reconciled graph. The live current graph is returned through current nodes/connections, never as an external snapshot.

## 2. Introduce one small shared orchestration module — DONE

Create `packages/app/src/domain/graphEditing/graphPortRenamePropagation.ts`.

Prefer a closed input/output selector over a general configurable strategy system. The module should own:

- Common argument/result/snapshot types.
- Exact boundary-ID extraction and ordinary rename detection.
- Project traversal and live-current-graph overlay.
- Per-graph direct-caller traversal.
- Dispatch to the two explicit connection rewrite functions.
- Input-default migration where applicable.
- The existing port-order helper call for the relevant side.
- Changed-graph tracking and external snapshot construction.

Suggested public interface:

```ts
export type GraphPortRenameKind = 'input' | 'output';

export type GraphPortRenameProjectGraphSnapshots = Record<
  GraphId,
  { previousGraph: NodeGraph; nextGraph: NodeGraph }
>;

export type PropagateGraphPortRenameResult = {
  nextCurrentConnections: NodeConnection[];
  nextCurrentNodes: ChartNode[];
  projectGraphSnapshots: GraphPortRenameProjectGraphSnapshots;
};

export function propagateGraphPortRename(args: {
  kind: GraphPortRenameKind;
  currentGraphId: GraphId | undefined;
  editedNodeId: NodeId;
  previousCurrentNodes: readonly ChartNode[];
  nextCurrentNodes: readonly ChartNode[];
  nextCurrentConnections: readonly NodeConnection[];
  project: Project;
}): PropagateGraphPortRenameResult;

export function rewriteSubGraphCallerGraphForGraphPortRename(args: {
  kind: GraphPortRenameKind;
  graph: NodeGraph;
  targetGraphId: GraphId;
  oldPortId: string;
  newPortId: string;
}): { graph: NodeGraph; changed: boolean };
```

Keep side-specific rewrite functions private and recognizable in this module. Use `getSubGraphPortOrderKey` from the existing port-order module if it makes the shared caller reconciliation clearer. Use Core's existing types with type-only imports; do not introduce `any`, dynamic endpoint-field mutation, plugin registries, classes, or a configurable pipeline.

The caller-graph rewrite entry point deliberately does not detect whether a boundary still exists: merged command history supplies an already-resolved original-to-final rename. Keep that distinction from ordinary propagation explicit.

Initially preserve the two existing named propagation/rewrite exports as thin adapters while moving logic. Once all repository consumers are updated, remove the obsolete modules and aliases rather than leaving two implementations. These are private App modules; confirm their complete consumer inventory before removing them.

Do not combine this work with traversal performance changes, caches, connection indexing, clone elimination, or changes to connection-key encoding. Those deserve separate behavioral review if warranted.

## 3. Integrate with edit-node commands without redesigning history — DONE

`buildEditNodeAppliedData` currently performs connection recovery first, then input propagation, then output propagation, and combines external snapshots. Preserve that sequence initially using the shared helper with explicit `kind` arguments. The objective is shared orchestration, not changing the command's treatment of unusual edits.

Use shared result/snapshot types where the command currently repeats identical structures. Keep command-history state and application of snapshots in the command layer.

Replace the input/output branches inside `getNextGraphFromOriginalRenameSnapshot` with the shared caller-graph rewrite entry point. Preserve its early `structuredClone(graph)` when original and final IDs are equal.

Do not blindly reuse ordinary rename detection for `getOriginalGraphPortRename`: ordinary detection rejects equal IDs, whereas merged history must recognize `old → temporary → old` so it can restore the original caller state. Retain this separate history-specific function unless a smaller shared primitive preserves that distinction explicitly.

Preserve all of the following:

- A merged edit keeps the original pre-edit node, connections, current-node snapshot, and external graph snapshots.
- Rebuild original-to-final caller changes from the original snapshot, so a temporary collision cannot destroy an original connection or default permanently.
- Apply the same rule to recursive callers in the live graph.
- Keep snapshot entries needed to restore graphs touched by earlier merged edits even when the final rename is a no-op.
- Preserve recoverable-connection handling and whether optional snapshot fields are absent.
- Undo restores previous state; Redo applies captured next state. Redo must not recompute propagation against a potentially different project snapshot.
- Keep history merge boundaries, graph scoping, UI-binding reconciliation, and command overrides as they are.

## 4. Verify behavior at the right boundaries — DONE

### Existing tests to retain

Run the existing suites after each extraction stage:

- `graphInputRenamePropagation.test.ts`
- `graphOutputRenamePropagation.test.ts`
- `subGraphPortOrder.test.ts`
- `editNodeCommandGraphInputRename.test.ts`
- `editNodeCommandGraphOutputRename.test.ts`
- `editNodeCommandMerge.test.ts`
- `editNodeCommandRecovery.test.ts`
- `editNodeWithConnectionsCommand.test.ts`

Keep the input/output test cases named separately even if they now import the same module. Their policy differences are the reason for retaining those suites.

### Targeted coverage gaps

Add only cases that protect the extracted boundary and are absent from existing tests:

| Area | Required assertions | Status |
| --- | --- | --- |
| Live overlay | Stored current graph is stale; returned nodes/connections come from the live arguments. | **DONE** — shared-module test. |
| Missing current graph | Recursive caller still updates when the current graph is absent from the project map. | **DONE** — synthesized-current-graph fixture. |
| No-op detection | Wrong type, missing/non-string/equal IDs, missing graph ID, and remaining old-ID boundary produce no external snapshots. | **DONE** — shared and retained fixtures cover each no-op boundary. |
| Exact identity | Empty/whitespace IDs and disabled duplicate boundaries retain current behavior. | **DONE** — explicit empty/whitespace and disabled-duplicate fixtures. |
| Multiple callers | Several callers in one graph and callers in multiple graphs update once per caller; unrelated graphs remain absent from snapshots. | **DONE** — same-graph and multi-graph fixtures. |
| Input collisions | New connection occurs before and after old; duplicate new/old connections; existing default survives; untouched connections stay intact. | **DONE** — explicit connection-order characterization. |
| Output collisions | Fan-out survives; both collision orders preserve the correct first connection and metadata; unrelated duplicates remain. | **DONE** — retained output suite and browser fixture cover these policies. |
| Order/default-only edits | A caller without a matching connection can still change through stored order or input defaults. | **DONE** — retained input/output suites cover default-only and order-only migration. |
| Copy ownership | Frozen input fixtures are not mutated; changing a returned prior snapshot cannot mutate the source project. | **DONE** — frozen live/stored fixture plus detached snapshot assertion. |
| Merged history | `old → occupied → final` and `old → temporary → old` restore connections, defaults, port order, and recursive callers exactly. | **DONE** — command/browser coverage, including reverse-to-original recursive output caller. |

Use explicit expected graph values and controlled fixture builders. Do not generate expected values using the new shared helper, retain copied old production algorithms, or add tests that inspect implementation source text.

### Real Undo/Redo and browser verification

Existing rename command tests exercise `buildEditNodeAppliedData`; correct snapshots alone do not prove that real Undo/Redo applies them correctly. Add a focused `graph-port-rename.spec.ts` using the repository's hosted-editor fixture conventions and real edit-node commands.

Seed a project with a child graph containing Graph Input/Output boundaries and a parent containing direct Subgraph callers. Include input defaults, custom port orders, an input collision, output fan-out, and an unrelated connection. Include a recursive caller either in this scenario or a second focused scenario.

Through the editor, rename each boundary, wait for the editor's actual commit boundary, then inspect the resulting caller ports/connections and captured project state. Undo once and verify the exact original state; Redo once and verify the final state. Add a merged-edit collision-and-revert scenario, using observable state transitions rather than sleeps. Respect Graph Output's debounced string editor: flush through blur/Enter before asserting the committed result.

Use an existing hook/command harness if available for additional command-layer assertions. Do not expose production state or add dependency-injection machinery only to make tests convenient. The browser scenario must exercise the actual command history, not manually install snapshots.

## 5. Implementation and verification sequence — DONE

1. Record current HEAD/status and baseline counts; inspect the complete consumer inventory and existing tests.
2. Run `yarn test:style` before runtime suites. Run existing focused rename tests against the baseline.
3. Add missing characterization cases with explicit expected results; verify they pass before extraction.
4. Introduce the shared types and orchestration with temporary thin adapters. Keep the two connection algorithms and input-default policy intact. Run domain and command tests.
5. Integrate the command layer, remove obsolete adapters/modules after updating imports, and rerun focused tests.
6. Add the actual Undo/Redo browser check and update developer documentation to describe final ownership.
7. Run App type checking/build and lint, the focused domain/command suites, and headless browser verification against the changed checkout.
8. Run documentation-link checks and `git diff --check`; measure production line reduction and review the final diff for unrelated edits.

Representative focused commands from the repository root, adjusted only if test filenames change during consolidation:

```powershell
yarn test:style
yarn workspace @valerypopoff/rivet-app test src/domain/graphEditing/graphInputRenamePropagation.test.ts src/domain/graphEditing/graphOutputRenamePropagation.test.ts src/domain/graphEditing/subGraphPortOrder.test.ts src/commands/editNodeCommandGraphInputRename.test.ts src/commands/editNodeCommandGraphOutputRename.test.ts src/commands/editNodeCommandMerge.test.ts src/commands/editNodeCommandRecovery.test.ts src/commands/editNodeWithConnectionsCommand.test.ts
yarn workspace @valerypopoff/rivet-app lint
yarn workspace @valerypopoff/rivet-app build
$env:PLAYWRIGHT_HEADLESS = '1'
$env:PLAYWRIGHT_SLOW_MO = '0'
yarn studio-server:ui:observe graph-port-rename.spec.ts
node scripts/checks/check-doc-links.mjs
git diff --check
```

Set `PLAYWRIGHT_BASE_URL` only when needed to select the current checkout's app target. On browser failure, inspect `artifacts/playwright/` and distinguish fixture/startup failures from failed behavior assertions. Record terminal exit codes for every gate; do not infer success from partial output. No Kubernetes rehearsal is needed.

## 6. Documentation, measurement, and acceptance — DONE

Update the existing rename ownership bullets in `developer-docs/APP-ARCHITECTURE.md` to link to the shared module, explain the separate input/output policies, and describe original-snapshot rebuilding for merged edits. Correct the input port-order description to reflect first-occurrence retention. Add the focused browser entry point to `developer-docs/studio-server/development.md` if a new observable spec is added. User documentation needs no change because behavior is preserved.

Measure physical production lines against the recorded baseline across both original propagation modules, the new module, `editNodeCommand.ts`, and any other production file changed by this refactor. Include deleted files, new files, helpers, imports, comments, and blank lines; exclude tests/docs and unrelated changes. Report per-file and total deltas without counting a moved file as pure deletion.

Completion requires:

- One authoritative implementation of rename detection, traversal, caller reconciliation, and external snapshot construction.
- Two explicit connection-rewrite algorithms with input-only default migration.
- Exact compatibility for collisions, fan-out, ordering, metadata, duplicate boundaries, live recursive callers, and copy ownership.
- Preserved merged-edit recovery and verified real Undo/Redo.
- Passing focused tests, App validation, browser checks, and documentation-link/diff checks, with any blockers stated precisely.
- A clear net production line reduction and documentation matching the final code.

The completion report should state the actual reduction, the ownership simplification, test outcomes, and any unverified cases. Do not call the refactor complete solely because the target line estimate was met.
