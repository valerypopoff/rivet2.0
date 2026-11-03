import test from 'node:test';
import assert from 'node:assert/strict';
import { ManagedReleaseGate } from './kubernetes-managed-release-gate.mjs';

test('node-drain recovery reconnects its test tunnel before checking real workflow recovery', async () => {
  const gate = new ManagedReleaseGate({ release: 'fixture', namespace: 'fixture' });
  const events = [];
  let forwards = 0;
  gate.openProxy = async () => {
    events.push('forward');
    return `http://fixture-${++forwards}`;
  };
  gate.kubectl = async (args) => {
    if (args[0] === 'get')
      return {
        stdout: JSON.stringify({
          items: [0, 1].map((i) => ({
            spec: { nodeName: `node-${i}` },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          })),
        }),
      };
    events.push(args[0]);
    return { stdout: '' };
  };
  gate.requestWorkflow = async (url) => {
    events.push(url);
    return {};
  };
  await gate.disruptionChecks();
  assert.deepEqual(events.slice(-5), ['drain', 'rollout', 'forward', 'http://fixture-2', 'uncordon']);
  assert.equal(forwards, 2);
});

test('a failed reconnect retains the failed result and still uncordons the exact drained node', async () => {
  const gate = new ManagedReleaseGate({ release: 'fixture', namespace: 'fixture' });
  let forwards = 0,
    uncordoned;
  gate.openProxy = async () => {
    if (++forwards === 2) throw Error('tunnel failed');
    return 'http://fixture';
  };
  gate.requestWorkflow = async () => ({});
  gate.kubectl = async (args) => {
    if (args[0] === 'get')
      return {
        stdout: JSON.stringify({
          items: [0, 1].map((i) => ({
            spec: { nodeName: `node-${i}` },
            status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
          })),
        }),
      };
    if (args[0] === 'uncordon') uncordoned = args[1];
    return { stdout: '' };
  };
  await assert.rejects(gate.disruptionChecks(), /tunnel failed/);
  assert.equal(uncordoned, 'node-0');
});
