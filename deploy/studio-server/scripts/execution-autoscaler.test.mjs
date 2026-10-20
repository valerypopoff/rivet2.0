import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBackendRetirement } from '../images/api/backend-retirement.mjs';
import {
  autoscalerPolicy,
  autoscalerPolicyDigest,
  recommendExecutionReplicas,
  reconcileExecutionAutoscaling,
} from './lib/execution-autoscaler.mjs';
import { journalForReleaseOperation } from './lib/release-operation-journal.mjs';
import { assertRuntimeAutoscalingEvidence, HA_AUTOSCALING_CHECKS } from './lib/ha-release-evidence.mjs';

function fixture(replicas = 3) {
  let clock = 1000000,
    journal = null,
    version = 0,
    sequence = 0,
    startupFence = null;
  const policy = autoscalerPolicy({
    stabilizationSeconds: 30,
    cooldownSeconds: 10,
    pollSeconds: 10,
    withdrawalSeconds: 1,
  });
  const pod = (ordinal) => ({
    name: `exec-${ordinal}`,
    uid: `uid-${ordinal}-${sequence++}`,
    ordinal,
    incarnation: `inc-${ordinal}`,
    active: 0,
    limit: 10,
    cpuRatio: 0,
    sampleFresh: true,
    ready: true,
    state: 'serving',
    operationId: null,
  });
  const snapshot = { uid: 'sts', replicas, pods: Array.from({ length: replicas }, (_, i) => pod(i)) };
  const calls = [];
  const io = {
    fence: async (target) => {
      startupFence = target.name;
    },
    isFenced: async (target) => startupFence === target.name,
    fenceObserved: async (target) => startupFence === target.name,
    clearFence: async () => {
      startupFence = null;
    },
    confirmPeers: async () => {},
    confirmDrained: async (target) => {
      assert.equal(snapshot.pods.find((p) => p.uid === target.uid).state, 'drained');
    },
    readJournal: async () => structuredClone(journal),
    writeJournal: async (value, rv) => {
      assert.equal(rv, journal?.resourceVersion);
      journal = { ...structuredClone(value), resourceVersion: String(++version) };
      return structuredClone(journal);
    },
    snapshot: async () => structuredClone(snapshot),
    scale: async (uid, from, to) => {
      assert.equal(uid, snapshot.uid);
      assert.equal(from, snapshot.replicas);
      calls.push(['scale', from, to]);
      if (to > from) for (let i = from; i < to; i++) snapshot.pods.push(pod(i));
      else snapshot.pods = snapshot.pods.filter((p) => p.ordinal < to);
      snapshot.replicas = to;
    },
    retire: async (target, action) => {
      calls.push([action, target.uid]);
      const p = snapshot.pods.find((p) => p.uid === target.uid);
      p.operationId = target.operationId;
      p.state = action === 'withdraw' ? 'withdrawing' : 'draining';
      p.ready = false;
    },
    routed: async () => false,
    remove: async (target) => {
      calls.push(['delete', target.uid]);
      const index = snapshot.pods.findIndex((p) => p.uid === target.uid);
      snapshot.pods[index] = pod(snapshot.pods[index].ordinal);
    },
  };
  const tick = (extra = {}) =>
    reconcileExecutionAutoscaling({
      io,
      policy,
      release: 'rivet',
      namespace: 'rivet',
      runner: 'controller',
      manifestDigest: 'digest',
      now: () => clock,
      uuid: randomUUID,
      ...extra,
    });
  const advance = (seconds = 10) => {
    clock += seconds * 1000;
  };
  const withdraw = async () => {
    await tick();
    for (let i = 0; i < 4; i++) {
      advance();
      await tick();
    }
  };
  return {
    io,
    snapshot,
    policy,
    calls,
    tick,
    advance,
    now: () => clock,
    withdraw,
    journal: () => journal,
    setJournal: (value) => {
      journal = value;
    },
  };
}

test('policy rejects unsafe, fractional and incompatible bounds', () => {
  for (const value of [
    { minReplicas: 1 },
    { maxReplicas: 1 },
    { pollSeconds: 0 },
    { maxReplicas: 101 },
    { targetSlotsPercent: 95 },
    { targetCpuPercent: 101 },
    { cooldownSeconds: 1.5 },
    { stabilizationSeconds: 1 },
  ])
    assert.throws(() => autoscalerPolicy(value));
  assert.equal(autoscalerPolicyDigest({}), autoscalerPolicyDigest(autoscalerPolicy({})));
});

test('waiting LLM slots scale up even with zero CPU; CPU scales independently; caps apply', async () => {
  const f = fixture(2);
  f.snapshot.pods.forEach((p) => {
    p.active = 10;
  });
  assert.equal((await f.tick()).replicas, 4);
  assert.deepEqual(f.calls, [['scale', 2, 4]]);
  f.snapshot.pods.forEach((p) => {
    p.active = 0;
    p.cpuRatio = 2;
  });
  assert.equal((await f.tick()).replicas, 10);
  assert.equal(recommendExecutionReplicas(f.snapshot, f.policy), 10);
});

test('continuous low load withdraws only the highest ordinal; waits for routing, work and recording completion', async () => {
  const f = fixture();
  await f.withdraw();
  assert.equal(f.calls[0][0], 'withdraw');
  assert.equal(f.calls[0][1], f.snapshot.pods[2].uid);
  f.advance();
  f.io.routed = async () => true;
  assert.equal((await f.tick()).state, 'waiting-for-routing');
  f.io.routed = async () => false;
  assert.equal((await f.tick()).state, 'draining');
  for (let i = 0; i < 20; i++) {
    f.advance(1000);
    assert.equal((await f.tick()).state, 'waiting-for-work');
  }
  assert.equal(f.snapshot.replicas, 3);
  assert.equal(f.calls.length, 2);
  // This state is supplied by the existing accepted-work/recording drain owner,
  // not inferred from activeRuns==0 or a shutdown timer.
  f.snapshot.pods[2].state = 'drained';
  assert.equal((await f.tick()).state, 'scaled-down');
  assert.equal((await f.tick()).state, 'unfencing');
  assert.equal((await f.tick()).state, 'settled');
  assert.equal(f.snapshot.replicas, 2);
  assert.equal(f.journal().phase, 'complete');
  assert.ok(f.snapshot.pods.every((p) => p.ready));
});

test('traffic returning during a long drain adds capacity and replaces only the old interior UID', async () => {
  const f = fixture();
  await f.withdraw();
  f.advance();
  await f.tick();
  const old = f.snapshot.pods[2].uid;
  f.snapshot.pods.forEach((p) => {
    p.active = 10;
  });
  assert.equal((await f.tick()).state, 'scaled-up');
  assert.equal(f.snapshot.replicas, 6);
  f.snapshot.pods.forEach((p) => {
    p.active = 0;
  });
  f.snapshot.pods[2].state = 'drained';
  assert.equal((await f.tick()).state, 'replacing-drained-owner');
  assert.deepEqual(f.calls.at(-1), ['delete', old]);
  assert.equal(f.snapshot.replicas, 6);
  assert.equal((await f.tick()).state, 'unfencing');
  assert.equal((await f.tick()).state, 'settled');
});

test('no scale below the floor, no forced deletion while busy, and no deadline kills', async () => {
  const f = fixture(2);
  await f.withdraw();
  assert.equal(f.calls.length, 0);
  const g = fixture();
  await g.withdraw();
  g.advance();
  await g.tick();
  g.advance(86400);
  await g.tick();
  assert.equal(
    g.calls.some((c) => c[0] === 'delete'),
    false,
  );
});

test('stale/missing/invalid metrics and readiness gaps reset stabilization instead of becoming zero load', async () => {
  for (const change of [
    (p) => {
      p.sampleFresh = false;
    },
    (p) => {
      p.ready = false;
    },
    (p) => {
      p.cpuRatio = NaN;
    },
    (p) => {
      p.limit = 0;
    },
    (p) => {
      p.active = -1;
    },
    (p) => {
      p.terminating = true;
    },
  ]) {
    const f = fixture();
    await f.tick();
    f.advance();
    change(f.snapshot.pods[0]);
    await assert.rejects(f.tick());
    assert.equal(f.journal().lowSince, null);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await f.tick();
  f.advance(31);
  await f.tick();
  assert.equal(f.calls.length, 0);
});

test('foreign or unfinished deployment journals fence all autoscaling writes', async () => {
  const f = fixture();
  f.setJournal({
    protocol: 1,
    phase: 'owners',
    release: 'rivet',
    namespace: 'rivet',
    manifestDigest: 'old',
    token: 'other',
    runner: 'deployment',
    resourceVersion: '1',
    leaseExpiresAt: 0,
  });
  await assert.rejects(f.tick(), /ha operation owns/);
  assert.equal(f.calls.length, 0);
  assert.throws(() =>
    journalForReleaseOperation({ ...f.journal(), autoscalingProtocol: 1 }, 'ha', {
      release: 'rivet',
      namespace: 'rivet',
    }),
  );
});

test('completed autoscaling journal can transfer to release tooling; unfinished journal cannot', async () => {
  const f = fixture();
  await f.tick();
  assert.equal(
    journalForReleaseOperation(f.journal(), 'ha', { release: 'rivet', namespace: 'rivet' }, () => Infinity),
    null,
  );
  await f.withdraw();
  assert.throws(
    () => journalForReleaseOperation(f.journal(), 'cutover', { release: 'rivet', namespace: 'rivet' }, () => Infinity),
    /autoscaling operation owns/,
  );
});

test('restart observes the same owned retirement without issuing withdraw or begin twice', async () => {
  const f = fixture();
  await f.withdraw();
  f.advance();
  await f.tick({ runner: 'replacement' });
  await f.tick({ runner: 'replacement' });
  assert.equal(f.calls.filter((c) => c[0] === 'withdraw').length, 1);
  assert.equal(f.calls.filter((c) => c[0] === 'begin').length, 1);
  await assert.rejects(f.tick({ manifestDigest: 'different' }), /original image and policy/);
  await assert.rejects(f.tick({ policy: { ...f.policy, maxReplicas: 12 } }), /original image and policy/);
});

test('lost retirement acknowledgement is observed; an unsent/uncertain intent is not replayed', async () => {
  for (const sent of [true, false]) {
    const f = fixture();
    const real = f.io.retire;
    f.io.retire = async (...args) => {
      if (sent) await real(...args);
      throw new Error('connection reset');
    };
    await f.tick();
    for (let i = 0; i < 3; i++) {
      f.advance();
      await f.tick();
    }
    f.advance();
    await assert.rejects(f.tick(), /connection reset/);
    f.io.retire = real;
    f.advance();
    if (sent) assert.equal((await f.tick()).state, 'draining');
    else await assert.rejects(f.tick(), /intent is unconfirmed/);
    assert.equal(f.calls.filter((c) => c[0] === 'withdraw').length, sent ? 1 : 0);
  }
});

test('lost scale acknowledgement observes actual replicas; never replays ambiguous scale', async () => {
  for (const sent of [true, false]) {
    const f = fixture(2);
    f.snapshot.pods.forEach((p) => {
      p.active = 10;
    });
    const scale = f.io.scale;
    f.io.scale = async (...args) => {
      if (sent) await scale(...args);
      throw new Error('lost');
    };
    await assert.rejects(f.tick(), /lost/);
    f.io.scale = scale;
    if (sent) await f.tick();
    else await assert.rejects(f.tick(), /Scale intent is unconfirmed/);
    assert.equal(f.calls.length, sent ? 1 : 0);
  }
});

test('UID/incarnation changes and loss of serving peers fence an existing drain', async () => {
  for (const change of [
    (s) => {
      s.uid = 'different';
    },
    (s) => {
      s.pods[2].uid = 'new';
    },
    (s) => {
      s.pods[2].incarnation = 'new';
    },
    (s) => {
      s.pods[0].ready = false;
    },
  ]) {
    const f = fixture();
    await f.withdraw();
    change(f.snapshot);
    f.advance();
    await assert.rejects(f.tick());
    assert.equal(f.calls.length, 1);
  }
});

test('active foreign controller lease and failed CAS prevent execution mutations', async () => {
  const f = fixture();
  await f.tick();
  f.setJournal({ ...f.journal(), runner: 'other', leaseExpiresAt: 99999999 });
  assert.equal((await f.tick()).state, 'leased');
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.io.writeJournal = async () => {
    throw new Error('409');
  };
  await assert.rejects(g.tick(), /409/);
  assert.equal(g.calls.length, 0);
});

test('runtime autoscaling evidence is bound to exact source, images, chart and policy, never old HA receipts', () => {
  const release = {
    source: { sha: 'a'.repeat(40) },
    images: { api: 'pinned' },
    chart: { contentDigest: 'sha256:chart' },
  };
  const evidence = {
    protocol: 1,
    candidateSourceSha: release.source.sha,
    candidateImages: release.images,
    chartDigest: release.chart.contentDigest,
    policyDigest: 'b'.repeat(64),
    provider: 'gke',
    requestSamples: 100,
    failedRequests: 0,
    checks: [...HA_AUTOSCALING_CHECKS],
  };
  assert.doesNotThrow(() => assertRuntimeAutoscalingEvidence(evidence, release, evidence.policyDigest));
  for (const patch of [
    { candidateSourceSha: 'old' },
    { candidateImages: {} },
    { chartDigest: 'other' },
    { checks: [] },
    { provider: 'local' },
    { failedRequests: 1 },
  ])
    assert.throws(() => assertRuntimeAutoscalingEvidence({ ...evidence, ...patch }, release));
  assert.throws(() => assertRuntimeAutoscalingEvidence(evidence, release, 'c'.repeat(64)));
});

test('real supervisor retirement waits for both execution and recording durability, not the active counter', async () => {
  const f = fixture();
  const tail = f.snapshot.pods[2];
  let operationId = null,
    state = 'serving',
    runDone = false,
    recordingDone = false;
  const participant = {
    status: async () => ({
      protocol: 1,
      withdrawalProtocol: 1,
      incarnation: tail.incarnation,
      operationId,
      state: state === 'draining' && runDone && recordingDone ? 'drained' : state,
    }),
    withdraw: async (id) => {
      operationId = id;
      state = 'withdrawing';
      return participant.status();
    },
    begin: async (id) => {
      operationId = id;
      state = 'draining';
    },
  };
  let executorOperation = null;
  const executor = {
    status: async () => ({
      protocol: 1,
      incarnation: tail.incarnation,
      operationId: executorOperation,
      state: executorOperation ? 'drained' : 'serving',
    }),
    begin: async (id) => {
      executorOperation = id;
    },
  };
  const owner = createBackendRetirement({
    incarnation: tail.incarnation,
    api: participant,
    executor,
    available: () => true,
    wait: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  f.io.snapshot = async () => {
    Object.assign(tail, owner.snapshot(), { ready: owner.snapshot().state === 'serving' });
    return structuredClone(f.snapshot);
  };
  f.io.retire = async (target, action) => {
    f.calls.push([action, target.uid]);
    const result =
      action === 'withdraw'
        ? owner.withdraw(target.operationId, target.incarnation)
        : owner.begin(target.operationId, target.incarnation);
    if (action === 'withdraw') await owner.wait();
    return result;
  };
  try {
    await f.withdraw();
    f.advance();
    await f.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await f.tick()).state, 'waiting-for-work');
    runDone = true;
    tail.active = 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await f.tick()).state, 'waiting-for-work');
    assert.equal(f.snapshot.replicas, 3);
    recordingDone = true;
    await owner.wait();
    assert.equal((await f.tick()).state, 'scaled-down');
  } finally {
    runDone = true;
    recordingDone = true;
    await owner.wait();
  }
});

test('startup fencing must be observed before withdrawal and lost fence writes are never replayed', async () => {
  const f = fixture();
  await f.tick();
  for (let i = 0; i < 3; i++) {
    f.advance();
    await f.tick();
  }
  f.io.fenceObserved = async () => false;
  assert.equal((await f.tick()).state, 'waiting-for-startup-fence');
  assert.equal(f.calls.length, 0);
  f.io.isFenced = async () => false;
  await assert.rejects(f.tick(), /Startup-fence intent/);
  assert.equal(f.calls.length, 0);
});

test('shutdown after demand collection fences subsequent mutations, without leaving an active idle lease', async () => {
  const f = fixture(2);
  f.snapshot.pods.forEach((p) => {
    p.active = 10;
  });
  let stopping = false;
  const snapshot = f.io.snapshot;
  f.io.snapshot = async () => {
    const value = await snapshot();
    stopping = true;
    return value;
  };
  await assert.rejects(f.tick({ shouldStop: () => stopping }), /stopping/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.journal().phase, 'complete');
});

test('lost interior deletion acknowledgement is observed without deleting its replacement', async () => {
  const f = fixture();
  await f.withdraw();
  f.advance();
  await f.tick();
  f.snapshot.pods.forEach((p) => {
    p.active = 10;
  });
  await f.tick();
  f.snapshot.pods.forEach((p) => {
    p.active = 0;
  });
  f.snapshot.pods[2].state = 'drained';
  const remove = f.io.remove;
  f.io.remove = async (target) => {
    await remove(target);
    throw new Error('lost deletion acknowledgement');
  };
  await assert.rejects(f.tick(), /lost deletion/);
  f.io.remove = async () => {
    throw new Error('must not replay deletion');
  };
  assert.equal((await f.tick()).state, 'unfencing');
  assert.equal((await f.tick()).state, 'settled');
  assert.equal(f.calls.filter((c) => c[0] === 'delete').length, 1);
});

test('retirement completion requests only identity data, while a new decision always requests demand', async () => {
  const f = fixture();
  const requests = [],
    snapshot = f.io.snapshot;
  f.io.snapshot = async (options) => {
    requests.push(options);
    return snapshot();
  };
  await f.withdraw();
  f.advance();
  await f.tick();
  f.snapshot.pods[2].state = 'drained';
  await f.tick();
  await f.tick();
  await f.tick();
  assert.deepEqual(requests.slice(-2), [
    { demand: false, replacement: null },
    { demand: false, replacement: null },
  ]);
  await f.tick();
  assert.equal(requests.at(-1).demand, true);
});

test('non-contiguous or duplicate owner ordinals cannot become a scale-down target', async () => {
  for (const ordinal of [0, 5, -1, 1.5]) {
    const f = fixture();
    f.snapshot.pods[2].ordinal = ordinal;
    await assert.rejects(f.tick(), /demand or process identity/);
    assert.equal(f.calls.length, 0);
  }
});

test('a lost successful scale acknowledgement can settle without demanding unavailable load metrics', async () => {
  const f = fixture(2),
    scale = f.io.scale;
  f.snapshot.pods.forEach((p) => {
    p.active = 10;
  });
  f.io.scale = async (...args) => {
    await scale(...args);
    throw new Error('lost');
  };
  await assert.rejects(f.tick(), /lost/);
  const snapshot = f.io.snapshot;
  f.io.snapshot = async (options) => {
    assert.equal(options.demand, false);
    return snapshot();
  };
  assert.equal((await f.tick()).state, 'scale-observed');
  assert.equal(f.journal().phase, 'complete');
  assert.equal(f.calls.length, 1);
});

test('slow or ownership-changing peer checks cannot authorize a stale startup-fence write', async () => {
  for (const fault of ['expired', 'stolen', 'near-expiry']) {
    const f = fixture();
    let writes = 0;
    await f.tick();
    for (let i = 0; i < 2; i++) {
      f.advance();
      await f.tick();
    }
    f.io.confirmPeers = async () => {
      if (fault === 'stolen') f.setJournal({ ...f.journal(), runner: 'other', resourceVersion: 'foreign' });
      else f.advance(fault === 'expired' ? 121 : 110);
    };
    f.io.fence = async () => {
      writes++;
      if (fault === 'near-expiry') assert.ok(f.journal().leaseExpiresAt - f.now() >= 120000);
    };
    f.advance();
    if (fault === 'near-expiry') {
      assert.equal((await f.tick()).state, 'fencing');
      assert.equal(writes, 1);
    } else {
      await assert.rejects(f.tick(), /lease|ownership/i);
      assert.equal(writes, 0);
    }
  }
});

test('an interior replacement cannot clear its startup fence after peer inspection outlives the lease', async () => {
  const f = fixture();
  await f.withdraw();
  f.advance();
  await f.tick();
  f.snapshot.pods.forEach((p) => {
    p.active = 10;
  });
  await f.tick();
  f.snapshot.pods.forEach((p) => {
    p.active = 0;
  });
  f.snapshot.pods[2].state = 'drained';
  let clears = 0;
  f.io.confirmPeers = async () => {
    f.advance(121);
  };
  f.io.clearFence = async () => {
    clears++;
  };
  await assert.rejects(f.tick(), /lease|ownership/i);
  assert.equal(clears, 0);
  assert.equal(
    f.calls.some((call) => call[0] === 'delete'),
    false,
  );
});

test('a recreated tail cannot be mistaken for completed scale-down or have its template fence cleared', async () => {
  const f = fixture();
  await f.withdraw();
  f.advance();
  await f.tick();
  f.snapshot.pods[2].state = 'drained';
  const retired = structuredClone(f.snapshot.pods[2]);
  await f.tick();
  f.snapshot.pods.push({ ...retired, uid: 'unrecorded-replacement', ready: false });
  let clears = 0;
  f.io.clearFence = async () => {
    clears++;
  };
  await assert.rejects(f.tick(), /recreated|unconfirmed/);
  assert.equal(clears, 0);
  assert.equal(f.journal().phase, 'removing');
});
