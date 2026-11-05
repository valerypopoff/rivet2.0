import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHaWorkspaceSpace, HA_WORKSPACE_MIN_FREE_BYTES } from './lib/ha-workspace.mjs';
import { prepareHaKindRunner, UNUSED_HA_RUNNER_SDKS } from './prepare-ha-kind-runner.mjs';

const hosted = {
  platform: 'linux',
  env: { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Linux', RIVET_HA_RUNNER_ENVIRONMENT: 'github-hosted' },
};
const disk = (gib) => ({ bavail: gib * 1024 ** 3, bsize: 1 });

test('hosted Kind preparation removes only unused SDKs and measures the recovered space', async () => {
  const operations = [];
  const snapshots = [disk(18), disk(42)];
  const result = await prepareHaKindRunner({
    ...hosted,
    workspace: '/fixture/workspace',
    statfs: async (workspace) => {
      assert.equal(workspace, '/fixture/workspace');
      operations.push('observe');
      return snapshots.shift();
    },
    remove: async (paths) => {
      operations.push('remove');
      assert.deepEqual(paths, ['/usr/local/lib/android', '/usr/share/dotnet', '/opt/ghc']);
      assert.ok(Object.isFrozen(paths));
    },
    log: () => {},
  });
  assert.equal(result, 42 * 1024 ** 3);
  assert.deepEqual(operations, ['observe', 'remove', 'observe']);
  assert.equal(UNUSED_HA_RUNNER_SDKS.length, 3);
});

test('sufficient hosted workspace capacity skips unnecessary SDK deletion', async () => {
  let reads = 0;
  const available = await prepareHaKindRunner({
    ...hosted,
    statfs: async () => {
      reads++;
      return disk(22);
    },
    remove: async () => assert.fail('No deletion is needed above the capacity floor'),
    log: () => {},
  });
  assert.equal(available, 22 * 1024 ** 3);
  assert.equal(reads, 1);
});

test('a cleanup timeout permits preparation only after the unchanged capacity floor is freshly confirmed', async () => {
  for (const after of [24, 19]) {
    const snapshots = [disk(18), disk(after)];
    let removals = 0;
    const work = prepareHaKindRunner({
      ...hosted,
      statfs: async () => snapshots.shift(),
      remove: async () => {
        removals++;
        throw Object.assign(Error('SDK cleanup timeout'), { code: 'ETIMEDOUT' });
      },
      log: () => {},
    });
    if (after >= 20) assert.equal(await work, after * 1024 ** 3);
    else await assert.rejects(work, /20 GiB.*19.0 GiB/);
    assert.equal(removals, 1, 'Cleanup is never replayed');
    assert.equal(snapshots.length, 0, 'Capacity must be measured after the failed cleanup');
  }
});

test('local, self-hosted and non-Linux environments cannot run SDK cleanup', async () => {
  for (const change of [
    { platform: 'win32' },
    { env: {} },
    { env: { ...hosted.env, RUNNER_OS: 'Windows' } },
    { env: { ...hosted.env, RIVET_HA_RUNNER_ENVIRONMENT: 'self-hosted' } },
  ]) {
    await assert.rejects(
      prepareHaKindRunner({
        ...hosted,
        ...change,
        statfs: async () => assert.fail('Must reject before reading the host'),
        remove: async () => assert.fail('Must reject before any deletion'),
      }),
      /GitHub-hosted Linux/,
    );
  }
});

test('insufficient or unreadable disk remains a failure with the unchanged 20 GiB floor', async () => {
  assert.equal(HA_WORKSPACE_MIN_FREE_BYTES, 20 * 1024 ** 3);
  await assert.rejects(assertHaWorkspaceSpace('/fixture', { statfs: async () => disk(19) }), /20 GiB.*19.0 GiB/);
  await assert.rejects(
    assertHaWorkspaceSpace('/fixture', { statfs: async () => ({ bavail: NaN, bsize: 1 }) }),
    /20 GiB/,
  );
  const failure = Error('disk read failed');
  await assert.rejects(
    assertHaWorkspaceSpace('/fixture', {
      statfs: async () => {
        throw failure;
      },
    }),
    (e) => e === failure,
  );
});

test('failed cleanup or insufficient post-cleanup space stops without another removal attempt', async () => {
  for (const failure of [null, Error('cleanup denied')]) {
    let calls = 0;
    await assert.rejects(
      prepareHaKindRunner({
        ...hosted,
        statfs: async () => disk(18),
        remove: async () => {
          calls++;
          if (failure) throw failure;
        },
        log: () => {},
      }),
      failure ? (e) => e === failure : /20 GiB.*18.0 GiB/,
    );
    assert.equal(calls, 1);
  }
});
