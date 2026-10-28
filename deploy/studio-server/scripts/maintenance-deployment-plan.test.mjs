import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import test from 'node:test';
import {
  assertMaintenancePlan,
  readMaintenancePlan,
  assertMaintenanceBaseline,
  verifyRecoveryReceipt,
  captureMaintenanceCheckpoint,
  executeMaintenanceBackupAdapter,
  verifyRetainedMaintenanceMigration,
  preflightMaintenanceMigration,
  verifyMaintenanceMigrationReceipt,
} from './lib/maintenance-deployment-plan.mjs';
import {
  createStudioServerReleaseManifest,
  promoteStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './lib/studio-server-release-manifest.mjs';

const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const manifestDigest = (manifest) => getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true });
function promoted(source, prior = null) {
  return promoteStudioServerReleaseManifest(
    createStudioServerReleaseManifest({
      rootDir,
      source: { repository: 'valerypopoff/rivet2.0', ref: 'refs/heads/main', sha: source.repeat(40) },
      images: Object.fromEntries(
        ['api', 'executor', 'proxy', 'web'].map((role, index) => [
          role,
          { repository: `example.test/${source}/${role}`, digest: digest(String(index + 1)) },
        ]),
      ),
      candidateEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 },
      predecessorRelease: prior,
    }),
    { promotionEvidence: { workflow: 'Build Images', runId: '123', runAttempt: 1 } },
  );
}
async function fixture(t, script = '// reviewed backup adapter\n', schemaChange = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-maintenance-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseline = promoted('a');
  if (schemaChange)
    baseline.database.managedWorkflowSchema = {
      version: baseline.database.managedWorkflowSchema.version - 1,
      minimumRollbackCompatibleVersion: baseline.database.managedWorkflowSchema.version - 1,
    };
  const candidate = promoted('b', baseline);
  const now = Date.now();
  const plan = {
    formatVersion: 1,
    kind: 'rivet-maintenance-deployment',
    release: 'rivet',
    namespace: 'rivet',
    context: 'explicit-production-context',
    namespaceUid: 'namespace-uid',
    reason: 'approved maintenance',
    valuesDigest: hash('reviewed operator values'),
    candidateManifestDigest: manifestDigest(candidate),
    installedManifestDigest: manifestDigest(baseline),
    installedManifestPath: 'baseline.json',
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    accepts: { interruption: true, qualificationWaived: true, dataLoss: false },
    backup: { script: 'backup.mjs', sha256: hash(script) },
    ...(schemaChange
      ? {
          schemaMigration: {
            fromVersion: baseline.database.managedWorkflowSchema.version,
            toVersion: candidate.database.managedWorkflowSchema.version,
            script: 'backup.mjs',
            sha256: hash(script),
          },
        }
      : {}),
  };
  const identity = {
    release: plan.release,
    namespace: plan.namespace,
    context: plan.context,
    candidateDigest: plan.candidateManifestDigest,
    valuesDigest: plan.valuesDigest,
    manifest: candidate,
  };
  await fs.writeFile(path.join(root, 'baseline.json'), JSON.stringify(baseline));
  await fs.writeFile(path.join(root, 'backup.mjs'), script);
  await fs.writeFile(path.join(root, 'plan.json'), JSON.stringify(plan));
  const artifactsDir = path.join(root, 'artifacts');
  await fs.mkdir(artifactsDir);
  const approval = await readMaintenancePlan('plan.json', root, identity);
  const installed = {
    release: {
      production: {
        manifestDigest: plan.installedManifestDigest,
        database: { managedWorkflowSchemaVersion: baseline.database.managedWorkflowSchema.version },
      },
    },
  };
  const context = {
    token: 'owned-token',
    release: plan.release,
    namespace: plan.namespace,
    manifestDigest: plan.candidateManifestDigest,
    operationPlanDigest: approval.digest,
    phase: 'quiesced',
    leaseExpiresAt: now + 120_000,
  };
  const journal = { ...context, phase: 'validating' };
  return { root, artifactsDir, baseline, candidate, plan, identity, approval, installed, context, journal };
}
function baselineOptions(state, extra = {}) {
  return { installed: state.installed, manifest: state.candidate, namespaceUid: state.plan.namespaceUid, ...extra };
}
async function validReceipt(directory, request) {
  const artifacts = [];
  for (const role of ['database', 'objects', 'keys', 'verification']) {
    const content = `verified ${role}`;
    const file = `${role}.private`;
    await fs.writeFile(path.join(directory, file), content);
    artifacts.push({ role, path: file, sha256: hash(content) });
  }
  return {
    formatVersion: 1,
    kind: 'rivet-frozen-recovery-checkpoint',
    release: request.release,
    namespace: request.namespace,
    context: request.context,
    consistency: request.consistency ?? 'quiesced',
    capturedAt: new Date().toISOString(),
    requestId: request.requestId,
    token: request.token,
    namespaceUid: request.namespaceUid,
    operationPlanDigest: request.operationPlanDigest,
    candidateManifestDigest: request.candidateManifestDigest,
    installedManifestDigest: request.installedManifestDigest,
    databaseRestoreVerified: true,
    objectReferencesCovered: true,
    encryptionKeysRecoverable: true,
    unrelatedDataExcluded: true,
    artifacts,
  };
}
const fakeHook = async (_script, requestPath, receiptPath, { directory }) => {
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  if (['migration-validation', 'migration-preflight'].includes(request.stage)) {
    const bytes = 'restored-copy migration and preservation evidence';
    await fs.writeFile(path.join(directory, 'migration.json'), bytes);
    await fs.writeFile(
      receiptPath,
      JSON.stringify({
        ...request,
        kind: `rivet-maintenance-${request.stage}`,
        passed: true,
        supportsSchemaMigration: true,
        candidateImageVerified: true,
        restoreEnvironmentReady: true,
        isolatedRestore: true,
        migrationApplied: true,
        targetSchemaVerified: true,
        preservedDataVerified: true,
        oldDatabaseReadersStopped: true,
        unrelatedDataExcluded: true,
        verifiedAt: new Date().toISOString(),
        artifacts: [{ role: 'verification', path: 'migration.json', sha256: hash(bytes) }],
      }),
    );
    return;
  }
  await fs.writeFile(receiptPath, JSON.stringify(await validReceipt(directory, request)));
};

test('loads a checksum-pinned local plan and exact promoted baseline without manufacturing qualification', async (t) => {
  const state = await fixture(t);
  assert.equal(state.approval.digest, hash(await fs.readFile(path.join(state.root, 'plan.json'))));
  assert.equal(state.approval.baseline.state, 'promoted');
  assert.equal(state.candidate.evidence.runtimeControl, undefined);
  assertMaintenanceBaseline(state.approval, baselineOptions(state));
});

test('rejects expired, future, overlong or mismatched new-operation approval', async (t) => {
  const state = await fixture(t);
  const now = Date.now();
  for (const change of [
    { expiresAt: new Date(now - 1).toISOString() },
    { issuedAt: new Date(now + 1_000).toISOString() },
    { expiresAt: new Date(now + 3 * 3_600_000).toISOString() },
    { expiresAt: state.plan.issuedAt },
    { release: 'foreign' },
    { namespace: 'foreign' },
    { context: 'foreign' },
    { candidateManifestDigest: digest('e') },
    { namespaceUid: '' },
    { valuesDigest: undefined },
    { valuesDigest: digest('f') },
    { accepts: { interruption: true, qualificationWaived: true, dataLoss: true } },
    { backup: { ...state.plan.backup, script: 'backup.cmd' } },
  ])
    assert.throws(
      () => assertMaintenancePlan({ ...state.plan, ...change }, { ...state.identity, now }),
      /Invalid, expired or mismatched/,
    );
});

test('approval binds the exact operator values bytes and rejects absent or changed values identity', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    readMaintenancePlan('plan.json', state.root, {
      ...state.identity,
      valuesDigest: hash('different storage settings'),
    }),
    /mismatched/,
  );
  await assert.rejects(
    readMaintenancePlan('plan.json', state.root, { ...state.identity, valuesDigest: undefined }),
    /mismatched/,
  );
  const approval = await readMaintenancePlan('plan.json', state.root, state.identity);
  assert.equal(approval.plan.valuesDigest, state.identity.valuesDigest);
});

test('read rejects altered baseline, adapter checksum and malformed input without leaking input contents', async (t) => {
  const state = await fixture(t);
  await fs.writeFile(path.join(state.root, 'backup.mjs'), '// changed');
  await assert.rejects(readMaintenancePlan('plan.json', state.root, state.identity), /script has changed/);
  await fs.writeFile(path.join(state.root, 'baseline.json'), JSON.stringify(state.candidate));
  await assert.rejects(readMaintenancePlan('plan.json', state.root, state.identity), /exact promoted installed/);
  await fs.writeFile(path.join(state.root, 'plan.json'), '{sensitive-invalid-json');
  await assert.rejects(readMaintenancePlan('plan.json', state.root, state.identity), (error) => {
    assert.equal(error.message.includes('sensitive-invalid-json'), false);
    return /not valid JSON/.test(error.message);
  });
});

test('rejects lexical and symlink-parent escape from the repository', async (t) => {
  const state = await fixture(t);
  await assert.rejects(readMaintenancePlan('../outside.json', state.root, state.identity), /repository-contained/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-plan-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'plan.json'), JSON.stringify(state.plan));
  try {
    await fs.symlink(outside, path.join(state.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('This sandbox does not permit creating symlinks.');
    return;
  }
  await assert.rejects(readMaintenancePlan('linked/plan.json', state.root, state.identity), /repository-contained/);
});

test('live identity and schema must match; candidate-installed state requires explicit exact recovery', async (t) => {
  const state = await fixture(t);
  assert.throws(
    () => assertMaintenanceBaseline(state.approval, baselineOptions(state, { namespaceUid: 'recreated' })),
    /namespace identity/,
  );
  state.installed.release.production.manifestDigest = state.plan.candidateManifestDigest;
  assert.throws(() => assertMaintenanceBaseline(state.approval, baselineOptions(state)), /live release/);
  assert.throws(
    () => assertMaintenanceBaseline(state.approval, baselineOptions(state, { recovering: true })),
    /exact unfinished journal/,
  );
  const recovery = { recovering: true, recoveryJournal: state.journal, resumeToken: state.context.token };
  assertMaintenanceBaseline(state.approval, baselineOptions(state, recovery));
  state.installed.release.production.database.managedWorkflowSchemaVersion += 1;
  assert.throws(
    () => assertMaintenanceBaseline(state.approval, baselineOptions(state, recovery)),
    /installed schema identity differs/,
  );
});

test('approval expiry prevents new deployment but permits the exact unfinished recovery after its deadline', async (t) => {
  const state = await fixture(t);
  const expired = Date.parse(state.plan.expiresAt) + 1_000;
  await assert.rejects(readMaintenancePlan('plan.json', state.root, { ...state.identity, now: expired }), /expired/);
  const approval = await readMaintenancePlan('plan.json', state.root, {
    ...state.identity,
    now: expired,
    allowExpiredForRecovery: true,
  });
  assert.throws(() => assertMaintenanceBaseline(approval, baselineOptions(state, { now: expired })), /expired/);
  const recovery = { recovering: true, recoveryJournal: state.journal, resumeToken: state.context.token, now: expired };
  assertMaintenanceBaseline(approval, baselineOptions(state, recovery));
  for (const changes of [
    { token: 'other' },
    { phase: 'complete' },
    { operationPlanDigest: digest('e') },
    { manifestDigest: digest('f') },
    { namespace: 'foreign' },
  ]) {
    assert.throws(
      () =>
        assertMaintenanceBaseline(
          approval,
          baselineOptions(state, {
            ...recovery,
            recoveryJournal: { ...state.journal, ...changes },
          }),
        ),
      /exact unfinished journal/,
    );
  }
});

test('a candidate schema change cannot use an unchanged-schema maintenance approval', async (t) => {
  const state = await fixture(t);
  state.candidate.database.managedWorkflowSchema.version += 1;
  state.plan.candidateManifestDigest = manifestDigest(state.candidate);
  state.approval.plan = state.plan;
  assert.throws(
    () => assertMaintenanceBaseline(state.approval, baselineOptions(state)),
    /explicit schemaMigration approval/,
  );
});

test('schema-changing waiver binds forward migration, restored checkpoint and retained verification bytes', async (t) => {
  const state = await fixture(t, '// reviewed adapter', true);
  const route = assertMaintenanceBaseline(state.approval, baselineOptions(state));
  assert.equal(route.migrationRequired, true);
  assert.equal(route.qualification, 'waived');
  const result = await captureMaintenanceCheckpoint(state.approval, state.context, {
    artifactsDir: state.artifactsDir,
    timeoutMs: 1000,
    runHook: fakeHook,
  });
  const request = JSON.parse(await fs.readFile(path.join(result.directory, 'request.json'), 'utf8'));
  const receipt = JSON.parse(await fs.readFile(path.join(result.directory, 'receipt.json'), 'utf8'));
  await verifyRetainedMaintenanceMigration(state.approval, result.directory, request, receipt);
  const proof = path.join(result.directory, 'migration-validation/receipt.json');
  const valid = JSON.parse(await fs.readFile(proof, 'utf8'));
  for (const change of [
    { migrationApplied: false },
    { oldDatabaseReadersStopped: false },
    { checkpointDirectory: path.join(result.directory, 'another-checkpoint') },
    { stage: 'migration-preflight' },
    { checkpointReceiptDigest: digest('e') },
    { schemaMigration: { ...valid.schemaMigration, toVersion: 999 } },
  ]) {
    await fs.writeFile(proof, JSON.stringify({ ...valid, ...change }));
    await assert.rejects(
      verifyRetainedMaintenanceMigration(state.approval, result.directory, request, receipt),
      /incomplete/,
    );
  }
  await fs.writeFile(proof, JSON.stringify(valid));
  const requestFile = path.join(result.directory, 'migration-validation/request.json');
  const migrationRequest = JSON.parse(await fs.readFile(requestFile, 'utf8'));
  await assert.rejects(
    verifyMaintenanceMigrationReceipt({ ...valid, stage: 'unknown' }, path.dirname(proof), {
      ...migrationRequest,
      stage: 'unknown',
    }),
    /incomplete/,
  );
  const redirected = { checkpointDirectory: path.join(result.directory, 'another-checkpoint') };
  await fs.writeFile(requestFile, JSON.stringify({ ...migrationRequest, ...redirected }));
  await fs.writeFile(proof, JSON.stringify({ ...valid, ...redirected }));
  await assert.rejects(
    verifyRetainedMaintenanceMigration(state.approval, result.directory, request, receipt),
    /Retained migration proof/,
  );
  await fs.writeFile(requestFile, JSON.stringify({ ...migrationRequest, stage: 'migration-preflight' }));
  await fs.writeFile(
    proof,
    JSON.stringify({
      ...valid,
      kind: 'rivet-maintenance-migration-preflight',
      passed: true,
      supportsSchemaMigration: true,
      candidateImageVerified: true,
      restoreEnvironmentReady: true,
    }),
  );
  await assert.rejects(
    verifyRetainedMaintenanceMigration(state.approval, result.directory, request, receipt),
    /Retained migration proof/,
  );
  await fs.writeFile(requestFile, JSON.stringify(migrationRequest));
  await fs.writeFile(proof, JSON.stringify(valid));
  await fs.writeFile(path.join(result.directory, 'migration-validation/migration.json'), 'changed');
  await assert.rejects(
    verifyRetainedMaintenanceMigration(state.approval, result.directory, request, receipt),
    /checksum/,
  );
});

test('migration preflight requires actual reviewed adapter prerequisites before a checkpoint or downtime', async (t) => {
  const state = await fixture(t, '// reviewed adapter', true);
  const result = await preflightMaintenanceMigration(state.approval, {
    artifactsDir: state.artifactsDir,
    timeoutMs: 1000,
    runHook: fakeHook,
  });
  assert.equal(result.verified, true);
  const files = await fs.readdir(state.artifactsDir);
  assert.ok(files.every((file) => file.startsWith('migration-preflight-')));
  await assert.rejects(
    preflightMaintenanceMigration(state.approval, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1000,
      runHook: async (_script, requestPath, receiptPath, { directory }) => {
        const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
        await fs.writeFile(receiptPath, JSON.stringify(await validReceipt(directory, request)));
      },
    }),
    /migration validation is incomplete/,
  );
});

test('unapproved, changed or failed migration validation blocks a verified checkpoint', async (t) => {
  const state = await fixture(t, '// reviewed adapter', true);
  const original = structuredClone(state.plan);
  for (const change of [{ fromVersion: state.plan.schemaMigration.toVersion }, { toVersion: 0 }, { script: 'run.cmd' }])
    assert.throws(
      () =>
        assertMaintenancePlan(
          { ...state.plan, schemaMigration: { ...state.plan.schemaMigration, ...change } },
          state.identity,
        ),
      /Schema-changing/,
    );
  const stages = [];
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1000,
      runHook: async (...args) => {
        const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
        stages.push(request.stage ?? 'backup');
        if (request.stage === 'migration-validation') throw Error('restored migration failed');
        return fakeHook(...args);
      },
    }),
    /restored migration failed/,
  );
  assert.deepEqual(stages, ['backup', 'migration-validation']);
  assert.deepEqual(state.plan, original);
});

test('capture creates fresh operation-bound recovery files and verifies every required role', async (t) => {
  const state = await fixture(t);
  const report = await captureMaintenanceCheckpoint(state.approval, state.context, {
    artifactsDir: state.artifactsDir,
    timeoutMs: 1_000,
    runHook: fakeHook,
  });
  assert.equal(report.verified, true);
  assert.equal(report.artifactCount, 4);
  const second = await captureMaintenanceCheckpoint(state.approval, state.context, {
    artifactsDir: state.artifactsDir,
    timeoutMs: 1_000,
    runHook: fakeHook,
  });
  assert.notEqual(second.requestId, report.requestId);
  assert.equal((await fs.readdir(state.artifactsDir)).length, 2);
});

test('explicit maintenance capture rejects stale, future or wrong-installation recovery evidence', async (t) => {
  const state = await fixture(t);
  for (const change of [
    { release: 'another-release' },
    { namespace: 'another-namespace' },
    { context: 'another-context' },
    { consistency: 'online' },
    { capturedAt: undefined },
    { capturedAt: 'not-a-timestamp' },
    { capturedAt: '2000-01-01T00:00:00Z' },
    { capturedAt: '2999-01-01T00:00:00Z' },
  ]) {
    await assert.rejects(
      captureMaintenanceCheckpoint(state.approval, state.context, {
        artifactsDir: state.artifactsDir,
        timeoutMs: 1_000,
        runHook: async (_script, requestPath, receiptPath, { directory }) => {
          const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
          await fs.writeFile(receiptPath, JSON.stringify({ ...(await validReceipt(directory, request)), ...change }));
        },
      }),
      /another operation|capture point/,
    );
  }
  for (const directory of await fs.readdir(state.artifactsDir))
    await assert.rejects(fs.stat(path.join(state.artifactsDir, directory, 'verified.json')), { code: 'ENOENT' });
});

test('capture validates quiesced lease identity before invoking an adapter or writing recovery files', async (t) => {
  const state = await fixture(t);
  let calls = 0;
  for (const change of [
    { token: '' },
    { phase: 'resuming' },
    { namespace: 'wrong' },
    { manifestDigest: digest('f') },
    { operationPlanDigest: digest('e') },
    { leaseExpiresAt: 0 },
  ]) {
    await assert.rejects(
      captureMaintenanceCheckpoint(
        state.approval,
        { ...state.context, ...change },
        {
          artifactsDir: state.artifactsDir,
          timeoutMs: 1_000,
          runHook: async () => {
            calls++;
          },
        },
      ),
      /matching live quiesced/,
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(await fs.readdir(state.artifactsDir), []);
});

test('frozen checkpoint metadata cannot be rewritten by backup or migration adapters', async (t) => {
  for (const [stage, metadata] of [
    ['backup', 'request.json'],
    ['migration-validation', 'request.json'],
    ['migration-validation', 'receipt.json'],
    ['migration-validation', 'migration-validation/request.json'],
  ]) {
    const state = await fixture(t, '// reviewed adapter', stage === 'migration-validation');
    await assert.rejects(
      captureMaintenanceCheckpoint(state.approval, state.context, {
        artifactsDir: state.artifactsDir,
        timeoutMs: 1000,
        runHook: async (...args) => {
          await fakeHook(...args);
          const request = JSON.parse(await fs.readFile(args[1], 'utf8'));
          if (request.stage !== stage) return;
          const parent = stage === 'backup' ? path.dirname(args[1]) : request.checkpointDirectory;
          const file = path.join(parent, metadata);
          const changed = JSON.parse(await fs.readFile(file, 'utf8'));
          changed.formatVersion = 999;
          await fs.writeFile(file, JSON.stringify(changed));
        },
      }),
      /checkpoint metadata changed/,
      `${stage} changed ${metadata}`,
    );
    for (const directory of await fs.readdir(state.artifactsDir))
      await assert.rejects(fs.stat(path.join(state.artifactsDir, directory, 'verified.json')), { code: 'ENOENT' });
  }
});

test('a validly admitted operation can finish after the plan admission deadline', async (t) => {
  const state = await fixture(t);
  state.plan.issuedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
  state.plan.expiresAt = new Date(Date.now() - 3_600_000).toISOString();
  state.approval.plan = state.plan;
  const report = await captureMaintenanceCheckpoint(state.approval, state.context, {
    artifactsDir: state.artifactsDir,
    timeoutMs: 1_000,
    runHook: fakeHook,
  });
  assert.equal(report.verified, true);
});

test('capture refuses escaped artifact directories and adapters changed since initial plan validation', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: os.tmpdir(),
      timeoutMs: 1_000,
      runHook: fakeHook,
    }),
    /directory must remain/,
  );
  await fs.writeFile(path.join(state.root, 'backup.mjs'), '// replaced');
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1_000,
      runHook: fakeHook,
    }),
    /adapter changed/,
  );
  assert.deepEqual(await fs.readdir(state.artifactsDir), []);
});

test('an adapter cannot replace the checkpoint directory and certify the replacement', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1_000,
      runHook: async (_script, requestPath, receiptPath, { directory }) => {
        const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
        await fs.rename(directory, `${directory}-original`);
        await fs.mkdir(directory);
        await fs.writeFile(receiptPath, JSON.stringify(await validReceipt(directory, request)));
      },
    }),
    /directory identity changed/,
  );
  for (const name of await fs.readdir(state.artifactsDir))
    await assert.rejects(fs.stat(path.join(state.artifactsDir, name, 'verified.json')), { code: 'ENOENT' });
});

test('an adapter cannot redefine the private checkpoint root through a symlink or junction', async (t) => {
  const state = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-checkpoint-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  // Test permission before starting capture, so unsupported sandbox symlinks
  // skip cleanly without hiding a checkpoint failure.
  const probe = path.join(state.root, 'link-permission-probe');
  try {
    await fs.symlink(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('This sandbox does not permit creating symlinks.');
    return;
  }
  await fs.unlink(probe);
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1_000,
      runHook: async (_script, requestPath, receiptPath, { directory }) => {
        const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
        await fs.rename(directory, `${directory}-original`);
        await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
        await fs.writeFile(receiptPath, JSON.stringify(await validReceipt(directory, request)));
      },
    }),
    /directory identity changed/,
  );
  await assert.rejects(fs.stat(path.join(outside, 'verified.json')), { code: 'ENOENT' });
});

test('receipt validates every identity, verification assertion and artifact checksum', async (t) => {
  const state = await fixture(t);
  const request = {
    requestId: 'request',
    token: 'token',
    namespaceUid: 'namespace',
    operationPlanDigest: digest('a'),
    release: 'rivet',
    namespace: 'rivet',
    context: 'fixture',
    consistency: 'quiesced',
    startedAt: new Date().toISOString(),
    candidateManifestDigest: digest('b'),
    installedManifestDigest: digest('c'),
  };
  const receipt = await validReceipt(state.artifactsDir, request);
  assert.equal((await verifyRecoveryReceipt(receipt, state.artifactsDir, request)).verified, true);
  for (const change of [
    { requestId: 'old' },
    { token: 'other' },
    { operationPlanDigest: digest('e') },
    { databaseRestoreVerified: false },
    { objectReferencesCovered: false },
    { encryptionKeysRecoverable: false },
    { unrelatedDataExcluded: false },
  ]) {
    await assert.rejects(
      verifyRecoveryReceipt({ ...receipt, ...change }, state.artifactsDir, request),
      /incomplete|another operation/,
    );
  }
  await assert.rejects(
    verifyRecoveryReceipt({ ...receipt, artifacts: receipt.artifacts.slice(0, 3) }, state.artifactsDir, request),
    /requires database/,
  );
  await fs.writeFile(path.join(state.artifactsDir, receipt.artifacts[0].path), 'altered');
  await assert.rejects(verifyRecoveryReceipt(receipt, state.artifactsDir, request), /checksum/);
});

test('one file cannot masquerade as four recovery artifacts through path aliases', async (t) => {
  const state = await fixture(t);
  const request = {
    requestId: 'request',
    token: 'token',
    namespaceUid: 'namespace',
    operationPlanDigest: digest('a'),
    release: 'rivet',
    namespace: 'rivet',
    context: 'fixture',
    consistency: 'quiesced',
    startedAt: new Date().toISOString(),
    candidateManifestDigest: digest('b'),
    installedManifestDigest: digest('c'),
  };
  const receipt = await validReceipt(state.artifactsDir, request);
  receipt.artifacts[1] = { role: 'objects', path: './database.private', sha256: receipt.artifacts[0].sha256 };
  await assert.rejects(verifyRecoveryReceipt(receipt, state.artifactsDir, request), /duplicate artifact file/);
  receipt.artifacts[1].path = '../baseline.json';
  await assert.rejects(verifyRecoveryReceipt(receipt, state.artifactsDir, request), /repository-contained/);
});

test('partial or failed adapter execution never creates verified success and is not retried', async (t) => {
  const state = await fixture(t);
  let calls = 0;
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1_000,
      runHook: async () => {
        calls++;
        throw new Error('failed adapter');
      },
    }),
    /failed adapter/,
  );
  assert.equal(calls, 1);
  const [directory] = await fs.readdir(state.artifactsDir);
  await assert.rejects(fs.stat(path.join(state.artifactsDir, directory, 'verified.json')), { code: 'ENOENT' });
});

test('malformed adapter receipt errors omit private content', async (t) => {
  const state = await fixture(t);
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 1_000,
      runHook: async (_script, _request, receipt) => fs.writeFile(receipt, '{private-output-is-not-json'),
    }),
    (error) => /not valid JSON/.test(error.message) && !error.message.includes('private-output'),
  );
});

test('real adapter failure keeps stdout and stderr only in its private local log', async (t) => {
  const state = await fixture(
    t,
    "console.log('private-adapter-output'); console.error('private-adapter-error'); process.exitCode = 1;\n",
  );
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, { artifactsDir: state.artifactsDir, timeoutMs: 5_000 }),
    (error) => /did not complete successfully/.test(error.message) && !error.message.includes('private-adapter-output'),
  );
  const [directory] = await fs.readdir(state.artifactsDir);
  const output = await fs.readFile(path.join(state.artifactsDir, directory, 'adapter-private.log'), 'utf8');
  assert.match(output, /private-adapter-output/);
  assert.match(output, /private-adapter-error/);
  await assert.rejects(fs.stat(path.join(state.artifactsDir, directory, 'verified.json')), { code: 'ENOENT' });
});

test('a hung local adapter is stopped at its timeout and cannot produce success', async (t) => {
  const state = await fixture(t, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, { artifactsDir: state.artifactsDir, timeoutMs: 100 }),
    /did not complete successfully/,
  );
});

test('a timed-out adapter cannot leave a capture child writing while recovery begins', async (t) => {
  const childProgram = `const fs = require('node:fs');
const net = require('node:net');
const [marker, started, recovery] = process.argv.slice(1);
process.on('SIGTERM', () => {});
net.createServer(socket => socket.destroy()).listen(0, '127.0.0.1', function () {
  setInterval(() => { if (fs.existsSync(recovery)) fs.writeFileSync(marker, 'late'); }, 10);
  fs.writeFileSync(started, String(this.address().port));
});
setTimeout(() => process.exit(0), 10000);
`;
  const script = `import path from 'node:path';
import { spawn } from 'node:child_process';
const request = process.argv[process.argv.indexOf('--request') + 1];
const marker = path.join(path.dirname(request), 'late-child-write');
const started = path.join(path.dirname(request), 'child-started');
const recovery = path.join(path.dirname(request), 'recovery-started');
spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}, marker, started, recovery], { stdio: 'inherit', windowsHide: true });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`;
  const state = await fixture(t, script);
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, { artifactsDir: state.artifactsDir, timeoutMs: 1_500 }),
    /did not complete successfully/,
  );
  const [directory] = await fs.readdir(state.artifactsDir);
  const port = Number(await fs.readFile(path.join(state.artifactsDir, directory, 'child-started'), 'utf8'));
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'The child must actually listen before termination.');
  // Recovery is allowed only after confirmed shutdown, not at a fixed time after spawn.
  // Even a paused surviving child retains its listener: a timeout is not proof of exit.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const settle = (error) => {
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      socket.once('connect', () => settle());
      socket.once('error', settle);
      socket.setTimeout(1_000, () => settle(new Error('Child shutdown remains unconfirmed')));
    }),
    { code: 'ECONNREFUSED' },
  );
  await fs.writeFile(path.join(state.artifactsDir, directory, 'recovery-started'), 'recovery');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(fs.stat(path.join(state.artifactsDir, directory, 'late-child-write')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(state.artifactsDir, directory, 'verified.json')), { code: 'ENOENT' });
});

function simulatedChild(pid) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.destroy = () => {
    child.stdout.destroyed = true;
  };
  child.pid = pid;
  child.kills = [];
  child.unrefed = false;
  child.kill = (signal) => {
    child.kills.push(signal);
    return false;
  };
  child.unref = () => {
    child.unrefed = true;
  };
  return child;
}

test('POSIX signal acknowledgement and parent close cannot release recovery while a child remains live', async (t) => {
  const state = await fixture(t);
  const adapter = simulatedChild(12345);
  const signals = [];
  const probes = [];
  const notifications = new EventEmitter();
  let settled = false;
  const running = executeMaintenanceBackupAdapter('fixture.mjs', 'request', 'receipt', {
    directory: state.artifactsDir,
    timeoutMs: 10,
    shutdownTimeoutMs: 5_000,
    platform: 'linux',
    signalProcess: (...args) => {
      signals.push(args);
      adapter.emit('close', null);
    },
    spawnProcess(command, args) {
      if (command !== 'ps') return adapter;
      assert.deepEqual(args, ['-axo', 'pgid=,stat=']);
      const probe = simulatedChild(12346 + probes.length);
      probes.push(probe);
      setImmediate(() => notifications.emit('probe', probe));
      return probe;
    },
  }).finally(() => {
    settled = true;
  });
  const rejection = assert.rejects(running, /did not complete successfully/);
  const nextProbe = () => new Promise((resolve) => notifications.once('probe', resolve));
  const first = await nextProbe();
  assert.deepEqual(signals, [[-12345, 'SIGKILL']]);
  const secondReady = nextProbe();
  // A stopped/suspended child still owns its listener and is NOT terminal.
  first.stdout.emit('data', Buffer.from('12345 T\n99999 S\n'));
  first.emit('close', 0);
  const second = await secondReady;
  assert.equal(settled, false);
  // Ignore other groups. Our zombies cannot write, even if PID 1 has not reaped them.
  second.stdout.emit('data', Buffer.from('12345 Z\n99999 S\n'));
  second.emit('close', 0);
  await rejection;
  assert.equal(probes.length, 2);
});

test('POSIX shutdown fails closed and remains bounded when group inspection fails or hangs', async (t) => {
  for (const scenario of ['failed-probe', 'invalid-probe', 'empty-probe', 'hung-probe', 'live-group']) {
    const state = await fixture(t);
    const adapter = simulatedChild(12345);
    const probes = [];
    await assert.rejects(
      executeMaintenanceBackupAdapter('fixture.mjs', 'request', 'receipt', {
        directory: state.artifactsDir,
        timeoutMs: 10,
        shutdownTimeoutMs: 100,
        platform: 'linux',
        signalProcess: () => adapter.emit('close', null),
        spawnProcess(command) {
          if (command !== 'ps') return adapter;
          const probe = simulatedChild(12346 + probes.length);
          probes.push(probe);
          if (scenario !== 'hung-probe')
            setImmediate(() => {
              probe.stdout.emit(
                'data',
                scenario === 'invalid-probe'
                  ? 'unrecognized process state'
                  : scenario === 'empty-probe'
                    ? ''
                    : '12345 S\n',
              );
              probe.emit('close', scenario === 'failed-probe' ? 1 : 0);
            });
          return probe;
        },
      }),
      /process-tree shutdown is unconfirmed/,
    );
    assert.ok(probes.length >= 1, scenario);
    if (scenario === 'hung-probe') {
      assert.deepEqual(probes[0].kills, ['SIGKILL']);
      assert.equal(probes[0].unrefed, true);
      assert.equal(probes[0].stdout.destroyed, true);
    }
  }
});

test('overflowing backup or shutdown deadlines fail before spawning or creating checkpoint files', async (t) => {
  for (const durations of [{ timeoutMs: 2_147_483_648 }, { timeoutMs: 10, shutdownTimeoutMs: 2_147_483_648 }]) {
    const state = await fixture(t);
    await assert.rejects(
      executeMaintenanceBackupAdapter('fixture.mjs', 'request', 'receipt', {
        directory: state.artifactsDir,
        ...durations,
        spawnProcess: () => assert.fail('An invalid timer must not spawn the adapter'),
      }),
      /timer range/,
    );
    assert.deepEqual(await fs.readdir(state.artifactsDir), []);
  }
  const state = await fixture(t);
  await assert.rejects(
    captureMaintenanceCheckpoint(state.approval, state.context, {
      artifactsDir: state.artifactsDir,
      timeoutMs: 2_147_483_648,
      runHook: () => assert.fail('An invalid timer must not start a checkpoint'),
    }),
    /timer range/,
  );
  assert.deepEqual(await fs.readdir(state.artifactsDir), []);
});

test('shutdown confirmation is bounded when taskkill hangs or the adapter never closes', async (t) => {
  for (const scenario of ['hung-helper', 'no-parent-close', 'failed-fallback']) {
    const state = await fixture(t);
    const adapter = simulatedChild(12345);
    const helper = simulatedChild(12346);
    const calls = [];
    const started = Date.now();
    await assert.rejects(
      executeMaintenanceBackupAdapter('fixture.mjs', 'request', 'receipt', {
        directory: state.artifactsDir,
        timeoutMs: 10,
        shutdownTimeoutMs: 40,
        platform: 'win32',
        spawnProcess: (command, args) => {
          calls.push({ command, args });
          if (calls.length === 1) return adapter;
          if (scenario !== 'hung-helper')
            setImmediate(() => helper.emit('close', scenario === 'failed-fallback' ? 1 : 0));
          return helper;
        },
      }),
      /process-tree shutdown is unconfirmed/,
    );
    assert.ok(Date.now() - started < 1_000, scenario);
    assert.equal(adapter.unrefed, true, scenario);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { command: 'taskkill.exe', args: ['/PID', '12345', '/T', '/F'] });
    assert.deepEqual(helper.kills, scenario === 'hung-helper' ? ['SIGKILL'] : [], scenario);
    assert.deepEqual(adapter.kills, scenario === 'failed-fallback' ? ['SIGKILL'] : [], scenario);
  }
});

test('parent close alone cannot confirm shutdown before the taskkill result', async (t) => {
  const state = await fixture(t);
  const adapter = simulatedChild(12345);
  const helper = simulatedChild(12346);
  let calls = 0;
  let settled = false;
  const running = executeMaintenanceBackupAdapter('fixture.mjs', 'request', 'receipt', {
    directory: state.artifactsDir,
    timeoutMs: 10,
    shutdownTimeoutMs: 500,
    platform: 'win32',
    spawnProcess: () => {
      if (++calls === 1) return adapter;
      setImmediate(() => adapter.emit('close', 1));
      return helper;
    },
  }).finally(() => {
    settled = true;
  });
  const rejection = assert.rejects(running, /did not complete successfully/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 2);
  assert.equal(settled, false);
  helper.emit('close', 0);
  await rejection;
  assert.deepEqual(helper.kills, []);
});
// test-style: fixture-read: Inspect only generated maintenance plans, backup receipts and adapter execution artifacts.
