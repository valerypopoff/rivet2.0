import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkedGraphBuilderDevelopmentFixtures,
  runGraphBuilderDevelopmentEvaluation,
  type GraphBuilderSyntheticProject,
} from './index.js';

test('development harness preserves suite order and creates a fresh project for every trial', async () => {
  const projects: GraphBuilderSyntheticProject[] = [];
  const run = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['clarify-invalid-request'],
    trialsPerFixture: 2,
    adapter: ({ materialization }) => {
      projects.push(materialization);
      materialization.project.metadata.title = `trial-${projects.length}`;
      return { outcome: 'clarified' };
    },
  });

  assert.deepEqual(
    run.observations.map((observation) => [observation.fixtureId, observation.trial]),
    [
      ['clarify-invalid-request', 1],
      ['clarify-invalid-request', 2],
    ],
  );
  assert.notEqual(projects[0]!.project, projects[1]!.project);
  assert.equal(projects[0]!.project.metadata.title, 'trial-1');
  assert.equal(projects[1]!.project.metadata.title, 'trial-2');
  assert.equal(
    run.scores.every((score) => score.successfulFixture),
    true,
  );
  assert.equal(run.aggregates['plan-b']['supported-host-safety']?.observationCount, 2);
  assert.equal(run.aggregates['hardened-legacy']['supported-host-safety'], null);
});

test('development harness audits every declared canary without retaining audit surfaces', async () => {
  const safe = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: () => ({
      outcome: 'success',
      graph: null,
      auditedSurfaces: [{ kind: 'provider-wire', label: 'provider-request', value: { messages: ['safe projection'] } }],
    }),
  });
  assert.deepEqual(
    safe.observations[0]!.canaryFindings.map((finding) => finding.locations),
    [[], [], []],
  );
  assert.equal(safe.scores[0]!.gates.redaction.passed, true);

  const exposed = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: ({ fixture }) => ({
      outcome: 'success',
      graph: null,
      auditedSurfaces: [
        {
          kind: 'provider-wire',
          label: 'provider-request',
          value: { body: fixture.syntheticCanaries[0]!.value },
        },
      ],
    }),
  });
  assert.deepEqual(exposed.observations[0]!.canaryFindings[0]!.locations, ['$audit["provider-request"].body']);
  assert.equal(exposed.scores[0]!.gates.redaction.passed, false);
  assert.doesNotMatch(JSON.stringify(exposed), /RIVET_SYNTHETIC_CANARY_/);
});

test('redaction audits inspect object keys and reject non-serialized surface containers', async () => {
  const keyExposure = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: ({ fixture }) => ({
      outcome: 'success',
      graph: null,
      auditedSurfaces: [
        {
          kind: 'provider-wire',
          label: 'provider-request',
          value: { [fixture.syntheticCanaries[0]!.value]: 'exposed as a property name' },
        },
      ],
    }),
  });
  assert.deepEqual(keyExposure.observations[0]!.canaryFindings[0]!.locations, ['$audit["provider-request"].$key']);
  assert.equal(keyExposure.scores[0]!.gates.redaction.passed, false);
  assert.doesNotMatch(JSON.stringify(keyExposure), /RIVET_SYNTHETIC_CANARY_/);

  const nonSerialized = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: ({ fixture }) => ({
      outcome: 'success',
      graph: null,
      auditedSurfaces: [
        {
          kind: 'provider-wire',
          label: 'provider-request',
          value: new Map([['body', fixture.syntheticCanaries[0]!.value]]),
        },
      ],
    }),
  });
  assert.equal(
    nonSerialized.observations[0]!.diagnostics.some((diagnostic) => diagnostic.code === 'redaction-audit-incomplete'),
    true,
  );
  assert.equal(nonSerialized.scores[0]!.gates.redaction.passed, false);
});

test('missing or malformed redaction audit surfaces fail closed', async () => {
  const run = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: () => ({ outcome: 'success' }),
  });

  assert.equal(
    run.observations[0]!.canaryFindings.every((finding) => finding.locations[0] === '$audit.incomplete'),
    true,
  );
  assert.equal(
    run.observations[0]!.diagnostics.some((diagnostic) => diagnostic.code === 'redaction-audit-incomplete'),
    true,
  );
  assert.equal(run.scores[0]!.gates.redaction.passed, false);
});

test('source inputs do not substitute for required provider-wire and enabled sink audits', async () => {
  const sourceOnly = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: () => ({
      outcome: 'success',
      graph: null,
      auditedSurfaces: [{ kind: 'source-input', label: 'policy-turn', value: { prompt: 'safe' } }],
    }),
  });
  assert.equal(sourceOnly.scores[0]!.gates.redaction.passed, false);
  assert.equal(
    sourceOnly.observations[0]!.diagnostics.some((diagnostic) => diagnostic.code === 'redaction-audit-incomplete'),
    true,
  );

  const missingRecording = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: () => ({
      outcome: 'success',
      graph: null,
      requiredAuditSurfaceKinds: ['recording'],
      auditedSurfaces: [{ kind: 'provider-wire', label: 'provider-request', value: { prompt: 'safe' } }],
    }),
  });
  assert.equal(missingRecording.scores[0]!.gates.redaction.passed, false);

  const complete = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['redact-host-known-secrets'],
    trialsPerFixture: 1,
    adapter: () => ({
      outcome: 'success',
      graph: null,
      requiredAuditSurfaceKinds: ['recording'],
      auditedSurfaces: [
        { kind: 'provider-wire', label: 'provider-request', value: { prompt: 'safe' } },
        { kind: 'recording', label: 'recording', value: { events: [] } },
      ],
    }),
  });
  assert.equal(complete.scores[0]!.gates.redaction.passed, true);
});

test('cancellation rollback is derived from the disposable authoritative project', async () => {
  const unchanged = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['cancel-mid-session'],
    trialsPerFixture: 1,
    adapter: () => ({ outcome: 'canceled', cancellationRequested: true }),
  });
  assert.equal(unchanged.scores[0]!.gates.cancellationRollback.passed, true);

  const mutated = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'plan-b',
    fixtureIds: ['cancel-mid-session'],
    trialsPerFixture: 1,
    adapter: ({ materialization }) => {
      materialization.project.graphs[materialization.activeGraphId]!.nodes[0]!.title = 'Mutated before cancel';
      return { outcome: 'canceled', cancellationRequested: true };
    },
  });
  assert.equal(mutated.scores[0]!.gates.cancellationRollback.passed, false);
});

test('adapter failures become deterministic failed observations without retaining thrown text', async () => {
  const run = await runGraphBuilderDevelopmentEvaluation({
    resultSlot: 'hardened-legacy',
    fixtureIds: ['create-small-graph'],
    trialsPerFixture: 1,
    adapter: () => {
      throw new Error('RIVET_SYNTHETIC_CANARY_THROWN_TEXT_SHOULD_NOT_BE_RETAINED');
    },
  });

  assert.equal(run.observations[0]!.outcome, 'failed');
  assert.deepEqual(run.observations[0]!.diagnostics, [{ code: 'evaluation-adapter-error', severity: 'error' }]);
  assert.doesNotMatch(JSON.stringify(run), /THROWN_TEXT_SHOULD_NOT_BE_RETAINED/);
});

test('fixture selection rejects unknown and duplicate IDs', async () => {
  const adapter = () => ({ outcome: 'success' as const });
  await assert.rejects(
    runGraphBuilderDevelopmentEvaluation({
      resultSlot: 'plan-b',
      fixtureIds: ['missing-fixture'],
      adapter,
    }),
    /Unknown Graph Builder evaluation fixture/,
  );
  await assert.rejects(
    runGraphBuilderDevelopmentEvaluation({
      resultSlot: 'plan-b',
      fixtureIds: ['create-small-graph', 'create-small-graph'],
      adapter,
    }),
    /selected more than once/,
  );
});

test('checked public fixtures cover every materializer seed without importing hidden inputs', () => {
  const publicFixtureIds = new Set(
    checkedGraphBuilderDevelopmentFixtures.fixtures.map((fixture) => fixture.syntheticProjectFixtureId),
  );
  assert.equal(publicFixtureIds.size, 15);
});
