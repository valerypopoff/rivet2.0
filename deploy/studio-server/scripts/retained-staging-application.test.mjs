import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, settings, operation, actor } from './test-fixtures/reusable-staging.mjs';
import { ReusableStagingState, reusableStagingSettings } from './lib/reusable-staging-state.mjs';
import { qualificationHash } from './lib/runtime-qualification-execution.mjs';
import { cleanupStaging } from './lib/reusable-staging-cleanup.mjs';
import { fileURLToPath } from 'node:url';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';
import {
  settleRetainedStaging,
  cleanupRetainedStaging,
  verifyRetainedStagingCleanup,
} from './lib/retained-staging-cleanup.mjs';

const previous = 'sha256:' + 'a'.repeat(64),
  candidate = 'sha256:' + 'b'.repeat(64);
async function retained(t) {
  const f = await fixture(t);
  const configuration = reusableStagingSettings({
    ...settings(),
    qualificationSuite: 'focused',
    hostname: 'retained.qualification.example.test',
    retainedApplication: {
      protocol: 1,
      namespace: 'rivet-staging-persistent',
      recordName: 'rivet-staging-application',
    },
  });
  const make = (id, predecessor = previous, releases = {}) => {
    const { inputHash: _hash, ...original } = operation();
    const input = {
      ...original,
      operationId: id,
      retainedApplication: configuration.retainedApplication,
      predecessorManifestDigest: predecessor,
      candidateManifestDigest: candidate,
      ...releases,
    };
    return new ReusableStagingState(f.api, configuration, { ...input, inputHash: qualificationHash(input) });
  };
  return { ...f, make, state: make('rivet-q-123-1') };
}

async function publishedApplication(t) {
  const f = await retained(t);
  const tested = createStudioServerReleaseManifest({
    rootDir: fileURLToPath(new URL('../../../', import.meta.url)),
    source: { repository: 'example/rivet', ref: 'refs/heads/main', sha: 'a'.repeat(40) },
    images: Object.fromEntries(
      ['api', 'web', 'proxy', 'executor'].map((name) => [
        name,
        {
          repository: `registry.test/${name}`,
          digest: `sha256:${'c'.repeat(64)}`,
        },
      ]),
    ),
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    createdAt: '2026-11-05T12:00:00.000Z',
  });
  const published = promoteStudioServerReleaseManifest(tested, {
    promotionEvidence: { workflow: 'Publish qualified exact release', runId: '124', runAttempt: 1 },
    promotedAt: '2026-11-05T13:00:00.000Z',
  });
  const testedDigest = getStudioServerReleaseManifestDigest(tested),
    publishedDigest = getStudioServerReleaseManifestDigest(published);
  assert.notEqual(testedDigest, publishedDigest);
  const state = f.make('rivet-q-123-1', previous, { candidate: tested, candidateManifestDigest: testedDigest });
  await state.arm(actor);
  const namespace = await state.namespace({ create: true });
  await state.application.finish({ healthy: true, dataCleaned: true, manifestDigest: testedDigest });
  await state.change((record) => {
    record.closed = true;
    record.phase = 'cleaned';
    record.cleanupVerified = true;
  });
  return { f, tested, published, publishedDigest, state, namespace };
}

test('the next release reuses the tested application after publication changes its manifest digest', async (t) => {
  const { f, tested, published, publishedDigest, namespace } = await publishedApplication(t);
  const next = f.make('rivet-q-124-1', publishedDigest, { previous: published });
  await next.arm(actor);
  assert.equal((await next.namespace()).metadata.uid, namespace.metadata.uid);
  assert.deepEqual((await next.read()).record.retainedApplication.predecessorManifest, tested);
  // An image, schema, source, chart, lineage or original build change is a
  // different application, even when publication metadata also changed.
});

for (const [name, mutate] of [
  [
    'image',
    (m) => {
      m.images.api.digest = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'chart',
    (m) => {
      m.chart.contentDigest = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'source',
    (m) => {
      m.source.sha = 'd'.repeat(40);
    },
  ],
  [
    'schema',
    (m) => {
      m.database.managedWorkflowSchema.version++;
    },
  ],
  [
    'original build',
    (m) => {
      m.evidence.candidate.runId = '999';
    },
  ],
])
  test(`publication cannot hide a changed retained application ${name}`, async (t) => {
    const { f, published } = await publishedApplication(t);
    const changed = structuredClone(published);
    mutate(changed);
    const rejected = f.make('rivet-q-124-1', getStudioServerReleaseManifestDigest(changed), { previous: changed });
    await assert.rejects(rejected.arm(actor), /differs from installed production/);
  });

test('lost acquisition bookkeeping recovers the same publication-bound predecessor without acquiring again', async (t) => {
  const { f, tested, published, publishedDigest } = await publishedApplication(t);
  const next = f.make('rivet-q-124-1', publishedDigest, { previous: published });
  const json = f.api.json.bind(f.api);
  f.api.json = async (method, url, body) => {
    if (method === 'PUT' && url.endsWith('/rivet-q-124-1') && JSON.parse(body.data.record).retainedApplication)
      throw Error('acquisition bookkeeping interrupted');
    return json(method, url, body);
  };
  await assert.rejects(next.arm(actor), /bookkeeping interrupted/);
  f.api.json = json;
  const recovered = new ReusableStagingState(f.api, next.settings, next.operation);
  assert.equal(await recovered.application.reconcileAcquisition(), true);
  assert.deepEqual((await recovered.read()).record.retainedApplication.predecessorManifest, tested);
  assert.equal((await recovered.application.owned()).record.owner.operationId, next.operation.operationId);
});

test('success retains namespace identity and admits only the exact next production predecessor', async (t) => {
  const f = await retained(t),
    state = f.state;
  await state.arm(actor);
  const namespace = await state.namespace({ create: true });
  await state.application.finish({ healthy: true, dataCleaned: true, manifestDigest: candidate });
  await state.change((record) => {
    record.closed = true;
    record.phase = 'cleaned';
    record.cleanupVerified = true;
  });
  const next = f.make('rivet-q-124-1', candidate);
  await next.arm(actor);
  assert.equal((await next.namespace()).metadata.uid, namespace.metadata.uid);
  assert.equal((await next.read()).record.retainedApplication.bootstrap, false);
  assert.equal(
    f.requests.filter((request) => request.method === 'POST' && request.pathname === '/api/v1/namespaces').length,
    1,
  );
  await assert.rejects(cleanupStaging(next, actor), /must never be deleted/);
  assert.equal(
    f.requests.some((request) => request.method === 'DELETE'),
    false,
  );
});

test('busy and quarantined applications are never automatically reset', async (t) => {
  const f = await retained(t);
  await f.state.arm(actor);
  await f.state.namespace({ create: true });
  await assert.rejects(f.make('rivet-q-124-1').arm(actor), /busy or quarantined/);
  await f.state.application.finish({ healthy: false, dataCleaned: false, manifestDigest: candidate });
  await assert.rejects(f.make('rivet-q-125-1').arm(actor), /busy or quarantined/);
  assert.equal(
    f.requests.some((request) => request.method === 'DELETE'),
    false,
  );
});

test('a healthy staging candidate ahead of production is not silently downgraded', async (t) => {
  const f = await retained(t);
  await f.state.arm(actor);
  await f.state.namespace({ create: true });
  await f.state.application.finish({ healthy: true, dataCleaned: true, manifestDigest: candidate });
  await f.state.change((record) => {
    record.closed = true;
    record.phase = 'cleaned';
    record.cleanupVerified = true;
  });
  await assert.rejects(f.make('rivet-q-124-1', previous).arm(actor), /differs from installed production/);
  assert.equal((await f.state.application.read()).record.phase, 'idle');
  assert.equal(
    f.requests.some((request) => request.method === 'DELETE'),
    false,
  );
});

test('an expired/failed test without accepted fixtures quarantines safely and preserves the entire application', async (t) => {
  const f = await retained(t);
  await f.state.arm(actor);
  const namespace = await f.state.namespace({ create: true });
  const wait = async (_label, check) => {
    assert.ok(await check());
  };
  await settleRetainedStaging(f.state, actor, wait);
  const receipt = await cleanupRetainedStaging(f.state, null, actor);
  assert.equal(receipt.phase, 'quarantined');
  const verified = await verifyRetainedStagingCleanup(f.state);
  assert.equal(verified.retainedApplication.namespaceUid, namespace.metadata.uid);
  assert.equal(verified.retainedApplication.dataCleaned, false);
  assert.equal(verified.resources.length, 0);
  assert.equal(
    f.requests.some((request) => request.method === 'DELETE'),
    false,
  );
});

test('replaced retained namespace blocks further fixture admission', async (t) => {
  const f = await retained(t);
  await f.state.arm(actor);
  const namespace = await f.state.namespace({ create: true });
  f.store(`/api/v1/namespaces/${namespace.metadata.name}`, {
    ...namespace,
    metadata: { ...namespace.metadata, uid: 'foreign' },
  });
  await assert.rejects(f.state.admission());
});

test('a rejected report quarantines retained staging even when the upgrade process acknowledged success', async (t) => {
  const f = await retained(t),
    state = f.state;
  await state.arm(actor);
  await state.namespace({ create: true });
  await state.claimCleanup(actor);
  await state.change((record) => {
    record.phase = 'settled';
    record.acceptedWorkSettled = true;
    record.testPhases = { upgrade: { state: 'acknowledged' } };
    record.fixtureFolder = { relativePath: 'owned-test', namespaceId: 'owned-id' };
  });
  const gate = {
    retainedSecrets: async () => {
      throw Error('Rejected evidence must preserve fixtures');
    },
  };
  const result = await cleanupRetainedStaging(state, gate, actor, { qualificationPassed: false });
  assert.equal(result.phase, 'quarantined');
  assert.equal(result.dataCleaned, false);
});

test('a rejected acquisition closes its empty attempt without touching the active retained application', async (t) => {
  const f = await retained(t);
  await f.state.arm(actor);
  await f.state.namespace({ create: true });
  const other = f.make('rivet-q-124-1');
  await assert.rejects(other.arm(actor), /busy or quarantined/);
  await settleRetainedStaging(other, actor, async () => {
    throw Error('No accepted work');
  });
  await cleanupRetainedStaging(other, null, actor);
  const verified = await verifyRetainedStagingCleanup(other);
  assert.equal(verified.retainedApplication.phase, 'not-acquired');
  assert.equal((await f.state.application.owned()).record.owner.operationId, f.state.operation.operationId);
});

for (const failure of ['none', 'delete-ack', 'finish-ack'])
  test(`retained cleanup deletes only its exact fixture folder and observes lost acknowledgements (${failure})`, async (t) => {
    const f = await retained(t),
      state = f.state;
    await state.arm(actor);
    await state.namespace({ create: true });
    await state.claimCleanup(actor);
    await state.change((record) => {
      record.phase = 'settled';
      record.acceptedWorkSettled = true;
      record.testPhases = { upgrade: { state: 'acknowledged' } };
      record.fixtureFolder = { relativePath: 'owned-test', namespaceId: 'owned-id' };
    });
    let writes = 0;
    const folders = [
      { relativePath: 'keep', namespaceId: 'unrelated' },
      { relativePath: 'owned-test', namespaceId: 'owned-id' },
    ];
    const gate = {
      config: { baseUrl: 'https://fixture.test' },
      retainedSecrets: async () => {},
      loadWorkflowKey: async () => {},
      requestWorkflow: async (_base, route, options) => {
        if (route.endsWith('/tree')) return { folders: structuredClone(folders) };
        const command = JSON.parse(options.body);
        assert.deepEqual(command.expectedSource, { id: 'owned-id' });
        assert.equal(command.command.relativePath, 'owned-test');
        writes++;
        if (failure === 'delete-ack') throw Error('acknowledgement unknown');
        folders.pop();
      },
      verifyProtectedProxyAvailability: async () => {},
      readyPublic: async () => {},
      verifyRetainedInstallation: async (manifest) => assert.equal(manifest, state.operation.candidate),
    };
    if (failure === 'delete-ack') {
      await assert.rejects(
        cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true }),
        /acknowledgement unknown/,
      );
      await assert.rejects(
        cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true }),
        /observe without replay/,
      );
      assert.equal((await state.application.owned()).record.phase, 'owned');
    } else {
      if (failure === 'finish-ack') {
        const json = state.api.json.bind(state.api);
        let lost = false;
        state.api.json = async (method, url, body) => {
          const result = await json(method, url, body);
          if (
            !lost &&
            method === 'PUT' &&
            url === state.application.path &&
            JSON.parse(body.data.record).phase === 'idle'
          ) {
            lost = true;
            throw Error('finish acknowledgement unknown');
          }
          return result;
        };
        await assert.rejects(
          cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true }),
          /finish acknowledgement unknown/,
        );
        assert.equal((await state.application.read()).record.phase, 'idle', 'The finish write actually committed');
        const completed = structuredClone(f.objects.get(state.application.path));
        for (const field of ['uid', 'nonce', 'receipt-operation']) {
          const changed = structuredClone(completed);
          const application = JSON.parse(changed.data.record);
          if (field === 'uid') changed.metadata.uid = 'replaced';
          if (field === 'nonce') application.nonce = 'replaced';
          if (field === 'receipt-operation') application.lastReceipt.operationId = 'another-operation';
          changed.data.record = JSON.stringify(application);
          f.objects.set(state.application.path, changed);
          await assert.rejects(settleRetainedStaging(state, actor, async () => assert.fail('No fixture work')));
          f.objects.set(state.application.path, structuredClone(completed));
        }
        await settleRetainedStaging(state, actor, async () =>
          assert.fail('Completed cleanup must not redispatch fixture work'),
        );
      }
      const receipt = await cleanupRetainedStaging(state, gate, actor, { qualificationPassed: failure === 'none' });
      assert.equal(receipt.phase, 'idle');
      assert.deepEqual(folders, [{ relativePath: 'keep', namespaceId: 'unrelated' }]);
      await verifyRetainedStagingCleanup(state);
      assert.equal(
        f.requests.filter(
          (request) =>
            request.method === 'PUT' &&
            request.pathname === state.application.path &&
            JSON.parse(request.input.data.record).phase === 'idle',
        ).length,
        1,
        'Never replay completion or downgrade its confirmed outcome',
      );
    }
    assert.equal(writes, 1);
    assert.equal(
      f.requests.some((request) => request.method === 'DELETE'),
      false,
    );
  });

test('a lost quarantine completion reply is observed without turning the attempt healthy', async (t) => {
  const f = await retained(t),
    state = f.state;
  await state.arm(actor);
  await state.namespace({ create: true });
  await state.claimCleanup(actor);
  await state.change((record) => {
    record.phase = 'settled';
    record.acceptedWorkSettled = true;
  });
  const json = state.api.json.bind(state.api);
  let lost = false;
  state.api.json = async (method, url, body) => {
    const result = await json(method, url, body);
    if (
      !lost &&
      method === 'PUT' &&
      url === state.application.path &&
      JSON.parse(body.data.record).phase === 'quarantined'
    ) {
      lost = true;
      throw Error('finish acknowledgement unknown');
    }
    return result;
  };
  await assert.rejects(cleanupRetainedStaging(state, null, actor), /finish acknowledgement unknown/);
  await settleRetainedStaging(state, actor, async () => assert.fail('No accepted work'));
  const receipt = await cleanupRetainedStaging(state, null, actor);
  assert.equal(receipt.phase, 'quarantined');
  assert.equal(receipt.healthy, false);
  assert.equal(receipt.dataCleaned, false);
  await verifyRetainedStagingCleanup(state);
  assert.equal(
    f.requests.filter(
      (request) =>
        request.method === 'PUT' &&
        request.pathname === state.application.path &&
        JSON.parse(request.input.data.record).phase === 'quarantined',
    ).length,
    1,
  );
});
