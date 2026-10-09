import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassifierEvaluateNodeImpl, ClassifierProfileNodeImpl, type NodeConnection } from '@valerypopoff/rivet2-core';
import { extractClassifierConfigurationToProfile } from './extractClassifierProfile.js';

test('Classifier extraction moves active model/key wires and midpoints, but not evidence or output settings', () => {
  const evaluate = ClassifierEvaluateNodeImpl.create();
  Object.assign(evaluate.data, {
    provider: 'liquid',
    useModelInput: true,
    apiKeySource: 'input',
    timeoutMs: 90_000,
    outputRequestBody: true,
    retryOnNon200: true,
  });
  const profile = ClassifierProfileNodeImpl.create();
  const wire = (inputId: string): NodeConnection => ({
    inputNodeId: evaluate.id,
    inputId: inputId as never,
    outputNodeId: `source-${inputId}` as never,
    outputId: 'output' as never,
    bendPoint: { x: 123, y: 456 },
  });
  const connections = ['model', 'apiKey', 'state', 'question1'].map(wire);
  const before = structuredClone({ evaluate, profile, connections });
  const result = extractClassifierConfigurationToProfile({
    evaluateNode: evaluate,
    profileNode: profile,
    connections,
    recoverableConnections: [wire('apiKey'), wire('state')],
  });
  assert.equal(result.evaluateNode.data.configurationMode, 'profile');
  assert.equal(result.profileNode.data.provider, 'liquid');
  assert.equal(result.profileNode.data.responseTimeoutMs, 90_000);
  assert.ok(!('outputRequestBody' in result.profileNode.data));
  assert.ok(!('retryOnNon200' in result.profileNode.data));
  for (const port of ['model', 'apiKey']) {
    const moved = result.connections.find((connection) => connection.inputId === port)!;
    assert.equal(moved.inputNodeId, profile.id);
    assert.deepEqual(moved.bendPoint, { x: 123, y: 456 });
  }
  for (const port of ['state', 'question1'])
    assert.equal(result.connections.find((connection) => connection.inputId === port)!.inputNodeId, evaluate.id);
  assert.equal(result.connections.at(-1)!.inputId, 'classifierProfile');
  assert.equal(result.profileRecoverableConnections[0]!.inputId, 'apiKey');
  assert.equal(result.evaluateRecoverableConnections[0]!.inputId, 'state');
  assert.deepEqual({ evaluate, profile, connections }, before);
  assert.throws(
    () =>
      extractClassifierConfigurationToProfile({
        ...before,
        evaluateNode: result.evaluateNode,
        profileNode: profile,
        recoverableConnections: [],
      } as any),
    /already uses/,
  );
});
