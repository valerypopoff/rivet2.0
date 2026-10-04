import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalUpgradeSnapshotPlan } from './local-upgrade-snapshot-plan.mjs';

function fixture() {
  const api = {
    Name: '/ops-api-1',
    Image: 'sha256:' + 'a'.repeat(64),
    State: { Status: 'running' },
    Config: {
      Env: ['SECRET=must-not-appear'],
      Labels: { 'com.docker.compose.service': 'api', 'com.docker.compose.project': 'ops' },
    },
    Mounts: [
      { Type: 'bind', Source: '/home/operator/workflows', Destination: '/workflows' },
      { Type: 'bind', Source: '/home/operator/recordings', Destination: '/workflow-recordings' },
      {
        Type: 'volume',
        Name: 'ops_data',
        Source: '/var/lib/docker/volumes/ops_data/_data',
        Destination: '/data/rivet-app',
      },
      { Type: 'bind', Source: '/home/operator/libraries', Destination: '/data/runtime-libraries' },
    ],
  };
  const executor = {
    ...structuredClone(api),
    Name: '/ops-executor-1',
    Config: { ...api.Config, Labels: { ...api.Config.Labels, 'com.docker.compose.service': 'executor' } },
    Mounts: [api.Mounts[3], { ...api.Mounts[2], Destination: '/home/rivet/.local/share/com.valerypopoff.rivet2' }],
  };
  return { api, executor };
}
test('split VM discovery reports all authorities and both writers without secrets', () => {
  const { api, executor } = fixture();
  const report = createLocalUpgradeSnapshotPlan(api, executor);
  assert.equal(report.writers.length, 2);
  assert.equal(report.knownWritersStopped, false);
  assert.equal(Object.keys(report.roots).length, 4);
  assert.ok(!JSON.stringify(report).includes('must-not-appear'));
  api.State.Status = executor.State.Status = 'exited';
  assert.equal(createLocalUpgradeSnapshotPlan(api, executor).knownWritersStopped, true);
});
test('combined VM discovery still requires independent stopped-writer certification', () => {
  const { api } = fixture();
  assert.equal(createLocalUpgradeSnapshotPlan(api).knownWritersStopped, false);
});
test('selected backup discovery includes control without exposing environment secrets and refuses split or remapped authorities', () => {
  const { api, executor } = fixture();
  api.Mounts.push({
    Type: 'volume',
    Name: 'ops_control',
    Source: '/var/lib/docker/volumes/ops_control/_data',
    Destination: '/data/local-metadata',
  });
  api.Config.Env.push(
    'RIVET_LOCAL_METADATA_CONTROL_ROOT=/data/local-metadata',
    'RIVET_WORKFLOWS_ROOT=/workflows',
    'RIVET_WORKFLOW_RECORDINGS_ROOT=/workflow-recordings',
    'RIVET_APP_DATA_ROOT=/data/rivet-app',
    'RIVET_RUNTIME_LIBRARIES_ROOT=/data/runtime-libraries',
  );
  const report = createLocalUpgradeSnapshotPlan(api, undefined, { sqlite: true });
  assert.equal(Object.keys(report.roots).length, 5);
  assert.ok(!JSON.stringify(report).includes('SECRET'));
  api.Config.Env = api.Config.Env.map((value) =>
    value.startsWith('RIVET_LOCAL_METADATA_CONTROL_ROOT=') ? 'RIVET_LOCAL_METADATA_CONTROL_ROOT=' : value,
  );
  api.Config.Env.push('RIVET_LOCAL_METADATA_UI_ROOT=/data/local-metadata');
  assert.deepEqual(createLocalUpgradeSnapshotPlan(api, undefined, { sqlite: true }).roots, report.roots);
  api.Config.Env.push('RIVET_LOCAL_METADATA_UI_ROOT=/elsewhere');
  assert.throws(() => createLocalUpgradeSnapshotPlan(api, undefined, { sqlite: true }));
  api.Config.Env.pop();
  assert.throws(() => createLocalUpgradeSnapshotPlan(api, executor, { sqlite: true }));
  api.Config.Env.push('RIVET_WORKFLOWS_ROOT=/elsewhere');
  assert.throws(() => createLocalUpgradeSnapshotPlan(api, undefined, { sqlite: true }));
});
for (const [name, mutate] of [
  ['missing persistent root', (api) => api.Mounts.pop()],
  ['scratch authority', (api) => (api.Mounts[0].Type = 'tmpfs')],
  ['disguised filesystem root', (api) => (api.Mounts[0].Source = '/./')],
  ['overlapping roots', (api) => (api.Mounts[1].Source = api.Mounts[0].Source + '/recordings')],
  ['different executor volume', (_api, executor) => (executor.Mounts[1].Source = '/wrong')],
  ['duplicate executor authority', (_api, executor) => executor.Mounts.push({ ...executor.Mounts[1] })],
  ['scratch executor authority', (_api, executor) => (executor.Mounts[1].Type = 'tmpfs')],
  ['foreign executor', (_api, executor) => (executor.Config.Labels['com.docker.compose.project'] = 'production')],
])
  test(`snapshot discovery refuses ${name}`, () => {
    const { api, executor } = fixture();
    mutate(api, executor);
    assert.throws(() => createLocalUpgradeSnapshotPlan(api, executor));
  });
