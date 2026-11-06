import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, settings, operation, actor } from './test-fixtures/reusable-staging.mjs';
import { ReusableStagingState, reusableStagingSettings, stagingOwner } from './lib/reusable-staging-state.mjs';
import { qualificationHash } from './lib/runtime-qualification-execution.mjs';
import { cleanupStaging } from './lib/reusable-staging-cleanup.mjs';
import { retainedApplicationSettings } from './lib/retained-staging-application.mjs';
import { providerProgressStep } from './lib/provider-progress.mjs';
import { executeProviderPhase } from './qualification/provider-entry.mjs';
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

test('publication-aware retention has an explicit compatibility marker before provider setup', () => {
  const names = { namespace: 'rivet-staging-persistent', recordName: 'rivet-staging-application' };
  for (const protocol of [1, 2])
    assert.deepEqual(retainedApplicationSettings({ protocol, ...names }), { protocol, ...names });
  assert.throws(() => retainedApplicationSettings({ protocol: 3, ...names }), /Unsupported/);
});
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

for (const [profile, missing, active] of [
  ['control', undefined, false],
  ['combined', undefined, false],
  ['control', 'execution', false],
  ['combined', 'backend', false],
  ['control', undefined, true],
]) {
  test(`retained settlement follows published-execution capability (${profile}, missing ${missing}, active ${active})`, async (t) => {
    const { state, store } = await retained(t);
    await state.arm(actor);
    const namespace = await state.namespace({ create: true });
    await state.change((record) => {
      record.fixtureFolder = { relativePath: 'owned', namespaceId: 'owned-id' };
    });
    const { record } = await state.read(),
      probes = [];
    for (const role of ['backend', 'execution']) {
      const name = `${record.release}-${role}`;
      const metadata = {
        name,
        namespace: namespace.metadata.name,
        labels: {
          [stagingOwner]: state.operation.operationId,
          'app.kubernetes.io/instance': record.release,
          'app.kubernetes.io/component': role,
        },
      };
      const controller = store(`/apis/apps/v1/namespaces/${namespace.metadata.name}/statefulsets/${name}`, {
        metadata,
      });
      store(`/api/v1/namespaces/${namespace.metadata.name}/pods/${name}-0`, {
        metadata: {
          ...metadata,
          name: `${name}-0`,
          ownerReferences: [{ name, uid: controller.metadata.uid, controller: true, kind: 'StatefulSet' }],
        },
        spec: {
          containers: [
            {
              name: role === 'backend' ? 'backend' : 'api',
              env: [{ name: 'RIVET_API_PROFILE', value: role === 'backend' ? profile : 'execution' }],
            },
          ],
        },
        status: { phase: 'Running' },
      });
    }
    let executionSamples = 0,
      observations = 0;
    state.api.exec = async (url, _command, options) => {
      const role = url.includes('-backend-') ? 'backend' : 'execution';
      probes.push(role);
      assert.equal(options.container, role === 'backend' ? 'backend' : 'api');
      if (role === missing || (role === 'backend' && profile === 'control')) return '';
      const running = role === 'execution' && active && executionSamples++ === 0;
      return `rivet_published_execution_active_runs{profile="${role === 'backend' ? profile : 'execution'}"} ${running ? 1 : 0}\n`;
    };
    const settle = () =>
      settleRetainedStaging(state, actor, async (_label, check) => {
        for (let i = 0; i < 3; i++) {
          observations++;
          if (await check()) return;
          assert.notEqual((await state.read()).record.acceptedWorkSettled, true);
        }
        assert.fail('Accepted work did not settle');
      });
    if (missing) {
      await assert.rejects(settle(), /Accepted work inventory is unconfirmed/);
      assert.notEqual((await state.read()).record.acceptedWorkSettled, true);
    } else {
      await settle();
      assert.equal((await state.read()).record.acceptedWorkSettled, true);
      assert.equal(observations, active ? 2 : 1);
      assert.equal(probes.includes('backend'), profile === 'combined');
      assert.ok(probes.includes('execution'));
    }
  });
}

test('retained cleanup and verification run through the actual provider progress wrapper', async (t) => {
  const { state, requests } = await retained(t);
  await state.arm(actor);
  const namespace = await state.namespace({ create: true });
  await settleRetainedStaging(state, actor, async (_label, check) => assert.ok(await check()));
  for (const phase of ['cleanup', 'verifyCleanup']) {
    const id = `worker-${phase}`;
    await state.change((record) => record.workers.push({ id, phase, closed: false }));
    await executeProviderPhase({
      phase,
      state,
      operation: state.operation,
      actor,
      gate: null,
      step: providerProgressStep(state, phase, id, Date.now() + 60_000),
    });
    await state.change((record) => {
      record.workers.find((w) => w.id === id).closed = true;
    });
  }
  const { record } = await state.read();
  assert.equal(record.cleanupVerified, true);
  assert.equal(record.retainedCleanup.phase, 'quarantined');
  assert.equal(record.retainedCleanup.dataCleaned, false);
  assert.equal(record.retainedCleanup.namespaceUid, namespace.metadata.uid);
  assert.equal(
    requests.some((request) => request.method === 'DELETE'),
    false,
  );
});

for (const bootstrap of [true, false]) {
  test(`retained ${bootstrap ? 'bootstrap' : 'reuse'} reaches fixture preparation through real progress reporting`, async (t) => {
    const { state } = await retained(t);
    await state.arm(actor);
    await state.namespace({ create: true });
    await state.change((record) => {
      record.retainedApplication.bootstrap = bootstrap;
      record.workers.push({ id: 'prepare-worker', phase: 'prepare', closed: false });
    });
    const reached = Error('Fixture preparation reached'),
      calls = [];
    const gate = {
      config: {},
      values: () => ({}),
      prepareRetainedFixture: async () => {
        throw reached;
      },
    };
    for (const method of [
      'verifySharedPrerequisites',
      'verifyAdmission',
      'installDependencies',
      'createPublicRoute',
      'apply',
      'retainedSecrets',
      'verifyRetainedInstallation',
      'readyPublic',
    ])
      gate[method] = async () => {
        calls.push(method);
      };
    await assert.rejects(
      executeProviderPhase({
        phase: 'prepare',
        state,
        actor,
        gate,
        operation: { ...state.operation, previous: { images: {} }, candidate: { images: {} } },
        wait: async () => {}, // Owner readiness is tested separately; exercise phase dispatch here.
        step: providerProgressStep(state, 'prepare', 'prepare-worker', Date.now() + 60_000),
      }),
      (error) => error === reached,
    );
    assert.equal(calls.includes('installDependencies'), bootstrap);
    assert.equal(calls.includes('verifyRetainedInstallation'), !bootstrap);
    assert.equal((await state.read()).record.workers[0].progress.step, 'owned-fixture-folder');
  });
}

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

for (const failure of ['none', 'web-before', 'web-after', 'endpoint-after', 'delete-after', 'revision-changed'])
  test(`retained fixture cleanup follows publication guards and observes interrupted writes (${failure})`, async (t) => {
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
    const folders = [{ relativePath: 'owned-test', namespaceId: 'owned-id' }];
    const projects = [
      {
        id: 'owned-project',
        relativePath: 'owned-test/fixture.rivet-project',
        revisionId: 'draft-1',
        published: true,
        webApps: ['ui-1', 'ui-2'],
        version: 1,
      },
      {
        id: 'owned-unpublished',
        relativePath: 'owned-test/unpublished.rivet-project',
        revisionId: 'draft-2',
        published: false,
        webApps: [],
        version: 1,
      },
      {
        id: 'unrelated-project',
        relativePath: 'keep/fixture.rivet-project',
        revisionId: 'draft-keep',
        published: true,
        webApps: [],
        version: 1,
      },
    ];
    const unrelated = structuredClone(projects.at(-1));
    const calls = [];
    let interrupted = false;
    const gate = {
      config: { baseUrl: 'https://fixture.test' },
      retainedSecrets: async () => {},
      loadWorkflowKey: async () => {},
      verifyProtectedProxyAvailability: async () => {},
      readyPublic: async () => {},
      verifyRetainedInstallation: async () => {},
      requestWorkflow: async (_base, route, options = {}) => {
        if (route.endsWith('/tree'))
          return structuredClone({
            folders: folders.map((folder) => ({
              ...folder,
              folders: [],
              projects: projects.filter((p) => p.relativePath.startsWith(folder.relativePath + '/')),
            })),
            projects: projects.filter((p) => !p.relativePath.includes('/')),
          });
        if (route.startsWith('/api/workflows/projects/web-apps?')) {
          const selected = projects.find(
            (p) => p.relativePath === new URL(route, 'https://fixture.test').searchParams.get('relativePath'),
          );
          assert.ok(selected);
          return {
            projectId: selected.id,
            draftRevisionId: failure === 'revision-changed' ? 'changed' : selected.revisionId,
            publicationVersion: String(selected.version),
            project: { ...selected, settings: { status: selected.published ? 'published' : 'unpublished' } },
            webApps: selected.webApps.map((uiGraphId) => ({
              uiGraphId,
              status: 'published',
              publishedSlug: uiGraphId,
            })),
          };
        }
        const body = JSON.parse(options.body);
        const selected = projects.find(
          (p) => p.relativePath === body.relativePath || p.relativePath === body.command?.relativePath,
        );
        calls.push(`${route}:${selected?.id ?? 'folder'}:${body.uiGraphId ?? ''}`);
        const stage = route.includes('/web-apps/') ? 'web' : route.endsWith('/unpublish') ? 'endpoint' : 'delete';
        const interrupt = (when) => {
          if (!interrupted && selected?.id === 'owned-project' && failure === `${stage}-${when}`) {
            interrupted = true;
            throw Error('write acknowledgement unknown');
          }
        };
        interrupt('before');
        if (route.endsWith('/unpublish')) {
          assert.equal(selected?.id, 'owned-project');
          assert.deepEqual(body.preconditions, {
            expectedProjectId: selected.id,
            expectedDraftRevisionId: selected.revisionId,
            expectedPublicationVersion: String(selected.version),
          });
          if (route.includes('/web-apps/')) selected.webApps = selected.webApps.filter((id) => id !== body.uiGraphId);
          else selected.published = false;
          selected.version++;
          interrupt('after');
          return {};
        }
        assert.equal(route, '/api/workflows/namespace/mutate');
        if (body.command.itemType === 'project') {
          assert.ok(['owned-project', 'owned-unpublished'].includes(selected?.id));
          assert.ok(!selected.published && selected.webApps.length === 0, 'Unpublish projects before deletion');
          assert.deepEqual(body.expectedSource, { id: selected.id, revisionId: selected.revisionId });
          projects.splice(projects.indexOf(selected), 1);
          interrupt('after');
        } else {
          assert.equal(body.command.relativePath, 'owned-test');
          assert.ok(
            !projects.some((p) => p.relativePath.startsWith('owned-test/')),
            'Only empty folders can be deleted',
          );
          folders.pop();
        }
        return { deleted: true };
      },
    };
    if (failure === 'revision-changed') {
      await assert.rejects(
        cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true }),
        /project changed/,
      );
      assert.deepEqual(calls, []);
      assert.equal((await state.application.owned()).record.phase, 'owned');
      return;
    }
    if (failure !== 'none') {
      await assert.rejects(
        cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true }),
        /write acknowledgement unknown/,
      );
      if (failure === 'web-before') {
        const before = [...calls];
        await assert.rejects(
          cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true }),
          /observe without replay/,
        );
        assert.deepEqual(calls, before, 'Never replay a write whose effect is still unconfirmed');
        assert.equal((await state.application.owned()).record.phase, 'owned');
        return;
      }
    }
    const result = await cleanupRetainedStaging(state, gate, actor, { qualificationPassed: true });
    assert.equal(result.phase, 'idle');
    assert.deepEqual(calls, [
      '/api/workflows/projects/web-apps/unpublish:owned-project:ui-1',
      '/api/workflows/projects/web-apps/unpublish:owned-project:ui-2',
      '/api/workflows/projects/unpublish:owned-project:',
      '/api/workflows/namespace/mutate:owned-project:',
      '/api/workflows/namespace/mutate:owned-unpublished:',
      '/api/workflows/namespace/mutate:folder:',
    ]);
    assert.deepEqual(projects, [unrelated]);
    await verifyRetainedStagingCleanup(state);
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
        if (route.endsWith('/tree'))
          return { folders: folders.map((folder) => ({ ...folder, folders: [], projects: [] })), projects: [] };
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
