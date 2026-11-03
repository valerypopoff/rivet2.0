import assert from 'node:assert/strict';
import test from 'node:test';
import { ReusableProviderGate } from './qualification/provider-gate.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
} from './lib/studio-server-release-manifest.mjs';

test('concrete provider rollout persists each journal before observing it and propagates observer failures', async () => {
  const manifest = promoteStudioServerReleaseManifest(
    createStudioServerReleaseManifest({
      rootDir: process.cwd(),
      source: { repository: 'example/rivet', ref: 'refs/heads/main', sha: 'a'.repeat(40) },
      images: Object.fromEntries(
        ['api', 'executor', 'proxy', 'web'].map((name, i) => [
          name,
          {
            repository: `registry.test/${name}`,
            digest: `sha256:${String(i + 1).repeat(64)}`,
          },
        ]),
      ),
      candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    }),
    { promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 } },
  );
  const calls = [],
    failure = Error('housekeeping observation failed');
  const gate = Object.assign(Object.create(ReusableProviderGate.prototype), {
    operation: { previous: manifest, candidate: manifest },
    currentManifest: manifest,
    config: { namespace: 'isolated', release: 'fixture' },
    values: () => ({}),
    resources: async () => [],
    deploymentSafety: () => ({}),
    artifact: async (name, contents) => {
      calls.push(['persist', name, contents]);
    },
    runRollout: async (options) => {
      await options.artifact('ha-rollout.json', 'exact journal');
      return { phase: 'complete' };
    },
  });
  await gate.roll(manifest.images, true, {
    artifact: async (...args) => {
      calls.push(['observe', ...args]);
    },
  });
  assert.deepEqual(
    calls.filter(([, name]) => name === 'ha-rollout.json'),
    [
      ['persist', 'ha-rollout.json', 'exact journal'],
      ['observe', 'ha-rollout.json', 'exact journal'],
    ],
  );
  const diagnostics = calls.filter(([, name]) => name !== 'ha-rollout.json');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0][0], 'persist', 'Timing must not be forwarded as an authoritative journal observation');
  assert.equal(diagnostics[0][1], 'ha-timing.json');
  assert.equal(JSON.parse(diagnostics[0][2]).version, 1);
  const applied = [];
  const originalRollout = gate.runRollout;
  const values = {
    autoscaling: {
      execution: { enabled: false, minReplicas: 2, maxReplicas: 7 },
      executionController: { enabled: true, suspended: false, pollSeconds: 15 },
      proxy: { enabled: true, minReplicas: 2, maxReplicas: 4, targetCPUUtilizationPercentage: 75 },
    },
  };
  gate.values = () => values;
  gate.resources = async () => [
    { kind: 'Deployment', metadata: { labels: { 'app.kubernetes.io/component': 'autoscaler' } } },
    { kind: 'HorizontalPodAutoscaler', metadata: { labels: { 'app.kubernetes.io/component': 'proxy' } } },
  ];
  gate.apply = async (value) => applied.push(value);
  gate.runRollout = async (options) => {
    await options.applyTemplates([], { autoscaling: { proxy: { minReplicas: 4, scaleDownPaused: true } } });
    await options.restoreAutoscalers([], {});
    return { phase: 'complete' };
  };
  await gate.roll(manifest.images, true);
  assert.deepEqual(applied[0].autoscaling.proxy, {
    ...values.autoscaling.proxy,
    minReplicas: 4,
    scaleDownPaused: true,
  });
  assert.deepEqual(applied[0].autoscaling.executionController, values.autoscaling.executionController);
  assert.deepEqual(applied[1].autoscaling, values.autoscaling, 'The final apply restores the original HPA policy');
  gate.runRollout = originalRollout;
  await assert.rejects(
    gate.roll(manifest.images, true, {
      artifact: async () => {
        throw failure;
      },
    }),
    (e) => e === failure,
  );
  let observed = false;
  gate.artifact = async () => {
    throw failure;
  };
  await assert.rejects(
    gate.roll(manifest.images, true, {
      artifact: async () => {
        observed = true;
      },
    }),
    (e) => e === failure,
  );
  assert.equal(observed, false);
});
