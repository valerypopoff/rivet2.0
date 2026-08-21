# Graph Builder Evaluation

Plan B Graph Builder evaluation is owned by
`packages/app/src/features/graphBuilder/evaluation`. It is deliberately
provider-free: the checked suite contains synthetic requests, expectations,
thresholds, canaries, normalization, scoring, and accounting contracts, but it
does not call a live model or contain a developer project.

## Checked assets

The `fixtures` directory contains:

- `evaluation-policy.v1.json`: numeric thresholds frozen before Plan B result
  review, scoring weights, trial counts, tie/abstention rules, and rollout stop
  conditions.
- `development-fixtures.v1.json`: public synthetic fixtures split into
  supported core-authoring, contextual-authoring, host-safety, and
  Phase-8-expected-unsupported cohorts.
- `hidden-holdout.contract.v1.json`: only the versioned ownership contract for
  the separately protected suite. It cannot contain prompts, projects,
  expectations, or canary values. Its protected manifest hash remains `null`
  until release evaluation binds a real external suite.
- `manifest.v1.json`: fixture count and exact SHA-256 digest for every checked
  asset.

Run:

```sh
yarn check:graph-builder-evaluation
```

After an intentional public fixture or policy change, bump the corresponding
version, review the threshold implications, then refresh the manifest:

```sh
yarn check:graph-builder-evaluation --write
```

The check is part of `test:style`. It validates strict schemas, manifest
freshness, unique fixture and canary identities, complete cohort coverage,
truthful Phase-8 unsupported expectations, and the absence of hidden-holdout
inputs.

## Result ownership

Every observation names exactly one immutable result slot:

- `as-shipped-legacy`
- `hardened-legacy`
- `plan-b`

Do not overwrite one slot with another or silently merge attempts from multiple
implementations. One Graph Builder mode is authoritative for a run. The
evaluation aggregate keeps every result-slot/cohort cell separate and leaves
empty cells as `null`, which distinguishes "not measured" from a zero score.
`evaluateGraphBuilderCohortThreshold` compares Plan B only with the matching
hardened-legacy cohort, applies the frozen absolute thresholds and regression
tolerance, and returns `indeterminate` rather than guessing when the baseline
or accounting coverage is missing. Phase-8 truthfulness has no legacy-parity
requirement.

The harness has concrete adapters for both currently runnable product paths:

- `createHardenedLegacyGraphBuilderEvaluationAdapter` invokes
  `runLegacyGraphBuilderDraft`, the same private-draft runtime used by the
  production rollback path. A deterministic fake
  `LegacyGraphBuilderAgentExecutor` may drive it in normal tests; credentialed
  evaluation binds the checked bundled Graph Creator executor.
- `createPlanBGraphBuilderEvaluationAdapter` invokes
  `createPlanBGraphBuilderSessionRuntime`, the same catalog, semantics,
  transaction-kernel, read-executor, and session-controller factory used by
  `usePlanBGraphBuilder`. Normal tests inject scripted typed policy decisions;
  credentialed evaluation may bind the checked policy runner.

These are host-runtime evaluations, not graph-mutating result stubs. The
adapters read the disposable materialization after the real runtime has
finished, map its typed outcome to (`success`, `clarified`, `unsupported`,
`canceled`, `conflicted`, or `failed`), and expose the candidate draft only
when structural scoring legitimately applies. Fixture inputs name one of the
closed `GraphBuilderSyntheticProjectFixtureId` values; they are not filesystem
paths or project IDs.

The retired as-shipped legacy implementation is intentionally not recreated by
the hardened adapter. Its immutable result slot must be populated from the
preserved Phase-0 baseline artifact. Asking the hardened adapter to populate
`as-shipped-legacy` fails closed.

[`syntheticProjects.ts`](../packages/app/src/features/graphBuilder/evaluation/syntheticProjects.ts)
owns the concrete registry for every closed fixture ID.
`materializeGraphBuilderEvaluationFixture(...)` creates a fresh project,
active-graph identity, referenced-project map, node registry, safe synthetic
plugin adapter, and host-state object for every trial. Builders use fixed
fixture IDs and geometry so repeated materializations are deterministic, but
they return new mutable objects so cancellation, conflict, and destructive
legacy tests cannot share state. The registry includes provider-free synthetic
Echo and opaque plugin nodes. The Echo node has one explicit portable settings
adapter; the opaque node deliberately has none.

The redaction project puts each declared canary in the source class named by
the fixture: configured credentials and classified settings stay in synthetic
host state, while the opaque-plugin canary stays in opaque node data. These are
source surfaces supplied to the implementation adapter, not surfaces that the
harness should audit for leakage.

[`harness.ts`](../packages/app/src/features/graphBuilder/evaluation/harness.ts)
owns the reusable public development-suite loop:

1. validate the fixture set, policy, result slot, fixture selection, and trial
   count;
2. materialize a fresh disposable project;
3. capture the authoritative active-graph fingerprint;
4. invoke exactly one injected `GraphBuilderEvaluationAdapter`;
5. transiently audit only the provider/log/recording surfaces returned by that
   adapter;
6. construct and validate the observation, then score and aggregate it with the
   checked policy.

The loop uses Evaluations' shared `runEvaluationWorkPool()` with concurrency
fixed at one. That keeps fixture-set order reproducible while using the same
cancellation and stable-result-ordering semantics as product Evaluations. The
Graph Builder harness intentionally owns only its domain-specific fixture
materialization, redaction auditing, and scoring; it never becomes a second
general-purpose graph-evaluation runner. It never constructs a provider client
and never claims a measured baseline. Adapter exceptions become sanitized failed
observations; externally aborting the suite still aborts the suite. Missing,
duplicate, malformed, or cyclic redaction audit surfaces fail closed with
`redaction-audit-incomplete` instead of being mistaken for a clean audit.
Audited values must be serialized JSON-shaped arrays, plain objects, and
primitives. Maps, class instances, accessors, symbols, and hidden properties
fail closed because an empty enumerable view must not let a non-serialized
provider/log container appear clean. Canary matching includes object keys as
well as string values; persisted finding paths substitute `$key` rather than
retaining a canary-bearing property name.
Adapters drain their per-trial collector exactly once on success or failure,
so a failed provider execution still contributes every already-observed
physical attempt and transient audit surface to its sanitized failed
observation.
Cancellation rollback fingerprints are derived from the disposable
authoritative project rather than trusted adapter claims. Conflict simulation,
provider attempts, and provider-facing audit surfaces remain the adapter's
responsibility.

`runGraphBuilderDevelopmentComparison` runs the hardened-legacy and Plan B
adapters over separate fresh materializations of the same selected fixtures,
then applies the frozen cohort thresholds. It never dual-runs against one
project and never lets one adapter's mutations become the other's baseline.
Provider-free scripted runs truthfully report zero accounting coverage and
therefore cannot pass the provider-accounting rollout gate; they validate host
behavior only. Real provider attempts and provider/log/recording audit surfaces
must be supplied through `createTrialCollector`. That factory must return a
fresh collector for every fixture trial; the adapter consumes each collector's
`takeProviderAttempts` and `takeAuditedSurfaces` exactly once and rejects a
collector object reused by another trial. This prevents one long-lived adapter
instance from leaking earlier attempts into a later observation.

Transient audit surfaces declare their kind: `source-input`,
`provider-wire`, `log`, or `recording`. Policy turns and legacy-agent inputs
are source inputs and can reveal whether the host itself leaked a canary, but
they never satisfy the provider-wire coverage gate. Every redaction fixture
requires an audited provider-wire surface, and a collector that declares log
or recording capture enabled must return those surfaces too. Missing required
surface kinds produce `$audit.incomplete` findings and fail closed.

The checked JSON assets are exposed as parsed, deeply frozen values by
[`assets.ts`](../packages/app/src/features/graphBuilder/evaluation/assets.ts).
Only the public hidden-holdout ownership/version contract is exported. No
hidden input, project, expectation, or result is imported by the development
harness.

## Deterministic structural comparison

`normalizeGraphBuilderEvaluationGraph` removes generated graph/node IDs,
canvas coordinates, widths, z-indices, and connection bend points. It retains
node type, title, data, envelopes, variants/tests, graph text, and
non-positional visual metadata. Exact incident-edge partition refinement runs
to a stable partition instead of stopping after a fixed number of rounds.
Remaining nontrivial equivalent classes use a bounded
individualization/refinement search whose lexicographically minimal topology
defines the canonical IDs. Fully interchangeable classes avoid factorial
search, while refinement or search-bound exhaustion fails closed rather than
falling back to source-array order. Reordered long chains, directed cycles,
and symmetric branches are regression fixtures for this contract.
Canonical comparisons use explicit JavaScript code-unit ordering instead of
the host locale, so Unicode node data and port labels normalize identically
across machines with different ICU locale defaults.

Structural scoring has four frozen weighted components:

- required node counts and exact totals;
- required typed/ported connections and exact totals;
- required and forbidden diagnostic codes;
- acceptable terminal outcome.

Cancellation rollback, stale-commit conflict protection, and secret redaction
are hard gates, not score bonuses. A high structural score cannot compensate
for a failed hard gate.

## Secret canaries

Redaction fixtures use only values prefixed
`RIVET_SYNTHETIC_CANARY_`. They represent configured credentials, classified
settings, and opaque plugin fields. `auditGraphBuilderSyntheticCanaries`
returns paths into a caller-selected synthetic surface and never retains the
surface. A redaction observation must inventory every fixture canary with zero
locations; an omitted audit fails the gate.

Never put a real credential, user project, raw provider body, or production log
into the checked fixture set. Destructive, conflict, and cancellation cases run
against clones constructed by the evaluation adapter.

## Provider-attempt accounting

Each physical provider call receives a unique `attemptId`; nested helpers point
to their parent attempt. The contract records provider/model/version, outcome,
redacted request-shape SHA-256, duration, and nullable token/cost
measurements. It intentionally has no request-body field.

Usage completeness is derived:

- `complete`: input, output, total tokens, and price/cost are all known;
- `partial`: some measurements are known;
- `unknown`: every measurement is missing.

The canonical `missing` list must agree with the nullable fields, and total
tokens must equal input plus output when all three are known.
`summarizeGraphBuilderProviderAttempts` returns `null`, never zero, for any
aggregate whose physical attempts are missing that measurement. Known zero
usage remains a valid complete measurement. Cost-based rollout comparison must
abstain below the frozen accounting-coverage threshold.

Credentialed provider trials and the protected holdout runner are release
infrastructure, not part of the default repository test suite.
