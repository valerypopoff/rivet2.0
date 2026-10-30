import test from 'node:test';
// test-style: fixture-read: Read only test-owned admission markers, journals and serialized workflow fixtures.
import assert from 'node:assert/strict';
import {
  HaReleaseGate,
  runHaReleaseRollout,
  selectHaCertificationMode,
  validateHaCertificationManifest,
  withHaProofGeneration,
} from './kubernetes-ha-release-gate.mjs';
import { HaReleaseProbes, haProofTimeoutMs, haRetirementProbeDelayMs } from './lib/ha-release-probes.mjs';
import {
  assertHaLatestSession,
  createHaLatestRunControls,
  waitForHaLatestRelease,
  withHaLatestAdmission,
} from './fixtures/ha-latest-controls.mjs';
import { HA_BROWSER_CONTRACT } from './lib/ha-release-evidence.mjs';
import { HA_ROUTING_PROPAGATION_MS } from './lib/ha-routing-withdrawal.mjs';
import { maintenanceValidationValues } from './lib/managed-release-cutover.mjs';
import { probeSchemaLockContention, readSchemaRepositoryReceipt } from './lib/schema-compatibility-probe.mjs';
import { ProviderHaReleaseGate, withProviderReadRetry } from './kubernetes-ha-provider-gate.mjs';
import { createHaRecoveryFaultTransport, verifyHaReleaseRecovery } from './lib/ha-release-recovery-probes.mjs';
import { startHaWorkflowTraffic } from './lib/ha-workflow-traffic.mjs';
import { parseAllDocuments } from 'yaml';
import {
  publishHaBrowserBaseline,
  waitForHaFrontendReplacement,
  hasHaBrowserReadyTransport,
  assertHaBrowserWebPods,
} from './lib/ha-browser-probe.mjs';

test('backend-only browser evidence retains web identity without weakening frontend replacement evidence', () => {
  const before = [{ metadata: { uid: 'old-web', labels: { 'app.kubernetes.io/component': 'web' } } }];
  const replaced = [{ metadata: { uid: 'new-web' } }];
  assertHaBrowserWebPods(before, replaced);
  assert.throws(() => assertHaBrowserWebPods(before, before), /must be gone/);
  assertHaBrowserWebPods(before, before, false);
  assert.throws(() => assertHaBrowserWebPods(before, replaced, false), /must retain/);
  assert.throws(() => assertHaBrowserWebPods([], [], false), /inventory/);
});
import { ManagedReleaseGate } from './kubernetes-managed-release-gate.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import * as nativeFs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { resolveHelmBinOrThrow, resolveKubectlForwardBin } from './lib/k8s-tools.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  readManagedWorkflowSchemaReleaseContract,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));

test('latest retirement admission keeps the actual run alive until one explicit release', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-latest-admission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const name = `rivet-ha-probe-${randomUUID()}.json`;
  const value = 'ha-latest-' + name;
  const file = path.join(directory, name + '.latest');
  let completed = false;
  const pending = waitForHaLatestRelease(value, nativeFs, directory, 5000).then(() => {
    completed = true;
  });
  const deadline = Date.now() + 5000;
  while (!nativeFs.existsSync(file + '.waiting')) {
    assert.ok(Date.now() < deadline, 'Actual admission file did not appear');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await fs.readFile(file + '.waiting', 'utf8'), value);
  assert.equal(completed, false);
  await assert.rejects(waitForHaLatestRelease(value, nativeFs, directory), { code: 'EEXIST' });
  await fs.writeFile(file + '.release', 'released', { flag: 'wx' });
  await pending;
  assert.equal(nativeFs.existsSync(file + '.waiting'), false);
  assert.equal(nativeFs.existsSync(file + '.release'), false);
  await assert.rejects(
    waitForHaLatestRelease(`ha-latest-rivet-ha-probe-${randomUUID()}.json`, nativeFs, directory, 0),
    /deadline/,
  );
  const nodes = {
    '[input]:graphInput "Input"': { data: { id: 'input' }, outgoingConnections: ['data->"Output" output/value'] },
  };
  withHaLatestAdmission(nodes);
  const admission = nodes['[latest-admission]:code "Latest admission"'];
  assert.deepEqual(admission.outgoingConnections, ['output->"Output" output/value']);
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
    'inputs',
    'require',
    admission.data.code,
  );
  assert.deepEqual(await execute({ input: { value: 'ordinary request' } }, createRequire(import.meta.url)), {
    output: { type: 'string', value: 'ordinary request' },
  });
});

test('retirement controls negotiate scoped targets without confusing concurrent roots or downgrading', async () => {
  const scope = { channel: null, rootRunId: 'root', projectId: 'project', owner: 'backend-0', incarnation: 'process' };
  const started = {
    rivetEventId: 'backend-0:process:10',
    rivetScope: { ...scope },
    data: { execution: { rootRunId: 'root' }, project: { metadata: { id: 'project' } } },
  };
  const session = {
    message: 'latest-session',
    data: { protocol: 2, channel: null, channelIsolation: true, runScopedControls: true },
  };
  for (const protocol of [1, 2]) {
    const observations = [],
      commands = [];
    const controls = createHaLatestRunControls({
      session: protocol === 1 ? { message: 'latest-session', data: { protocol: 1 } } : session,
      started: protocol === 1 ? { ...started, rivetScope: undefined } : started,
      owner: 'backend-0',
      observations,
      socket: {
        send: (raw) => {
          const command = JSON.parse(raw);
          commands.push(command);
          observations.push({
            message: 'latest-control-result',
            data: { commandId: command.data?.commandId, status: 'accepted' },
          });
        },
      },
      waitFor: async (_description, condition) => {
        const result = condition();
        assert.ok(result);
        return result;
      },
    });
    await controls.send('pause');
    // The captured target must not drift with a mutable source frame.
    started.rivetScope.rootRunId = 'mutated-after-admission';
    await controls.send('resume');
    started.rivetScope.rootRunId = scope.rootRunId;
    assert.equal(commands.length, 2);
    if (protocol === 1) assert.deepEqual(commands, [{ type: 'pause' }, { type: 'resume' }]);
    else {
      assert.deepEqual(
        commands.map((command) => command.data.target),
        [scope, scope],
      );
      assert.deepEqual(
        commands.map((command) => command.data.action),
        ['pause', 'resume'],
      );
      assert.ok(commands.every((command) => command.type === 'latest-control'));
      assert.notEqual(commands[0].data.commandId, commands[1].data.commandId);
      for (const field of Object.keys(scope))
        assert.equal(controls.matches({ rivetScope: { ...scope, [field]: 'foreign' } }), false, field);
      assert.equal(controls.matches({ rivetScope: scope }), true);
    }
  }
  for (const data of [
    { protocol: 3 },
    { ...session.data, channel: 'other' },
    { ...session.data, runScopedControls: false },
  ])
    assert.throws(() => assertHaLatestSession({ message: 'latest-session', data }));
  for (const protocol of [1, 2]) {
    const controls = createHaLatestRunControls({
      session: { ...session, data: { ...session.data, protocol } },
      started: { ...started, ...(protocol === 2 ? { rivetLegacyOwner: true } : {}) },
      owner: 'backend-0',
      socket: {
        send() {
          assert.fail('Mixed observation cannot send controls');
        },
      },
      observations: [],
      waitFor() {
        assert.fail('No modifying command should be sent');
      },
    });
    assert.equal(controls.matches(started), true);
    assert.equal(controls.matches({ ...started, rivetScope: { ...scope, rootRunId: 'concurrent' } }), false);
    await assert.rejects(controls.send('pause'), /read-only/);
  }
  for (const status of ['rejected', 'outcome-unknown', 'lost']) {
    const commands = [],
      observations = [];
    const controls = createHaLatestRunControls({
      session,
      started,
      owner: 'backend-0',
      observations,
      socket: {
        send: (raw) => {
          const command = JSON.parse(raw);
          commands.push(command);
          if (status !== 'lost')
            observations.push({
              message: 'latest-control-result',
              data: { commandId: command.data.commandId, status },
            });
        },
      },
      waitFor: async (_description, condition) => {
        const result = condition();
        if (!result) throw Error('lost acknowledgement');
        return result;
      },
    });
    await assert.rejects(controls.send('pause'), /not acknowledged|lost acknowledgement/);
    assert.equal(commands.length, 1, 'An uncertain control must never be retried or downgraded');
    assert.equal(commands[0].type, 'latest-control');
  }
});

test('editor retirement probe carries its self-contained control module into the exact stdin actor', async () => {
  let invocation;
  const projectId = randomUUID();
  const requests = [];
  const gate = {
    requestWorkflow: async (_base, route) => {
      requests.push(route);
      if (route.endsWith('/upload')) return { project: { id: projectId, relativePath: 'fixture.rivet-project' } };
      if (route.includes('/web-apps?')) return { projectId, draftRevisionId: 'draft', publicationVersion: null };
      assert.ok(route.endsWith('/publish'));
      return {};
    },
    kubectl: async (args, options) => {
      if (args.includes('-i')) {
        invocation = { args, options };
        return { stdout: '{"phase":"passed"}' };
      }
      return { stdout: '{"phase":"paused"}' };
    },
    config: { namespace: 'fixture' },
  };
  const probes = new HaReleaseProbes(gate, 'http://unused.invalid', rootDir);
  assert.deepEqual(await Promise.all([probes.prepareLatestProbe(), probes.prepareLatestProbe()]), [
    `ha-latest-${projectId}`,
    `ha-latest-${projectId}`,
  ]);
  await probes.startEditor({ name: 'backend-0', uid: 'owner', container: 'backend' }, 'backend-1');
  await probes.editors[0].completed;
  assert.deepEqual(JSON.parse(invocation.args.at(-2)), { endpoint: `ha-latest-${projectId}` });
  assert.equal(requests.filter((route) => route.endsWith('/upload')).length, 1);
  assert.equal(requests.filter((route) => route.endsWith('/publish')).length, 1);
  const module = await import(invocation.args.at(-1));
  module.assertHaLatestSession({ message: 'latest-session', data: { protocol: 1 } });
  assert.equal(typeof module.createHaLatestRunControls, 'function');
  assert.equal(probes.editors[0].receipt.phase, 'passed');
});

test('an uncertain latest fixture publication cannot be recreated by a later probe call', async () => {
  const failure = Error('publication acknowledgement lost');
  const projectId = randomUUID();
  let uploads = 0;
  let publications = 0;
  const probes = new HaReleaseProbes(
    {
      requestWorkflow: async (_base, route) => {
        if (route.endsWith('/upload')) {
          uploads++;
          return { project: { id: projectId, relativePath: 'fixture' } };
        }
        if (route.includes('/web-apps?'))
          return { projectId, draftRevisionId: 'draft', publicationVersion: null };
        publications++;
        throw failure;
      },
    },
    'http://unused.invalid',
    rootDir,
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(probes.prepareLatestProbe(), (error) => error === failure);
  assert.equal(uploads, 1);
  assert.equal(publications, 1);
});

test('predecessor schema verification respects the rollback floor without concealing compatible failures', async () => {
  const artifacts = new Map();
  const calls = [];
  const gate = {
    config: {
      namespace: 'fixture',
      registry: { secretName: 'registry' },
      managedWorkflowSchema: { version: 17, minimumRollbackCompatibleVersion: 17 },
      previousApiImage: { repository: 'example.test/api', digest: `sha256:${'e'.repeat(64)}`, schemaVersion: 16 },
    },
    artifact: async (name, value) => artifacts.set(name, value),
    kubectl: async (args) => {
      calls.push(args);
      return { stdout: 'verified', stderr: '' };
    },
  };
  await ManagedReleaseGate.prototype.verifyPreviousApiSchemaCompatibility.call(gate);
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(artifacts.get('previous-api-schema-compatibility.json')).status, 'incompatible');
  assert.equal(JSON.parse(artifacts.get('previous-api-schema-compatibility.json')).previousSchemaVersion, 16);

  gate.config.previousApiImage.schemaVersion = 17;
  await ManagedReleaseGate.prototype.verifyPreviousApiSchemaCompatibility.call(gate);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['apply', 'wait', 'logs'],
  );
  assert.equal(JSON.parse(artifacts.get('previous-api-schema-compatibility.json')).skipped, false);

  gate.kubectl = async () => {
    throw new Error('verification failed');
  };
  await assert.rejects(
    ManagedReleaseGate.prototype.verifyPreviousApiSchemaCompatibility.call(gate),
    /verification failed/,
  );
});

test('HA certification never labels an incompatible schema transition as mixed-version', () => {
  const candidate = {
    database: { managedWorkflowSchema: { minimumRollbackCompatibleVersion: 17 } },
    images: { api: 'new' },
  };
  const previous = {
    database: { managedWorkflowSchema: { version: 16 } },
    images: { api: 'old' },
    evidence: { ha: { protocol: 3, browserContract: { protocol: HA_BROWSER_CONTRACT } } },
  };
  assert.equal(selectHaCertificationMode(candidate, previous), 'bootstrap');
  previous.database.managedWorkflowSchema.version = 17;
  assert.equal(selectHaCertificationMode(candidate, previous), 'mixed');
});

test('lock probe releases acquired connections when a later pool acquisition fails', async () => {
  for (const failedAt of [1, 2, 3]) {
    let acquired = 0,
      released = 0;
    const failure = Error('fixture pool exhausted');
    const rollbackFailure = Error('fixture connection lost');
    const dispositions = [];
    const pool = {
      connect: async () => {
        if (++acquired === failedAt) throw failure;
        const index = acquired;
        return {
          query: async () => {
            if (failedAt === 3 && index === 1) throw rollbackFailure;
            return { rows: [] };
          },
          release: (error) => {
            released++;
            dispositions.push(error);
          },
        };
      },
    };
    await assert.rejects(
      probeSchemaLockContention(pool, `rivet_schema_probe_${'a'.repeat(32)}`, { version: 18 }),
      (error) => error === failure,
    );
    assert.equal(released, failedAt - 1, 'Every acquired lease must be returned');
    if (failedAt === 3) assert.deepEqual(dispositions, [rollbackFailure, undefined]);
  }
});

test('reader connection loss is observed immediately while contended DDL settles', async () => {
  const failure = Error('fixture reader connection lost');
  let index = 0,
    releases = 0,
    lost = false;
  const pool = {
    connect: async () => {
      const role = index++;
      return {
        processID: 42,
        query: async (sql) => {
          if (role === 1 && sql === 'fixture DDL')
            return new Promise((_, reject) =>
              setTimeout(() => reject(Object.assign(Error('lock timeout'), { code: '55P03' })), 40),
            );
          if (role === 2 && sql.includes('WHERE recording_id=')) {
            lost = true;
            throw failure;
          }
          if (role === 2 && lost) throw failure;
          if (sql.includes('pg_relation_filenode')) return { rows: [{ id: 1 }] };
          if (sql.includes('pg_locks')) return { rowCount: 1, rows: [] };
          return { rows: [] };
        },
        release: () => {
          releases++;
        },
      };
    },
  };
  await assert.rejects(
    probeSchemaLockContention(pool, `rivet_schema_probe_${'a'.repeat(32)}`, { version: 18, sql: 'fixture DDL' }),
    (error) => error === failure,
  );
  assert.equal(releases, 3);
});

test('local and Kubernetes schema receipts reject wrong roles, versions, incomplete rounds and missing lock proof', () => {
  for (const [role, version] of [
    ['previous', 17],
    ['candidate', 18],
  ]) {
    const expected = { role, version, runId: 'a'.repeat(32) };
    const row = { ...expected, rounds: 2, peerRowsRead: 2, ...(role === 'candidate' ? { lockContention: true } : {}) };
    const text = (value) => `RIVET_SCHEMA_PROBE_RESULT ${JSON.stringify(value)}`;
    assert.deepEqual(readSchemaRepositoryReceipt(text(row), expected), row);
    for (const change of [
      { role: 'other' },
      { version: 19 },
      { runId: 'b'.repeat(32) },
      { rounds: 1 },
      { peerRowsRead: 0 },
      { lockContention: role === 'candidate' ? false : true },
    ])
      assert.throws(() => readSchemaRepositoryReceipt(text({ ...row, ...change }), expected));
    assert.throws(() => readSchemaRepositoryReceipt(text(row) + '\n' + text(row), expected));
  }
});

test('mixed schema gate launches two exact-image repository workers and rejects partial receipts', async () => {
  for (const fault of [
    null,
    'missing',
    'wrong-version',
    'missing-lock',
    'changed-image',
    'changed-job',
    'wrong-command',
    'wrong-code',
    'replaced-pod-after-log',
    'partial-pods',
    'wrong-owner',
    'failed-pod',
    'peer-pending',
  ]) {
    const artifacts = new Map(),
      calls = [];
    let jobs,
      code,
      logged = false;
    let releasePeer,
      peerStarted,
      peerSettled = false;
    const peerWait = new Promise((resolve) => {
      releasePeer = resolve;
    });
    const started = new Promise((resolve) => {
      peerStarted = resolve;
    });
    const podFor = (job) => ({
      metadata: {
        name: `${job.metadata.name}-pod`,
        uid: `pod-${job.metadata.name}`,
        ownerReferences: [
          { kind: 'Job', controller: true, uid: fault === 'wrong-owner' ? 'foreign' : `uid-${job.metadata.name}` },
        ],
      },
      spec: {
        ...structuredClone(job.spec.template.spec),
        containers: [
          {
            ...structuredClone(job.spec.template.spec.containers[0]),
            image: fault === 'changed-image' ? 'foreign/image' : job.spec.template.spec.containers[0].image,
            command:
              fault === 'wrong-command'
                ? ['node', '-e', 'console.log("fake")']
                : job.spec.template.spec.containers[0].command,
          },
        ],
        volumes: [{ name: 'probe', configMap: { name: fault === 'wrong-code' ? 'other-code' : code.metadata.name } }],
      },
      status: { phase: fault === 'failed-pod' ? 'Failed' : 'Succeeded' },
    });
    const gate = {
      config: {
        namespace: 'fixture',
        registry: { secretName: 'registry' },
        previousApiImage: { repository: 'fixture/api', digest: `sha256:${'a'.repeat(64)}`, schemaVersion: 17 },
        images: { api: { repository: 'fixture/api', digest: `sha256:${'b'.repeat(64)}` } },
        managedWorkflowSchema: { version: 18 },
      },
      artifact: async (n, v) => artifacts.set(n, v),
      kubectl: async (args, extra) => {
        calls.push(args);
        if (args[0] === 'create') {
          code = JSON.parse(extra.input).items.find((r) => r.kind === 'ConfigMap');
          jobs = JSON.parse(extra.input).items.filter((r) => r.kind === 'Job');
          assert.equal(jobs.length, 2);
          for (const job of jobs) {
            assert.equal(job.spec.backoffLimit, 0);
            assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
            assert.ok(job.spec.template.spec.containers[0].image.includes('@sha256:'));
          }
        }
        if (args[0] === 'get' && args[1] === 'configmap')
          return { stdout: JSON.stringify({ ...code, metadata: { ...code.metadata, uid: 'code-uid' } }) };
        if (args[0] === 'get' && args[1] === 'pod') {
          const pod = podFor(jobs.find((j) => `${j.metadata.name}-pod` === args[2]));
          if (fault === 'replaced-pod-after-log' && logged) pod.metadata.uid = 'replacement-pod';
          return { stdout: JSON.stringify(pod) };
        }
        if (args[0] === 'get' && args[1] === 'job') {
          const job = structuredClone(jobs.find((j) => j.metadata.name === args[2]));
          job.metadata.uid = fault === 'changed-job' && peerSettled ? 'foreign' : `uid-${job.metadata.name}`;
          return { stdout: JSON.stringify(job) };
        }
        if (args[0] === 'get' && args[1] === 'pods') {
          const job = jobs.find((j) => args.includes(`job-name=${j.metadata.name}`));
          return {
            stdout: JSON.stringify({
              ...(fault === 'partial-pods' ? { metadata: { continue: 'remaining' } } : {}),
              items: [podFor(job)],
            }),
          };
        }
        if (args[0] === 'wait') {
          if (fault === 'peer-pending') {
            if (args[2].endsWith('-previous')) throw Error('fixture first worker failed');
            peerStarted();
            await peerWait;
          }
          peerSettled = true;
        }
        if (args[0] === 'logs') {
          logged = true;
          const job = jobs.find((j) => [`job/${j.metadata.name}`, `pod/${j.metadata.name}-pod`].includes(args.at(-1)));
          const env = Object.fromEntries(job.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
          const result = {
            role: env.RIVET_SCHEMA_PROBE_ROLE,
            version: Number(env.RIVET_SCHEMA_PROBE_VERSION),
            runId: env.RIVET_SCHEMA_PROBE_ID,
            rounds: 2,
            peerRowsRead: 2,
            ...(env.RIVET_SCHEMA_PROBE_ROLE === 'candidate' ? { lockContention: fault !== 'missing-lock' } : {}),
          };
          if (fault === 'wrong-version') result.version = 16;
          return {
            stdout: fault === 'missing' ? '' : `RIVET_SCHEMA_PROBE_RESULT ${JSON.stringify(result)}`,
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      },
    };
    if (fault) gate.schemaCompatibility = { stale: true };
    const run = () => ManagedReleaseGate.prototype.verifyMixedSchemaRepositories.call(gate);
    if (fault === 'peer-pending') {
      let settled = false;
      const running = run().finally(() => {
        settled = true;
      });
      running.catch(() => {});
      await started;
      await new Promise((resolve) => setImmediate(resolve));
      const premature = settled;
      releasePeer();
      await assert.rejects(running);
      assert.equal(premature, false, 'Failed qualification must await both accepted worker observations');
    } else if (fault) {
      await assert.rejects(run());
      assert.equal(gate.schemaCompatibility, undefined);
    } else {
      assert.equal((await run()).lockContention, true);
      assert.ok(artifacts.has('mixed-schema-repositories.json'));
    }
    if (fault)
      assert.equal(gate.schemaCompatibility, undefined, 'A failed attempt cannot retain earlier success evidence');
    assert.equal(calls.filter((c) => c[0] === 'create').length, 1, 'Never replay a fixture write');
  }
});

test('background and Evaluation drain fixtures outlive the real routing propagation window', () => {
  assert.equal(haRetirementProbeDelayMs - HA_ROUTING_PROPAGATION_MS, 45_000);
  assert.ok(haRetirementProbeDelayMs < 180_000, 'bounded probes retain the normal API request deadline');
});

test('background retirement finds its recording outside the newest global page without weakening durability', async () => {
  const pod = { name: 'fixture-ha-execution-0', uid: 'retiring-owner' };
  const background = {
    pod: pod.name,
    uid: pod.uid,
    workflowId: 'owned/workflow',
    correlationId: 'background-correlation',
  };
  const recording = {
    id: 'durable-recording',
    workflowId: background.workflowId,
    status: 'succeeded',
    executionIdentity: { surface: 'workflow_endpoint', correlationId: background.correlationId },
  };
  const globalNewest = Array.from({ length: 100 }, (_, i) => ({
    ...recording,
    id: `newer-${i}`,
    workflowId: 'traffic-workflow',
    executionIdentity: { ...recording.executionIdentity, correlationId: `traffic-${i}` },
  }));
  for (const scenario of ['durable', 'missing', 'duplicate', 'failed', 'incomplete', 'wrong workflow', 'child only']) {
    const calls = [];
    const gate = {
      requestWorkflow: async (_base, route) => {
        calls.push(route);
        if (route === '/api/workflows/recordings/runs?page=1&pageSize=100&status=all')
          return { runs: globalNewest, hasMore: true };
        assert.equal(route, '/api/workflows/recordings/workflows/owned%2Fworkflow/runs?page=1&pageSize=100&status=all');
        const row = structuredClone(recording);
        if (scenario === 'failed') row.status = 'failed';
        if (scenario === 'wrong workflow') row.workflowId = 'foreign';
        if (scenario === 'child only') row.executionIdentity.surface = 'subgraph_project';
        return {
          runs: scenario === 'missing' ? [] : scenario === 'duplicate' ? [row, { ...row, id: 'duplicate' }] : [row],
          hasMore: scenario === 'incomplete',
        };
      },
    };
    const probes = new HaReleaseProbes(gate, 'http://fixture', rootDir);
    probes.background.push({ ...background });
    if (scenario === 'durable') {
      await probes.afterWithdrawal(pod);
      assert.equal(probes.background[0].recordingId, recording.id);
    } else {
      await assert.rejects(probes.afterWithdrawal(pod), /one full-run recording|succeeded|catalog must be complete/);
      assert.equal(probes.background[0].recordingId, undefined, 'failed proof cannot earn a preservation receipt');
    }
    assert.equal(calls.length, 1, 'do not retry execution, scan the global history or conceal a missing recording');
  }
});

function recoveryCasFixture() {
  let version = 7;
  const record = {
    token: 'operation',
    runner: 'controller',
    owner: { name: 'owner-0', uid: 'original', beginIssued: true },
  };
  let current = {
    metadata: { name: 'journal', resourceVersion: String(version) },
    data: { record: JSON.stringify(record) },
  };
  const calls = [];
  const kube = async (args, extra) => {
    calls.push(args[0]);
    if (args[0] === 'exec') return { stdout: 'accepted' };
    const next = JSON.parse(extra.input);
    if (next.metadata.resourceVersion !== current.metadata.resourceVersion)
      throw Error('Error from server (Conflict): configmap has been modified');
    current = { ...next, metadata: { ...next.metadata, resourceVersion: String(++version) } };
    return { stdout: JSON.stringify(current) };
  };
  return {
    kube,
    calls,
    journal: async () => structuredClone(current),
    heartbeat: () => {
      current.metadata.resourceVersion = String(++version);
    },
  };
}

test('lease-loss injection fences the serialized runner write, not a heartbeat racing the injector', async () => {
  const f = recoveryCasFixture();
  const fault = createHaRecoveryFaultTransport('leaseLoss', f.kube, f.journal, 'journal');
  await fault.send(['exec', 'owner-0', '--begin-only']);
  assert.deepEqual(
    f.calls,
    ['exec'],
    'begin acceptance must not race another controller heartbeat with an injector write',
  );
  assert.equal(fault.state.injected, false);
  f.heartbeat(); // A real heartbeat may advance the API version before the next serialized write.
  const next = await f.journal();
  await assert.rejects(
    fault.send(['replace', '-f', '-'], { input: JSON.stringify(next) }),
    /Error from server \(Conflict\)/,
  );
  assert.deepEqual(f.calls, ['exec', 'replace', 'replace']);
  assert.equal(fault.state.injected, true);
  assert.equal(fault.state.conflictObserved, true);
  assert.equal(fault.state.begins, 1);
  assert.notEqual(JSON.parse((await f.journal()).data.record).runner, 'controller');
  assert.ok(JSON.parse((await f.journal()).data.record).leaseExpiresAt < Date.now());
  const recovered = await f.journal();
  await fault.send(['replace', '-f', '-'], { input: JSON.stringify(recovered) });
  assert.equal(f.calls.filter((value) => value === 'exec').length, 1, 'recovery does not replay begin or reinject');
});

test('lease fault neither mutates a foreign journal nor treats unrelated failures as a confirmed API conflict', async () => {
  for (const mode of ['foreign', 'unavailable', 'injector-unknown']) {
    const f = recoveryCasFixture();
    let replacements = 0;
    const kube = async (args, extra) => {
      if (args[0] === 'replace') {
        replacements++;
        if (mode === 'injector-unknown' || (mode === 'unavailable' && replacements === 2))
          throw Error('connection lost; outcome unknown');
      }
      return f.kube(args, extra);
    };
    const fault = createHaRecoveryFaultTransport('leaseLoss', kube, f.journal, 'journal');
    await fault.send(['exec', 'owner-0', '--begin-only']);
    const next = await f.journal();
    if (mode === 'foreign')
      next.data.record = JSON.stringify({ ...JSON.parse(next.data.record), token: 'another operation' });
    await assert.rejects(fault.send(['replace', '-f', '-'], { input: JSON.stringify(next) }));
    assert.equal(fault.state.conflictObserved, false);
    assert.equal(fault.state.injected, mode === 'unavailable');
    assert.equal(
      replacements,
      mode === 'foreign' ? 0 : mode === 'unavailable' ? 2 : 1,
      'unknown writes and foreign journal state are never retried',
    );
  }
});

test('lost-acknowledgement probe sends the accepted begin once and does not modify its journal', async () => {
  const f = recoveryCasFixture();
  const fault = createHaRecoveryFaultTransport('lostAcknowledgement', f.kube, f.journal, 'journal');
  await assert.rejects(fault.send(['exec', 'owner-0', '--begin-only']), /Injected lost begin acknowledgement/);
  assert.equal(fault.state.injected, true);
  assert.equal(fault.state.begins, 1);
  assert.deepEqual(f.calls, ['exec']);
});

test('an unacknowledged begin cannot arm the lease-loss fault during runner cleanup', async () => {
  const f = recoveryCasFixture();
  const fault = createHaRecoveryFaultTransport(
    'leaseLoss',
    async (args, extra) => {
      if (args[0] === 'exec') throw Error('begin outcome unknown');
      return f.kube(args, extra);
    },
    f.journal,
    'journal',
  );
  await assert.rejects(fault.send(['exec', 'owner-0', '--begin-only']), /begin outcome unknown/);
  await fault.send(['replace', '-f', '-'], { input: JSON.stringify(await f.journal()) });
  assert.equal(fault.state.beginAccepted, false);
  assert.equal(fault.state.injected, false);
  assert.deepEqual(f.calls, ['replace'], 'cleanup records its original outcome without injecting another fault');
});

test('retained browser waits for all old sockets to close and all replacement sessions to finish replay', () => {
  const first = { closed: false, ready: true, resumed: false };
  const second = { closed: false, ready: true, resumed: false };
  const originals = [first, second];
  const replacement = { closed: false, ready: false, resumed: false };
  const sockets = new Set([first, second]);
  assert.equal(
    hasHaBrowserReadyTransport(sockets.values(), originals),
    false,
    'removed pods can still leave half-open browser sockets',
  );
  first.closed = true;
  sockets.delete(first);
  sockets.add(replacement);
  replacement.ready = true;
  replacement.resumed = true;
  assert.equal(
    hasHaBrowserReadyTransport(sockets, originals),
    false,
    'another browser socket has not noticed the lost proxy',
  );
  second.closed = true;
  sockets.delete(second);
  const replaying = { closed: false, ready: false, resumed: true };
  sockets.add(replaying);
  assert.equal(hasHaBrowserReadyTransport(sockets, originals), false, 'TCP open is not ordered session readiness');
  replaying.ready = true;
  assert.equal(hasHaBrowserReadyTransport(sockets, originals), true);
  replaying.resumed = false;
  assert.equal(
    hasHaBrowserReadyTransport(sockets, originals),
    false,
    'a new unrelated session cannot replace an accepted run',
  );
  assert.equal(hasHaBrowserReadyTransport([], originals), false);
});

test('external gateway with only web replacement can retain a healthy unchanged API socket', () => {
  const socket = { closed: false, ready: true, resumed: false };
  assert.equal(hasHaBrowserReadyTransport([socket]), true);
  socket.ready = false;
  assert.equal(hasHaBrowserReadyTransport([socket]), false);
  socket.ready = true;
  socket.closed = true;
  assert.equal(hasHaBrowserReadyTransport([socket]), false);
  assert.equal(hasHaBrowserReadyTransport([]), false);
});

test('local test edge bounds stale WebSockets without changing the long HTTP observation timeout', async (t) => {
  let resources;
  t.mock.method(ManagedReleaseGate.prototype, 'openProxy', async function (target) {
    assert.equal(target, 'service/proof-ha-edge-v2');
    return 'http://test-edge';
  });
  const gate = new HaReleaseGate(
    {
      release: 'proof',
      namespace: 'fixture',
      images: {
        proxy: { repository: 'fixture/proxy', digest: `sha256:${'a'.repeat(64)}` },
      },
    },
    'unused',
    'unused',
  );
  gate.kubectl = async (args, options) => {
    if (args.includes('apply')) resources = JSON.parse(options.input).items;
    return { stdout: '' };
  };
  assert.equal(await gate.openProxy(), 'http://test-edge');
  const config = resources.find((resource) => resource.kind === 'ConfigMap').data['nginx.conf'];
  assert.equal(resources.find((resource) => resource.kind === 'Pod').metadata.name, 'proof-ha-edge-v2');
  assert.match(config, /location \/ws\/ \{[^}]*proxy_read_timeout 45s;/);
  assert.match(config, /location \/ \{[^}]*proxy_read_timeout 600s;/);
  assert.equal(
    resources.find((resource) => resource.kind === 'Pod').metadata.labels['app.kubernetes.io/instance'],
    undefined,
  );
});

test('HA traffic stop includes a late in-flight failure without retrying or retaining secrets', async () => {
  let rejectRequest,
    calls = 0,
    phase = 'leaseLoss:injecting';
  const gate = {
    requestWorkflow: (url, route, options) => {
      calls++;
      assert.equal(url, 'https://staging.example.test');
      assert.equal(route, '/workflows/managed-release-workflow');
      assert.equal(options.timeoutMs, 15_000);
      assert.match(options.headers['x-rivet-ha-probe-id'], /^[a-f0-9-]{36}$/);
      return new Promise((_resolve, reject) => {
        rejectRequest = reject;
      });
    },
  };
  const traffic = startHaWorkflowTraffic(gate, 'https://staging.example.test', () => phase);
  let settled = false;
  const stop = traffic.stop().then((report) => {
    settled = true;
    return report;
  });
  await Promise.resolve();
  assert.equal(settled, false, 'shutdown waits for the actual request');
  phase = 'leaseLoss:settling';
  rejectRequest(
    Object.assign(Error('secret response body'), {
      name: 'TimeoutError',
      cause: { code: 'UND_ERR_SOCKET', token: 'secret-key' },
      status: 504,
    }),
  );
  const report = await stop;
  assert.equal(calls, 1, 'failed POST is never replayed');
  assert.equal(report.samples, 0);
  assert.equal(report.failures.length, 1);
  const failure = report.failedRequests[0];
  assert.equal(failure.phase, 'leaseLoss:injecting', 'capture phase at dispatch, not settlement');
  assert.deepEqual(failure.error, { name: 'TimeoutError', code: 'UND_ERR_SOCKET', status: 504 });
  assert.ok(Number.isFinite(Date.parse(failure.startedAt)));
  assert.ok(Number.isFinite(Date.parse(failure.finishedAt)));
  assert.ok(failure.elapsedMs >= 0);
  assert.equal(report.slowestRequest, failure);
  assert.doesNotMatch(JSON.stringify(report), /secret|authorization|https:/i);
  assert.equal(await traffic.stop(), report, 'repeated stop is observational');
});

test('HA traffic counts successful terminal requests and rejects empty execution responses', async () => {
  for (const result of [{ outputs: {} }, null]) {
    let resolveRequest;
    const traffic = startHaWorkflowTraffic(
      {
        requestWorkflow: () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      },
      'https://staging.example.test',
    );
    const stop = traffic.stop();
    resolveRequest(result);
    const report = await stop;
    assert.equal(report.samples, result ? 1 : 0);
    assert.equal(report.failures.length, result ? 0 : 1);
    assert.equal(report.slowestRequest.phase, 'rollout');
  }
});

test('each disposable HA proof changes both frontend templates even when images are unchanged', () => {
  const base = {
    images: { web: { repository: 'registry/web', digest: `sha256:${'a'.repeat(64)}` } },
    podAnnotations: {
      web: { 'operator/web': 'keep' },
      proxy: { 'operator/proxy': 'keep' },
      backend: { 'operator/backend': 'keep' },
      execution: { 'operator/execution': 'keep' },
      evaluation: { 'operator/evaluation': 'keep' },
    },
  };
  const snapshot = structuredClone(base);
  const first = withHaProofGeneration(base);
  const second = withHaProofGeneration(base);
  assert.deepEqual(base, snapshot);
  assert.deepEqual(first.images, base.images, 'do not fabricate a different workload image');
  for (const role of ['web', 'proxy', 'backend', 'execution']) {
    assert.equal(first.podAnnotations[role][`operator/${role}`], 'keep');
    assert.match(first.podAnnotations[role]['rivet.dev/ha-proof-generation'], /^[a-f0-9-]{36}$/);
    assert.notEqual(
      first.podAnnotations[role]['rivet.dev/ha-proof-generation'],
      second.podAnnotations[role]['rivet.dev/ha-proof-generation'],
    );
  }
  assert.deepEqual(first.podAnnotations.evaluation, base.podAnnotations.evaluation);
});

test('rendered HA proof preserves endpoint withdrawal and the short shutdown challenge', async () => {
  const images = Object.fromEntries(
    ['api', 'web', 'proxy', 'executor'].map((role) => [
      role,
      { repository: `registry/${role}`, digest: `sha256:${'a'.repeat(64)}` },
    ]),
  );
  const gate = new HaReleaseGate(
    {
      images,
      release: 'ha-fixture',
      imagePullPolicy: 'IfNotPresent',
      registry: { secretName: 'fixture-registry' },
      managedWorkflowSchema: readManagedWorkflowSchemaReleaseContract(rootDir),
    },
    'unused',
    'unused',
  );
  const values = gate.values();
  assert.deepEqual(values.lifecycle, {
    preStopDelaySeconds: 5,
    terminationGracePeriodSeconds: 45,
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-render-'));
  try {
    const file = path.join(dir, 'values.json');
    await fs.writeFile(file, JSON.stringify(values));
    const rendered = execFileSync(
      resolveHelmBinOrThrow(rootDir),
      [
        'template',
        'ha-fixture',
        path.join(rootDir, 'deploy/studio-server/helm'),
        '-n',
        'ha-fixture',
        '-f',
        path.join(rootDir, 'deploy/studio-server/helm/overlays/managed-release-gate.yaml'),
        '-f',
        file,
      ],
      { encoding: 'utf8' },
    );
    const workloads = parseAllDocuments(rendered)
      .map((doc) => {
        assert.equal(doc.errors.length, 0);
        return doc.toJSON();
      })
      .filter((value) => ['Deployment', 'StatefulSet'].includes(value?.kind));
    const proxy = workloads.find((value) => value.metadata.labels['app.kubernetes.io/component'] === 'proxy');
    assert.deepEqual(proxy.spec.template.spec.containers[0].lifecycle.preStop.exec.command, [
      '/bin/sh',
      '-c',
      'sleep 5',
    ]);
    for (const workload of workloads) assert.equal(workload.spec.template.spec.terminationGracePeriodSeconds, 45);
    const backend = workloads.find((value) => value.metadata.labels['app.kubernetes.io/component'] === 'backend');
    const env = backend.spec.template.spec.containers.find((value) => value.name === 'backend').env;
    assert.equal(env.find((value) => value.name === 'RIVET_DEPLOYMENT_SHUTDOWN_GRACE_SECONDS').value, '15');
    assert.equal(env.find((value) => value.name === 'RIVET_BACKEND_SHUTDOWN_TIMEOUT_MS').value, '25000');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixed HA baseline installs the predecessor exact schema without changing the candidate contract', async () => {
  const images = Object.fromEntries(
    ['api', 'web', 'proxy', 'executor'].map((role) => [
      role,
      { repository: `registry/${role}`, digest: `sha256:${'a'.repeat(64)}` },
    ]),
  );
  const candidateSchema = readManagedWorkflowSchemaReleaseContract(rootDir);
  const previousSchema = {
    version: candidateSchema.version - 1,
    minimumRollbackCompatibleVersion: candidateSchema.version - 1,
  };
  const previousImages = Object.fromEntries(
    Object.entries(images).map(([role, image]) => [role, { ...image, digest: `sha256:${'b'.repeat(64)}` }]),
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-ha-baseline-'));
  const config = {
    images,
    release: 'ha-fixture',
    namespace: 'ha-fixture',
    artifactsDir: dir,
    imagePullPolicy: 'IfNotPresent',
    registry: { secretName: 'fixture-registry' },
    managedWorkflowSchema: candidateSchema,
  };
  const gate = new HaReleaseGate(config, 'unused', 'unused');
  let baseline;
  gate.assertLocalContext = async () => {};
  gate.kubectl = async () => ({ stdout: '' });
  gate.createNamespace = async () => {};
  gate.createRegistrySecret = async () => {};
  gate.installDependencies = async () => {};
  gate.apply = async (values) => {
    baseline = values;
  };
  gate.openProxy = async () => 'http://fixture';
  gate.exercisePersistence = async () => ({});
  try {
    await gate.prepare(previousImages, previousSchema);
    assert.deepEqual(baseline.workflowSchema.compatibility, {
      minimumVersion: previousSchema.version,
      maximumVersion: previousSchema.version,
    });
    assert.equal(baseline.images.api.digest, previousImages.api.digest);
    const file = path.join(dir, 'baseline.json');
    await fs.writeFile(file, JSON.stringify(baseline));
    const rendered = execFileSync(
      resolveHelmBinOrThrow(rootDir),
      [
        'template',
        'ha-fixture',
        path.join(rootDir, 'deploy/studio-server/helm'),
        '-n',
        'ha-fixture',
        '-f',
        path.join(rootDir, 'deploy/studio-server/helm/overlays/managed-release-gate.yaml'),
        '-f',
        file,
      ],
      { encoding: 'utf8' },
    );
    const resources = parseAllDocuments(rendered).map((doc) => doc.toJS());
    const job = resources.find(
      (value) => value?.kind === 'Job' && value.metadata.name.endsWith('workflow-schema-migration'),
    );
    assert.match(
      job.spec.template.spec.containers[0].args.join(' '),
      new RegExp(
        `RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION="${previousSchema.version}" RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION="${previousSchema.version}"`,
      ),
    );
    assert.equal(
      job.spec.template.spec.containers[0].image,
      `${previousImages.api.repository}@${previousImages.api.digest}`,
    );
    const maintenanceFile = path.join(dir, 'maintenance.json');
    await fs.writeFile(
      maintenanceFile,
      JSON.stringify({
        ...maintenanceValidationValues,
        replicaCount: { ...maintenanceValidationValues.replicaCount, backend: 1 },
      }),
    );
    for (const [flags, policy, backoff] of [
      [[], 'maintenance', 2],
      [['--is-upgrade'], 'rolling', 0],
      [['--is-upgrade', '-f', maintenanceFile], 'maintenance', 2],
    ]) {
      const text = execFileSync(
        resolveHelmBinOrThrow(rootDir),
        [
          'template',
          'ha-fixture',
          path.join(rootDir, 'deploy/studio-server/helm'),
          '-n',
          'ha-fixture',
          '-f',
          path.join(rootDir, 'deploy/studio-server/helm/overlays/managed-release-gate.yaml'),
          '-f',
          file,
          ...flags,
        ],
        { encoding: 'utf8' },
      );
      const migration = parseAllDocuments(text)
        .map((d) => d.toJS())
        .find((r) => r?.kind === 'Job' && r.metadata.name.endsWith('workflow-schema-migration'));
      assert.equal(migration.spec.backoffLimit, backoff);
      assert.ok(
        migration.spec.template.spec.containers[0].args[0].includes(
          `RIVET_MANAGED_SCHEMA_MIGRATION_POLICY="${policy}"`,
        ),
        'Vault loading must not override the operation-selected migration policy',
      );
    }
    assert.deepEqual(gate.values().workflowSchema.compatibility, {
      minimumVersion: candidateSchema.version,
      maximumVersion: candidateSchema.version,
    });
    assert.deepEqual(config.managedWorkflowSchema, candidateSchema);
    assert.deepEqual(config.images, images);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('paused browser proof waits for actual old web and proxy UID removal, not readiness withdrawal', async () => {
  const pod = (uid, component, extra = {}) => ({
    metadata: { uid, labels: { 'app.kubernetes.io/component': component }, ...extra },
  });
  const before = [pod('old-web', 'web'), pod('old-proxy', 'proxy'), pod('unchanged-owner', 'backend')];
  const snapshots = [
    before,
    [pod('old-proxy', 'proxy', { deletionTimestamp: '2026-10-17T12:00:00Z' })],
    [pod('new-web', 'web'), pod('new-proxy', 'proxy'), before[2]],
  ];
  let reads = 0,
    waits = 0;
  const gate = {
    config: { namespace: 'rivet-staging-proof', release: 'rivet-staging-proof' },
    kubectl: async (args) => {
      assert.deepEqual(args.slice(0, 4), ['-n', 'rivet-staging-proof', 'get', 'pods']);
      return { stdout: JSON.stringify({ items: snapshots[reads++] }) };
    },
  };
  await waitForHaFrontendReplacement(gate, before, 30_000, async () => {
    waits++;
  });
  assert.equal(reads, 3);
  assert.equal(waits, 2);
});

test('frontend replacement observation times out without mutating or fabricating browser continuity', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const before = [{ metadata: { uid: 'old-web', labels: { 'app.kubernetes.io/component': 'web' } } }];
  let reads = 0;
  const gate = {
    config: { namespace: 'rivet-staging-proof', release: 'rivet-staging-proof' },
    kubectl: async () => {
      reads++;
      return { stdout: JSON.stringify({ items: before }) };
    },
  };
  await assert.rejects(
    waitForHaFrontendReplacement(gate, before, 1000, async (ms) => {
      now += ms;
    }),
    /Original frontend pods remain/,
  );
  assert.equal(reads, 2);
  await assert.rejects(waitForHaFrontendReplacement(gate, [], 1000));
  assert.equal(reads, 2);
});

test('provider transport retries only read-only TLS handshakes, never uncertain mutations', async () => {
  const timeout = Error('Unable to connect to the server: net/http: TLS handshake timeout');
  for (const args of [
    ['get', 'pods'],
    ['-n', 'staging', '--request-timeout=30s', 'get', 'namespace'],
    ['config', 'view'],
  ]) {
    let calls = 0;
    const waits = [];
    assert.equal(
      await withProviderReadRetry(
        args,
        async () => {
          if (++calls < 3) throw timeout;
          return 'fresh observation';
        },
        async (ms) => {
          waits.push(ms);
        },
      ),
      'fresh observation',
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
  for (const args of [
    ['exec', 'pod', '--', 'retire'],
    ['scale', 'statefulset/owner'],
    ['replace', '-f', '-'],
    ['delete', '--raw', '/pod'],
    ['create', '-f', '-'],
    ['apply', '-f', '-'],
    ['config', 'set-context', 'get'],
    ['--unknown-option', 'get', 'pods'],
  ]) {
    let calls = 0;
    await assert.rejects(
      withProviderReadRetry(
        args,
        async () => {
          calls++;
          throw timeout;
        },
        async () => {
          throw Error('must not wait before replaying a mutation');
        },
      ),
      (error) => error === timeout,
    );
    assert.equal(calls, 1);
  }
  for (const error of [timeout, Error('Forbidden'), Error('namespace identity changed')]) {
    let calls = 0;
    await assert.rejects(
      withProviderReadRetry(
        ['get', 'pods'],
        async () => {
          calls++;
          throw error;
        },
        async () => {},
      ),
      (caught) => caught === error,
    );
    assert.equal(calls, error === timeout ? 3 : 1);
  }
});

test('HA rollout and recovery observations honor the configured provider deadline', () => {
  assert.equal(haProofTimeoutMs({}), 600_000);
  assert.equal(haProofTimeoutMs({ deploymentTimeoutSeconds: 900 }), 900_000);
  assert.equal(haProofTimeoutMs({ deploymentTimeoutSeconds: 180 }), 180_000);
  for (const deploymentTimeoutSeconds of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => haProofTimeoutMs({ deploymentTimeoutSeconds }), /positive whole-second/);
});

test('cross-owner notification fixture authenticates its streams and mutations as a UI operator', async () => {
  const key = 'disposable-notification-test-key';
  const hash = (suffix) => createHash('sha256').update(`${key}:${suffix}`).digest('hex');
  const streams = new Set();
  let revision = 1;
  let library = { migratedLegacyProjectIds: [] };
  let authenticated = 0;
  const server = createServer(async (req, res) => {
    if (
      req.headers['x-rivet-proxy-auth'] !== hash('proxy-auth') ||
      req.headers.cookie !== `rivet_ui_token=${hash('ui-session')}`
    ) {
      res.writeHead(403).end();
      return;
    }
    authenticated++;
    const emit = (stream, event) => stream.write(`event: ${event}\ndata: ${JSON.stringify({ revision })}\n\n`);
    if (req.url.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      streams.add(res);
      res.on('close', () => streams.delete(res));
      emit(res, 'snapshot');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    let result;
    if (req.url.endsWith('/library')) {
      if (req.method === 'PUT') {
        library = body.library;
        revision++;
        for (const stream of streams) emit(stream, 'library-changed');
      }
      result = { revision, library };
    } else {
      revision++;
      for (const stream of streams) emit(stream, 'tree-changed');
      result = { project: { relativePath: 'synthetic.rivet-project' } };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const child = spawn(
      process.execPath,
      [path.join(rootDir, 'deploy/studio-server/scripts/fixtures/ha-notification-probe.mjs'), 'localhost'],
      {
        env: { ...process.env, PORT: String(server.address().port), RIVET_KEY: key, RIVET_HA_HEADLESS_SERVICE: '' },
        windowsHide: true,
        timeout: 20_000,
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).directions.length, 2);
    assert.equal(authenticated, 14);
  } finally {
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recovery faults require the same approved context before traffic or cluster access', async () => {
  await assert.rejects(
    verifyHaReleaseRecovery(
      {
        assertProofContext: async () => {
          throw Error('unapproved recovery context');
        },
        requestWorkflow: async () => {
          throw Error('must not send traffic');
        },
        kubectl: async () => {
          throw Error('must not access cluster');
        },
      },
      'https://staging.example.test',
      rootDir,
    ),
    /unapproved recovery context/,
  );
});

test('shared HA rollout refuses an unapproved proof context before reading keys or changing resources', async () => {
  let touched = false;
  await assert.rejects(
    runHaReleaseRollout(
      {
        config: { images: {} },
        assertProofContext: async () => {
          throw Error('unapproved provider context');
        },
        loadWorkflowKey: async () => {
          touched = true;
        },
      },
      'https://staging.example.test',
    ),
    /unapproved provider context/,
  );
  assert.equal(touched, false);
});

test('provider proof reads the real managed database without creating a local PostgreSQL fixture', async () => {
  const queries = [];
  const probes = new HaReleaseProbes(
    {
      config: { namespace: 'rivet-staging-proof' },
      readProofSql: async (query) => {
        queries.push(query);
        return [{ accepted: true }];
      },
      kubectl: async () => {
        throw Error('local database must not be used');
      },
    },
    'https://staging.example.test',
    rootDir,
  );
  assert.deepEqual(await probes.sql('SELECT accepted'), [{ accepted: true }]);
  assert.deepEqual(queries, ['SELECT accepted']);
});

test('provider proof refuses a changed cluster endpoint, namespace UID or ownership label before mutation', async () => {
  for (const changed of ['endpoint', 'uid', 'label']) {
    const identity = {
      clusterServer: 'https://staging.gke.goog',
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      operation: 'staging-proof',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    const gate = new ProviderHaReleaseGate({ namespace: 'rivet-staging-proof' }, 'unused', 'unused', {
      values: {},
      identity,
    });
    gate.assertContext = async () => {};
    gate.kubectl = async (args) => ({
      stdout: JSON.stringify(
        args[0] === 'config'
          ? {
              clusters: [
                { cluster: { server: changed === 'endpoint' ? 'https://other.gke.goog' : identity.clusterServer } },
              ],
            }
          : {
              metadata: {
                uid: changed === 'uid' ? 'replacement' : identity.namespaceUid,
                labels: { 'rivet.dev/ha-rehearsal': changed === 'label' ? 'someone-else' : identity.operation },
              },
            },
      ),
    });
    await assert.rejects(gate.assertProofContext(), /changed|replaced|not owned/);
  }
});

test('provider proof cannot send its UI credentials to a different origin or execute SQL writes', async () => {
  const gate = new ProviderHaReleaseGate(
    { namespace: 'rivet-staging-proof', baseUrl: 'https://staging.example.test' },
    'unused',
    'unused',
    {
      values: {},
      identity: {
        clusterServer: 'https://staging.gke.goog',
        namespaceUid: '11111111-1111-4111-8111-111111111111',
        operation: 'staging-proof',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    },
  );
  assert.throws(() => gate.requestWorkflow('https://production.example.test', '/api/config'), /staging origin/);
  await assert.rejects(gate.readProofSql('DELETE FROM workflows'), /read-only/);
});

function providerFixture(config = {}, expiresAt = '2099-01-01T00:00:00Z') {
  return new ProviderHaReleaseGate({ namespace: 'rivet-staging-proof', ...config }, 'unused', 'unused', {
    values: {},
    identity: {
      clusterServer: 'https://staging.gke.goog',
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      operation: 'staging-proof',
      expiresAt,
    },
  });
}

test('provider close retains its operator namespace even when local cleanup is requested', async () => {
  const gate = providerFixture({ keepNamespace: false });
  gate.kubectl = async () => {
    throw Error('provider close must not access or delete infrastructure');
  };
  let stopped = 0;
  gate.portForward = {
    killed: false,
    kill() {
      this.killed = true;
      stopped++;
    },
  };
  gate.portForwardClosed = Promise.resolve();
  await gate.close();
  await gate.close();
  assert.equal(stopped, 1);
  assert.equal(gate.config.keepNamespace, true);
});

test('port-forward selects only a verified native Chocolatey kubectl target', () => {
  const target = 'C:\\tools\\native\\kubectl.exe';
  let inspected = 0;
  const options = {
    platform: 'win32',
    find: () => 'C:\\tools\\kubectl.exe',
    exists: (value) => value === target,
    inspect: (_bin, args, settings) => {
      inspected++;
      assert.deepEqual(args, ['--shimgen-help']);
      assert.equal(settings.timeout, 5_000);
      return {
        status: 1,
        stdout: `This is a shim, generated by Chocolatey's ShimGenerator (shimgen).\n Target: '${target}'\n command (optional): ''\n`,
      };
    },
  };
  assert.equal(resolveKubectlForwardBin('kubectl', options), target);
  assert.equal(resolveKubectlForwardBin('kubectl', { ...options, platform: 'linux' }), 'kubectl');
  assert.equal(inspected, 1);
  assert.equal(
    resolveKubectlForwardBin('kubectl', {
      ...options,
      inspect: () => ({ stdout: '', error: Error('native unknown flag') }),
    }),
    'C:\\tools\\kubectl.exe',
  );
  assert.throws(() => resolveKubectlForwardBin('kubectl', { ...options, exists: () => false }), /native kubectl/);
  for (const [value, command] of [
    [target, '--context other'],
    ['relative.exe', ''],
  ]) {
    assert.throws(
      () =>
        resolveKubectlForwardBin('kubectl', {
          ...options,
          inspect: () => ({
            stdout: `This is a shim, generated by Chocolatey's ShimGenerator (shimgen).\n Target: '${value}'\n command (optional): '${command}'\n`,
          }),
        }),
      /native kubectl/,
    );
  }
});

test('port-forward shutdown waits for close, is repeatable and fences cleanup when uncertain', async () => {
  const gate = new ManagedReleaseGate({ keepNamespace: false }, 'unused', 'unused');
  let kills = 0,
    deletes = 0,
    settled;
  gate.deleteOwnedNamespace = async () => {
    deletes++;
  };
  const child = {
    killed: false,
    kill() {
      this.killed = true;
      kills++;
    },
  };
  gate.portForward = child;
  gate.portForwardClosed = new Promise((resolve) => {
    settled = resolve;
  });
  await assert.rejects(gate.stopPortForward({ timeoutMs: 5 }), /did not close/);
  assert.equal(gate.portForward, child);
  assert.equal(kills, 1);
  const close = gate.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deletes, 0);
  assert.equal(gate.portForward, child);
  settled();
  await close;
  assert.equal(deletes, 1);
  assert.equal(kills, 1);
  assert.equal(gate.portForward, null);
  await gate.stopPortForward();
  assert.equal(kills, 1);
});

test('expired provider rehearsal refuses work before contacting the cluster or reading credentials', async () => {
  const gate = providerFixture({}, '2000-01-01T00:00:00Z');
  gate.assertContext = gate.loadWorkflowKey = async () => {
    throw Error('must not contact resources');
  };
  await assert.rejects(gate.seed(), /expired/);
});

test('provider expiry during a read retry or identity check still fences the next mutation', async (t) => {
  const gate = providerFixture();
  const expiry = Date.parse(gate.identity.expiresAt);
  let now = expiry - 1;
  t.mock.method(Date, 'now', () => now);
  gate.assertContext = async () => {};
  gate.kubectl = async (args) => {
    if (args[0] === 'config')
      return { stdout: JSON.stringify({ clusters: [{ cluster: { server: gate.identity.clusterServer } }] }) };
    now = expiry;
    return {
      stdout: JSON.stringify({
        metadata: { uid: gate.identity.namespaceUid, labels: { 'rivet.dev/ha-rehearsal': gate.identity.operation } },
      }),
    };
  };
  await assert.rejects(gate.assertProofContext(), /expired during identity checks/);
});

test('uncertain provider seed cannot replay any application mutation', async () => {
  const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-provider-seed-'));
  try {
    const gate = providerFixture({ artifactsDir });
    gate.assertProofContext = gate.loadWorkflowKey = async () => {};
    let writes = 0;
    gate.requestWorkflow = async () => {
      writes++;
      throw Error('lost response after acceptance');
    };
    await assert.rejects(gate.seed(), /lost response/);
    await assert.rejects(gate.seed(), { code: 'EEXIST' });
    assert.equal(writes, 1);
  } finally {
    await fs.rm(artifactsDir, { recursive: true, force: true });
  }
});

test('provider observations run inside a database read-only transaction even for SELECT with side effects', async () => {
  const gate = providerFixture({ release: 'rivet-staging-proof' });
  gate.kubectl = async (args) => {
    assert.ok(args.includes('rivet-staging-proof-ha-backend-0'));
    assert.match(args[args.indexOf('-e') + 1], /BEGIN READ ONLY/);
    assert.equal(args.at(-1), 'SELECT destructive_function()');
    return { stdout: '7' };
  };
  assert.equal(await gate.readProofSql('SELECT destructive_function()'), 7);
});

test('provider browser uses the ordinary authenticated session without following redirects', async () => {
  const gate = providerFixture({ baseUrl: 'https://staging.example.test' });
  gate.secrets = { rivetKey: 'test-only-key' };
  await gate.authenticateBrowser({
    request: {
      post: async (url, options) => {
        assert.equal(url, 'https://staging.example.test/__rivet_auth');
        assert.deepEqual(options, { data: { key: 'test-only-key' }, maxRedirects: 0 });
        return { status: () => 204 };
      },
    },
  });
  await assert.rejects(
    gate.authenticateBrowser({ request: { post: async () => ({ status: () => 302 }) } }),
    /real authenticated/,
  );
});

test('provider HTTP login uses the public proxy contract and retains only its session cookie', async () => {
  const server = createServer(async (req, res) => {
    if (req.url !== '/__rivet_auth') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.method, 'POST');
    assert.deepEqual(JSON.parse(body), { key: 'test-only-key' });
    res
      .writeHead(204, { 'set-cookie': 'rivet_ui_token=test-only-session; Path=/; HttpOnly; Secure; SameSite=Lax' })
      .end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const gate = providerFixture({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    gate.providerValues.auth = { keySecretName: 'fixture' };
    gate.kubectl = async () => ({
      stdout: JSON.stringify({ data: { RIVET_KEY: Buffer.from('test-only-key').toString('base64') } }),
    });
    await gate.loadWorkflowKey();
    assert.deepEqual(gate.probeHeaders, { cookie: 'rivet_ui_token=test-only-session' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
function certificationFixture(predecessorRelease = null) {
  const images = Object.fromEntries(
    ['proxy', 'web', 'api', 'executor'].map((key, index) => [
      key,
      { repository: `example.test/rivet/${key}`, digest: `sha256:${String(index + 1).repeat(64)}` },
    ]),
  );
  const sourceSha = 'a'.repeat(40);
  const manifest = createStudioServerReleaseManifest({
    rootDir,
    source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: sourceSha },
    images,
    candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
    predecessorRelease,
  });
  return { manifest, options: { rootDir, sourceSha, images, previous: predecessorRelease } };
}

test('HA certification accepts exact candidates without treating them as deployable releases', () => {
  const { manifest, options } = certificationFixture();
  assert.equal(validateHaCertificationManifest(manifest, options).mode, 'bootstrap');
  const reordered = Object.fromEntries(Object.entries(options.images).reverse());
  assert.equal(validateHaCertificationManifest(manifest, { ...options, images: reordered }).mode, 'bootstrap');
  const promoted = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  assert.throws(() => validateHaCertificationManifest(promoted, options), /requires a candidate/);
});

test('HA candidate preflight preserves source, chart, image and exact predecessor checks', () => {
  const { manifest, options } = certificationFixture();
  assert.throws(
    () => validateHaCertificationManifest(manifest, { ...options, sourceSha: 'b'.repeat(40) }),
    /current checkout/,
  );
  assert.throws(
    () =>
      validateHaCertificationManifest(
        {
          ...manifest,
          chart: { ...manifest.chart, contentDigest: `sha256:${'f'.repeat(64)}` },
        },
        options,
      ),
    /current Helm chart/,
  );
  assert.throws(
    () =>
      validateHaCertificationManifest(manifest, {
        ...options,
        images: { ...options.images, api: { ...options.images.api, digest: `sha256:${'f'.repeat(64)}` } },
      }),
    /HA images must match/,
  );
  const previous = promoteStudioServerReleaseManifest(manifest, {
    promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
  });
  const next = certificationFixture(previous);
  assert.equal(validateHaCertificationManifest(next.manifest, next.options).mode, 'bootstrap');
  assert.throws(
    () => validateHaCertificationManifest(next.manifest, { ...next.options, previous: null }),
    /predecessor/,
  );
});

test('disposable PostgreSQL really provides the HA fixture connection budget', async () => {
  const gate = new HaReleaseGate({ namespace: 'fixture' }, 'unused', 'unused');
  let postgres;
  gate.kubectl = async (args, extra) => {
    if (args[0] === 'get') return { stdout: 'local-node' };
    if (extra?.input)
      for (const doc of parseAllDocuments(extra.input)) {
        assert.equal(doc.errors.length, 0);
        const resource = doc.toJSON();
        if (resource?.kind === 'Deployment' && resource.metadata.name === 'release-gate-postgres')
          postgres = resource.spec.template.spec.containers[0];
      }
    return { stdout: '' };
  };
  gate.waitForDependency = async () => {};
  await gate.installDependencies();
  assert.deepEqual(postgres.args, ['postgres', '-c', 'max_connections=250']);
});

test('HA preparation never deletes or rotates Secrets in an existing namespace', async () => {
  const gate = new HaReleaseGate({ namespace: 'existing' }, 'unused', 'unused');
  const calls = [];
  gate.assertLocalContext = async () => {};
  gate.kubectl = async (args) => {
    calls.push(args);
    return { stdout: 'namespace/existing\n' };
  };
  gate.createNamespace = async () => {
    throw Error('must not mutate');
  };
  await assert.rejects(gate.prepare(), /fresh disposable namespace/);
  assert.deepEqual(calls, [['get', 'namespace', 'existing', '--ignore-not-found', '-o', 'name']]);
});

test('the local proof cannot select a production context, even when allow-context matches', async () => {
  const gate = new HaReleaseGate({ context: 'gke-production', allowedContext: 'gke-production' }, 'unused', 'unused');
  gate.kubectl = async () => {
    throw Error('must not access cluster');
  };
  await assert.rejects(gate.assertLocalContext(), /disposable local cluster/);
});

test('baseline publisher is isolated, digest-pinned and cleaned up after success or failure', async () => {
  for (const failure of [false, true]) {
    const calls = [];
    const gate = {
      config: { namespace: 'disposable', release: 'fixture' },
      assertLocalContext: async () => {},
      kubectl: async (args, options) => {
        const command = args[2];
        calls.push({ command, args, options });
        if (command === 'get')
          return {
            stdout: JSON.stringify({
              items: [
                {
                  status: { conditions: [{ type: 'Ready', status: 'True' }] },
                  spec: {
                    containers: [
                      {
                        name: 'web',
                        image: 'current',
                        lifecycle: { preStop: { exec: { command: ['sleep', '120'] } } },
                        env: [{ name: 'RIVET_WEB_ASSETS_INSTALLATION', value: 'disposable/fixture' }],
                      },
                    ],
                  },
                },
              ],
            }),
          };
        if (command === 'exec') {
          if (failure) throw Error('publication failed');
          return { stdout: 'a'.repeat(64) };
        }
        return { stdout: '' };
      },
    };
    const image = { repository: 'registry/web', digest: `sha256:${'b'.repeat(64)}` };
    if (failure) await assert.rejects(publishHaBrowserBaseline(gate, image), /publication failed/);
    else assert.deepEqual(await publishHaBrowserBaseline(gate, image), { ...image, build: 'a'.repeat(64) });
    const pod = JSON.parse(calls.find((c) => c.command === 'create').options.input);
    assert.equal(pod.spec.containers[0].image, `${image.repository}@${image.digest}`);
    assert.equal(pod.spec.containers[0].lifecycle, undefined, 'non-serving publisher needs no edge-drain hook');
    assert.equal(pod.metadata.labels, undefined, 'publisher must not enter a release Service');
    assert.equal(calls.at(-1).command, 'delete');
  }
});
