import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blocksCutoverStop,
  assertOrdinaryReleaseAllowed,
  requiresMaintenanceCutover,
  runManagedReleaseCutover as runMaintenanceStrategy,
  maintenanceValidationValues,
} from './lib/managed-release-cutover.mjs';
import { fixtureDeploymentSafety } from './fixtures/deployment-safety.mjs';
const runManagedReleaseCutover = (options) =>
  runMaintenanceStrategy({
    ...options,
    safety:
      options.safety ??
      fixtureDeploymentSafety('maintenance', options, {
        baseline: options.assertInstalledBaseline,
        checkpoint: options.checkpoint,
      }),
  });

test('validation cannot recreate any autoscaler after closing maintenance admission', () => {
  for (const role of ['proxy', 'web', 'backend', 'execution'])
    assert.equal(maintenanceValidationValues.autoscaling[role].enabled, false, role);
});
test('temporary singleton validation does not claim the final GKE HA profile', () => {
  assert.equal(maintenanceValidationValues.workflowSchema.maintenanceValidation, true);
  assert.equal(maintenanceValidationValues.availability.gkeGateway, false);
  assert.equal(maintenanceValidationValues.replicaCount.proxy, 0);
  assert.equal(maintenanceValidationValues.replicaCount.web, 0);
  // Do not mutate the installation values: only the validation overlay changes.
  const installed = { availability: { gkeGateway: true }, ha: { enabled: true } };
  const validation = { ...installed, ...maintenanceValidationValues, ha: { enabled: false } };
  assert.equal(validation.availability.gkeGateway, false);
  assert.equal(installed.availability.gkeGateway, true);
  assert.equal(installed.ha.enabled, true);
});
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

test('a changed baseline aborts a fresh cutover without closing admission or stranding its journal', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      assertInstalledBaseline: async () => {
        throw new Error('installed version changed');
      },
    }),
    /aborted before workload changes/,
  );
  assert.deepEqual(state.operations, []);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.journal.abortedBeforeQuiescence, true);
  assert.equal(state.journal.leaseExpiresAt, 1000);
  await runManagedReleaseCutover(state.options);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.journal.abortedBeforeQuiescence, undefined);
  assert.ok(state.operations.includes('resume'));
});

test('a recovery baseline failure preserves its unfinished journal and never closes newly observed traffic', async () => {
  const state = fixture(() => true);
  await assert.rejects(runManagedReleaseCutover(state.options), /Cutover paused/);
  const token = state.journal.token;
  const count = state.operations.length;
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      resumeToken: token,
      assertInstalledBaseline: async () => {
        throw new Error('installed version changed');
      },
    }),
    /recovery baseline is unconfirmed/,
  );
  assert.equal(state.operations.length, count);
  assert.notEqual(state.journal.phase, 'complete');
  assert.equal(state.journal.token, token);
  assert.equal(state.journal.abortedBeforeQuiescence, undefined);
});

test('losing an untouched-abort acknowledgement never falls back to closing traffic', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      assertInstalledBaseline: async () => {
        throw Error('baseline changed');
      },
      replaceJournal: async (record, version) => {
        const saved = await state.options.replaceJournal(record, version);
        if (record.abortedBeforeQuiescence) throw Error('lost abort acknowledgement');
        return saved;
      },
    }),
    /recovery ownership is unconfirmed/,
  );
  assert.deepEqual(state.operations, []);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.journal.abortedBeforeQuiescence, true);
});

test('cutover recovery preserves its application baseline policy and values identity', async () => {
  let fail = true;
  const f = fixture(() => fail);
  const workflowIdentity = {
    operationId: 'workflow',
    policyDigest: 'sha256:' + 'a'.repeat(64),
    valuesDigest: 'sha256:' + 'b'.repeat(64),
    beforeVerified: true,
  };
  await assert.rejects(runManagedReleaseCutover({ ...f.options, workflowIdentity }), /Cutover paused/);
  await assert.rejects(
    runManagedReleaseCutover({
      ...f.options,
      workflowIdentity: { ...workflowIdentity, beforeVerified: false },
      resumeToken: f.journal.token,
    }),
    /original deployment safety contract/,
  );
  fail = false;
  await runManagedReleaseCutover({ ...f.options, workflowIdentity, resumeToken: f.journal.token });
  assert.equal(f.journal.phase, 'complete');
});

test('maintenance approval expiry is rechecked after slow inventory before acquiring ownership', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      admissionExpiresAt: 2_000,
      inventory: async () => {
        const inventory = await state.options.inventory();
        state.setTime(2_000);
        return inventory;
      },
    }),
    /admission deadline/,
  );
  assert.equal(state.journal, undefined);
  assert.deepEqual(state.operations, []);
});

test('malformed admission deadlines fail before reading or mutating the release', async () => {
  for (const admissionExpiresAt of [null, 0, -1, NaN, Infinity, '2000']) {
    const state = fixture();
    await assert.rejects(
      runManagedReleaseCutover({
        ...state.options,
        admissionExpiresAt,
        readJournal: async () => assert.fail('invalid approval must not read the release'),
      }),
      /admission deadline/,
    );
    assert.equal(state.journal, undefined);
    assert.deepEqual(state.operations, []);
  }
});

test('an admitted operation and its exact-token recovery can finish after admission expiry', async () => {
  let fail = true;
  const state = fixture(() => fail);
  const options = {
    ...state.options,
    admissionExpiresAt: 2_000,
    waitForStopped: async () => {
      state.setTime(3_000);
      await state.options.waitForStopped();
    },
  };
  await assert.rejects(runManagedReleaseCutover(options), /Cutover paused/);
  const token = state.journal.token;
  fail = false;
  await runManagedReleaseCutover({ ...options, resumeToken: token });
  assert.equal(state.journal.phase, 'complete');
  await assert.rejects(runManagedReleaseCutover(options), /admission deadline/);
});

test('same-layout maintenance stops fenced validation owners before reopening OnDelete workloads', async () => {
  const state = fixture();
  await runManagedReleaseCutover({ ...state.options, stopValidationBeforeResume: true });
  assert.deepEqual(state.operations, [
    'hpa:off',
    'scale:0',
    'stopped',
    'install',
    'validated',
    'hpa:off',
    'scale:0',
    'stopped',
    'resume',
  ]);
  assert.equal(state.journal.phase, 'complete');
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
    /does not belong/,
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

test('lost completion acknowledgement after final apply never closes healthy traffic again', async () => {
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
  await assert.rejects(runManagedReleaseCutover({ ...state.options, replaceJournal }), /--acceptance-only/);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.operations.at(-1), 'resume');
  assert.equal(state.journal.finalApply.protocol, 1);
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

test('a quiesced checkpoint precedes installation and settlement completes before the journal', async () => {
  const state = fixture();
  const operationPlanDigest = 'sha256:' + 'a'.repeat(64);
  const contexts = [];
  await runManagedReleaseCutover({
    ...state.options,
    operationPlanDigest,
    checkpoint: async (context) => {
      contexts.push(context);
      assert.equal(state.journal.phase, 'quiesced');
      state.operations.push('checkpoint');
      context.token = 'modified-copy';
    },
    settle: async (context) => {
      contexts.push(context);
      assert.equal(state.journal.phase, 'resuming');
      assert.notEqual(context.token, 'modified-copy');
      state.operations.push('settled');
    },
  });
  assert.deepEqual(state.operations, [
    'hpa:off',
    'scale:0',
    'stopped',
    'checkpoint',
    'install',
    'validated',
    'resume',
    'settled',
  ]);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.journal.operationPlanDigest, operationPlanDigest);
  assert.equal(contexts[1].operationPlanDigest, operationPlanDigest);
  assert.equal(Object.hasOwn(contexts[1], 'workloads'), false);
});

test('failed final observation leaves traffic active and supports exact verification-only completion', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      settle: async () => {
        state.operations.push('settlement-failed');
        throw new Error('old owners remain');
      },
    }),
    /--verify-only/,
  );
  assert.equal(state.journal.phase, 'resuming');
  assert.deepEqual(state.operations.slice(-2), ['resume', 'settlement-failed']);
  const before = [...state.operations];
  await runManagedReleaseCutover({
    ...state.options,
    resumeToken: state.journal.token,
    verificationOnly: true,
    verifyExisting: async () => state.operations.push('verify'),
  });
  assert.deepEqual(state.operations, [...before, 'verify']);
  assert.equal(state.journal.phase, 'complete');
  assert.equal(state.journal.verificationOnlyRecovery, true);
});

test('verification-only recovery refuses an unconfirmed final apply and never runs mutation callbacks', async () => {
  const state = fixture(() => true);
  await assert.rejects(runManagedReleaseCutover(state.options), /Cutover paused/);
  const before = [...state.operations];
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      resumeToken: state.journal.token,
      verificationOnly: true,
      verifyExisting: async () => {
        throw Error('must not run');
      },
    }),
    /confirmed final apply/,
  );
  assert.deepEqual(state.operations, before);
});

test('failed frozen checkpoint prevents candidate installation and retains exact-plan recovery', async () => {
  const state = fixture();
  const operationPlanDigest = 'sha256:' + 'a'.repeat(64);
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      operationPlanDigest,
      checkpoint: async () => {
        throw new Error('backup verification failed');
      },
    }),
    /Cutover paused/,
  );
  assert.equal(state.operations.includes('install'), false);
  assert.equal(state.journal.phase, 'quiesced');
  for (const digest of [undefined, 'sha256:' + 'b'.repeat(64)]) {
    const previous = [...state.operations];
    await assert.rejects(
      runManagedReleaseCutover({ ...state.options, operationPlanDigest: digest, resumeToken: state.journal.token }),
      /exact manifest and operation plan/,
    );
    assert.deepEqual(state.operations, previous);
  }
  await runManagedReleaseCutover({ ...state.options, operationPlanDigest, resumeToken: state.journal.token });
  assert.equal(state.journal.phase, 'complete');
});

test('legacy recovery does not silently adopt a new operation plan', async () => {
  const state = fixture(() => true);
  await assert.rejects(runManagedReleaseCutover(state.options), /Cutover paused/);
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      resumeToken: state.journal.token,
      operationPlanDigest: 'sha256:' + 'a'.repeat(64),
    }),
    /exact manifest and operation plan/,
  );
});

test('lease expiration during settlement cannot produce a completion acknowledgement', async () => {
  const state = fixture();
  await assert.rejects(
    runManagedReleaseCutover({
      ...state.options,
      settle: async () => {
        state.setTime(200_000);
      },
    }),
    /verification is incomplete/,
  );
  assert.equal(state.journal.phase, 'resuming');
});

test('malformed operation plan digests fail before recording ownership', async () => {
  const state = fixture();
  await assert.rejects(runManagedReleaseCutover({ ...state.options, operationPlanDigest: 'not-a-digest' }), /SHA-256/);
  assert.equal(state.journal, undefined);
  assert.deepEqual(state.operations, []);
});
