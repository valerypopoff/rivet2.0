import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blocksCutoverStop,
  assertOrdinaryReleaseAllowed,
  requiresMaintenanceCutover,
  runManagedReleaseCutover,
} from './lib/managed-release-cutover.mjs';
function fixture(failure) {
  let journal;
  let time = 1000;
  let id = 0;
  const operations = [];
  const options = {
    release: 'test',
    namespace: 'fixture',
    manifestDigest: 'candidate',
    now: () => time,
    uuid: () => `id-${++id}`,
    inventory: async () => ({
      workloads: [{ kind: 'deployment', name: 'execution', component: 'execution', replicas: 2 }],
      autoscalers: ['execution'],
    }),
    readJournal: async () => journal && structuredClone(journal),
    createJournal: async (record) => {
      assert.equal(journal, undefined);
      return (journal = { ...record, resourceVersion: '1' });
    },
    replaceJournal: async (record, version) => {
      assert.equal(version, journal.resourceVersion);
      return (journal = { ...record, resourceVersion: String(Number(version) + 1) });
    },
    scale: async (_item, replicas) => operations.push(`scale:${replicas}`),
    removeAutoscaler: async () => operations.push('hpa:off'),
    waitForStopped: async () => operations.push('stopped'),
    installValidation: async () => {
      operations.push('install');
      if (failure?.()) throw new Error('lost acknowledgement');
    },
    validate: async () => operations.push('validated'),
    resume: async () => operations.push('resume'),
  };
  return {
    options,
    operations,
    get journal() {
      return journal;
    },
    setTime: (value) => {
      time = value;
    },
  };
}
test('incompatible and unknown installed readers require explicit maintenance, bootstrap does not', () => {
  const candidate = { database: { managedWorkflowSchema: { minimumRollbackCompatibleVersion: 15 } } };
  assert.equal(requiresMaintenanceCutover(candidate, null), false);
  assert.equal(requiresMaintenanceCutover(candidate, {}), true);
  assert.equal(
    requiresMaintenanceCutover(candidate, {
      release: { production: { database: { managedWorkflowSchemaVersion: 14 } } },
    }),
    true,
  );
  assert.equal(
    requiresMaintenanceCutover(candidate, {
      release: { production: { database: { managedWorkflowSchemaVersion: 15 } } },
    }),
    false,
  );
});
test('cutover records ownership before stopping controllers, validates before reopening, and completes durably', async () => {
  const state = fixture();
  await runManagedReleaseCutover(state.options);
  assert.deepEqual(state.operations, ['hpa:off', 'scale:0', 'stopped', 'install', 'validated', 'resume']);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.journal.leaseExpiresAt, 1000);
});
test('lost acknowledgement never resumes; exact-token recovery repeats paused validation', async () => {
  let fail = true;
  const state = fixture(() => fail);
  await assert.rejects(runManagedReleaseCutover(state.options), /Cutover paused/);
  assert.equal(state.operations.includes('resume'), false);
  assert.equal(state.journal.phase, 'validating');
  await assert.rejects(runManagedReleaseCutover(state.options), /unfinished cutover/);
  await assert.rejects(
    runManagedReleaseCutover({ ...state.options, resumeToken: state.journal.token, manifestDigest: 'different' }),
    /unfinished cutover/,
  );
  fail = false;
  await runManagedReleaseCutover({ ...state.options, resumeToken: state.journal.token });
  assert.equal(state.journal.phase, 'complete');
});

test('unknown resources are rejected before changing cluster state; ingress stops first', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      inventory: async () => ({
        workloads: [{ kind: 'deployment', name: 'other', component: 'unknown', replicas: 1 }],
        autoscalers: [],
      }),
    }),
    /Unknown release workload/,
  );
  assert.equal(state.journal, undefined);
  const order = [];
  await runManagedReleaseCutover({
    ...state.options,
    inventory: async () => ({
      workloads: [
        { kind: 'deployment', name: 'execution', component: 'execution', replicas: 1 },
        { kind: 'deployment', name: 'proxy', component: 'proxy', replicas: 1 },
      ],
      autoscalers: [],
    }),
    scale: async (item) => order.push(item.name),
  });
  assert.deepEqual(order, ['proxy', 'execution']);
});

test('invalid recovery journal is rejected without workload changes', async () => {
  const state = fixture(() => true);
  await assert.rejects(runManagedReleaseCutover(state.options), /Cutover paused/);
  const count = state.operations.length;
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      resumeToken: state.journal.token,
      readJournal: async () => ({ ...state.journal, leaseExpiresAt: 'not-a-time' }),
    }),
    /identity or format/,
  );
  assert.equal(state.operations.length, count);
});

test('a lost final resume acknowledgement closes admission and leaves durable recovery ownership', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      resume: async () => {
        throw new Error('lost resume acknowledgement');
      },
    }),
    /Cutover paused/,
  );
  assert.equal(state.journal.phase, 'resuming');
  assert.deepEqual(state.operations.slice(-2), ['hpa:off', 'scale:0']);
});

test('terminal old migration hooks do not deadlock recovery; active hooks and all reader pods still block', () => {
  const pod = (component, phase) => ({
    metadata: { labels: { 'app.kubernetes.io/component': component } },
    status: { phase },
  });
  for (const phase of ['Succeeded', 'Failed'])
    assert.equal(blocksCutoverStop(pod('workflow-schema-migration', phase)), false);
  assert.equal(blocksCutoverStop(pod('workflow-schema-migration', 'Running')), true);
  assert.equal(blocksCutoverStop(pod('backend', 'Failed')), true);
  assert.equal(blocksCutoverStop({}), true);
});

test('lost completion acknowledgement cannot leave paused traffic behind a completed journal', async () => {
  const state = fixture();
  let loseOnce = true;
  const replaceJournal = async (record, version) => {
    const saved = await state.options.replaceJournal(record, version);
    if (record.phase === 'complete' && loseOnce) {
      loseOnce = false;
      throw new Error('lost completion acknowledgement');
    }
    return saved;
  };
  await assert.rejects(runManagedReleaseCutover({ ...state.options, replaceJournal }), /Cutover paused/);
  assert.equal(state.journal.phase, 'resuming');
  assert.deepEqual(state.operations.slice(-2), ['hpa:off', 'scale:0']);
  await runManagedReleaseCutover({ ...state.options, replaceJournal, resumeToken: state.journal.token });
  assert.equal(state.journal.phase, 'complete');
});

test('ordinary releases validate completed journals and wait for the owning runner to finish', async () => {
  const state = fixture();
  const identity = { release: 'test', namespace: 'fixture' };
  assertOrdinaryReleaseAllowed(null, identity, () => 1000);
  await runManagedReleaseCutover(state.options);
  assertOrdinaryReleaseAllowed(state.journal, identity, () => 1000);
  for (const invalid of [
    { formatVersion: 2 },
    { release: 'other' },
    { namespace: 'other' },
    { manifestDigest: '' },
    { resourceVersion: '' },
    { leaseExpiresAt: 'invalid' },
  ])
    assert.throws(
      () => assertOrdinaryReleaseAllowed({ ...state.journal, ...invalid }, identity, () => 1000),
      /identity or format/,
    );
  const owned = { ...state.journal, leaseExpiresAt: 2000 };
  assert.throws(() => assertOrdinaryReleaseAllowed(owned, identity, () => 1000), /still owns/);
  await assert.rejects(runManagedReleaseCutover({ ...state.options, readJournal: async () => owned }), /still owns/);
  assert.throws(
    () => assertOrdinaryReleaseAllowed({ ...state.journal, phase: 'resuming' }, identity, () => 1000),
    /unfinished cutover/,
  );
});

test('lease loss during quiescing fences subsequent workload mutations', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      removeAutoscaler: async () => {
        state.operations.push('hpa:off');
        state.setTime(200_000);
      },
    }),
    /closing admission is unconfirmed/,
  );
  assert.deepEqual(state.operations, ['hpa:off']);
  assert.equal(state.journal.phase, 'quiescing');
});

test('a late heartbeat is settled before lost-completion cleanup changes the journal', async () => {
  const state = fixture();
  let tick;
  let releaseRenewal;
  let renewalStarted;
  const started = new Promise((resolve) => {
    renewalStarted = resolve;
  });
  const gate = new Promise((resolve) => {
    releaseRenewal = resolve;
  });
  let delayRenewal = false;
  let cleared = false;
  const replaceJournal = async (record, version) => {
    if (delayRenewal) {
      delayRenewal = false;
      renewalStarted();
      await gate;
    }
    return state.options.replaceJournal(record, version);
  };
  const running = runManagedReleaseCutover({
    ...state.options,
    replaceJournal,
    setHeartbeat: (callback) => {
      tick = callback;
      return {};
    },
    clearHeartbeat: () => {
      cleared = true;
    },
    resume: async () => {
      delayRenewal = true;
      tick();
      await started;
      throw new Error('lost resume acknowledgement');
    },
  });
  const rejected = assert.rejects(running, /Cutover paused/);
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared, true);
  assert.notDeepEqual(state.operations.slice(-2), ['hpa:off', 'scale:0'], 'cleanup waits for the in-flight CAS');
  releaseRenewal();
  await rejected;
  assert.deepEqual(state.operations.slice(-2), ['hpa:off', 'scale:0']);
  assert.equal(state.journal.phase, 'resuming');
  await runManagedReleaseCutover({ ...state.options, resumeToken: state.journal.token });
  assert.equal(state.journal.phase, 'complete');
});

test('failed lease renewal never resumes or mutates workloads during cleanup', async () => {
  const state = fixture();
  let tick;
  let failRenewal = false;
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      setHeartbeat: (callback) => {
        tick = callback;
        return {};
      },
      clearHeartbeat: () => {},
      replaceJournal: (record, version) => {
        if (failRenewal) throw new Error('renewal ownership unknown');
        return state.options.replaceJournal(record, version);
      },
      validate: async () => {
        state.operations.push('validated');
        failRenewal = true;
        tick();
        await new Promise((resolve) => setImmediate(resolve));
      },
    }),
    /closing admission is unconfirmed/,
  );
  assert.deepEqual(state.operations, ['hpa:off', 'scale:0', 'stopped', 'install', 'validated']);
  assert.equal(state.journal.phase, 'validating');
});

test('lost ownership-create acknowledgement reports its token and changes no workloads', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      createJournal: async (record) => {
        await state.options.createJournal(record);
        throw new Error('lost create acknowledgement');
      },
    }),
    /ownership write is unconfirmed.*journal token id-2/,
  );
  assert.deepEqual(state.operations, []);
  assert.equal(state.journal.phase, 'quiescing');
  state.setTime(200_000);
  await runManagedReleaseCutover({ ...state.options, resumeToken: state.journal.token });
  assert.equal(state.journal.phase, 'complete');
});

test('a long operation cannot silently renew an expired lease and resume traffic', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      validate: async () => {
        state.operations.push('validated');
        state.setTime(200_000);
      },
    }),
    /closing admission is unconfirmed/,
  );
  assert.equal(state.operations.includes('resume'), false);
  assert.equal(state.journal.phase, 'validating');
  await runManagedReleaseCutover({ ...state.options, resumeToken: state.journal.token });
  assert.equal(state.journal.phase, 'complete');
});
