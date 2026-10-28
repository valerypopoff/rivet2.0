import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  assertStudioServerReleaseManifest,
  getStudioServerReleaseManifestDigest,
} from './studio-server-release-manifest.mjs';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maxTimerMs = 2_147_483_647;
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}
const within = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const parseJson = (bytes, description) => {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
};

async function localFile(root, file) {
  const resolved = path.resolve(root, file);
  if (
    !within(root, resolved) ||
    !(await fs.lstat(resolved)).isFile() ||
    !within(await fs.realpath(root), await fs.realpath(resolved))
  )
    throw new Error('Maintenance files must be regular, repository-contained files.');
  return resolved;
}

async function assertUnchangedMetadata(directory, expected) {
  for (const [name, bytes] of Object.entries(expected)) {
    const current = await fs.readFile(await localFile(directory, name));
    if (!current.equals(bytes)) throw Error('Maintenance checkpoint metadata changed during adapter verification.');
  }
}

async function recoveryDirectory(root, directory, expected) {
  const identity = await fs.lstat(directory, { bigint: true });
  if (
    !identity.isDirectory() ||
    !within(root, path.resolve(directory)) ||
    !within(await fs.realpath(root), await fs.realpath(directory)) ||
    (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino))
  )
    throw new Error('Frozen recovery directory identity changed or escaped the repository.');
  return identity;
}

export function assertMaintenancePlan(
  plan,
  { release, namespace, context, candidateDigest, valuesDigest, now = Date.now(), allowExpiredForRecovery = false },
) {
  const issued = Date.parse(plan?.issuedAt);
  const expiry = Date.parse(plan?.expiresAt);
  if (
    plan?.formatVersion !== 1 ||
    plan.kind !== 'rivet-maintenance-deployment' ||
    plan.release !== release ||
    plan.namespace !== namespace ||
    plan.context !== context ||
    !digestPattern.test(valuesDigest ?? '') ||
    plan.valuesDigest !== valuesDigest ||
    typeof plan.namespaceUid !== 'string' ||
    !plan.namespaceUid ||
    plan.candidateManifestDigest !== candidateDigest ||
    !digestPattern.test(candidateDigest) ||
    !digestPattern.test(plan.installedManifestDigest ?? '') ||
    typeof plan.installedManifestPath !== 'string' ||
    !plan.installedManifestPath ||
    plan.accepts?.interruption !== true ||
    plan.accepts?.qualificationWaived !== true ||
    plan.accepts?.dataLoss !== false ||
    typeof plan.reason !== 'string' ||
    !plan.reason.trim() ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expiry) ||
    issued > now ||
    expiry <= issued ||
    (!allowExpiredForRecovery && expiry <= now) ||
    expiry - issued > 2 * 60 * 60 * 1000 ||
    typeof plan.backup?.script !== 'string' ||
    !plan.backup.script.endsWith('.mjs') ||
    !digestPattern.test(plan.backup.sha256 ?? '')
  )
    throw new Error('Invalid, expired or mismatched explicit maintenance deployment plan.');
  const migration = plan.schemaMigration;
  if (
    migration !== undefined &&
    (!migration ||
      !Number.isSafeInteger(migration.fromVersion) ||
      migration.fromVersion < 1 ||
      !Number.isSafeInteger(migration.toVersion) ||
      migration.toVersion <= migration.fromVersion ||
      typeof migration.script !== 'string' ||
      !migration.script.endsWith('.mjs') ||
      !digestPattern.test(migration.sha256 ?? ''))
  )
    throw new Error(
      'Schema-changing maintenance requires an exact forward schema transition and reviewed migration-validation adapter.',
    );
  return plan;
}

/** A maintenance waiver is local operation authority, never a qualification certificate. */
export async function readMaintenancePlan(file, root, identity) {
  const bytes = await fs.readFile(await localFile(root, file));
  const plan = assertMaintenancePlan(parseJson(bytes, 'Maintenance deployment plan'), identity);
  const baseline = assertStudioServerReleaseManifest(
    parseJson(await fs.readFile(await localFile(root, plan.installedManifestPath)), 'Installed release manifest'),
    { requirePromoted: true },
  );
  if (getStudioServerReleaseManifestDigest(baseline, { requirePromoted: true }) !== plan.installedManifestDigest)
    throw new Error('The maintenance baseline is not the exact promoted installed manifest.');
  const scriptPath = await localFile(root, plan.backup.script);
  if (hash(await fs.readFile(scriptPath)) !== plan.backup.sha256)
    throw new Error('The reviewed maintenance backup script has changed.');
  let migrationScriptPath, candidate;
  if (plan.schemaMigration) {
    candidate = assertStudioServerReleaseManifest(identity.manifest, { requirePromoted: true });
    if (
      getStudioServerReleaseManifestDigest(candidate, { requirePromoted: true }) !== plan.candidateManifestDigest ||
      plan.schemaMigration.fromVersion !== baseline.database.managedWorkflowSchema.version ||
      plan.schemaMigration.toVersion !== candidate.database.managedWorkflowSchema.version
    )
      throw Error('Maintenance migration approval does not match the exact installed and candidate schemas.');
    migrationScriptPath = await localFile(root, plan.schemaMigration.script);
    if (hash(await fs.readFile(migrationScriptPath)) !== plan.schemaMigration.sha256)
      throw Error('The reviewed migration-validation adapter has changed.');
  }
  return { plan, baseline, candidate, scriptPath, migrationScriptPath, digest: hash(bytes), root };
}

export function assertMaintenanceBaseline(
  approval,
  { installed, manifest, namespaceUid, now = Date.now(), recovering = false, recoveryJournal, resumeToken },
) {
  const { plan, baseline } = approval;
  const ownsRecovery =
    recovering &&
    typeof resumeToken === 'string' &&
    !!resumeToken &&
    recoveryJournal?.token === resumeToken &&
    ['quiescing', 'quiesced', 'validating', 'resuming'].includes(recoveryJournal.phase) &&
    recoveryJournal.release === plan.release &&
    recoveryJournal.namespace === plan.namespace &&
    recoveryJournal.manifestDigest === plan.candidateManifestDigest &&
    recoveryJournal.operationPlanDigest === approval.digest;
  if (recovering && !ownsRecovery)
    throw new Error('Maintenance recovery requires the exact unfinished journal token and operation plan.');
  assertMaintenancePlan(plan, {
    ...plan,
    candidateDigest: getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true }),
    now,
    allowExpiredForRecovery: ownsRecovery,
  });
  if (namespaceUid !== plan.namespaceUid)
    throw new Error('Maintenance namespace identity changed. No deployment is allowed.');
  const installedDigest = installed?.release?.production?.manifestDigest;
  if (
    installedDigest !== plan.installedManifestDigest &&
    !(ownsRecovery && installedDigest === plan.candidateManifestDigest)
  )
    throw new Error('The live release does not match the maintenance baseline or exact recovery candidate.');
  const fromVersion = baseline.database.managedWorkflowSchema.version;
  const toVersion = manifest.database.managedWorkflowSchema.version;
  const expectedInstalledSchema = installedDigest === plan.installedManifestDigest ? fromVersion : toVersion;
  if (installed?.release?.production?.database?.managedWorkflowSchemaVersion !== expectedInstalledSchema)
    throw Error('The installed schema identity differs from the exact maintenance baseline or recovery candidate.');
  if (
    fromVersion !== toVersion &&
    (plan.schemaMigration?.fromVersion !== fromVersion ||
      plan.schemaMigration.toVersion !== toVersion ||
      !approval.migrationScriptPath ||
      !approval.candidate ||
      getStudioServerReleaseManifestDigest(approval.candidate, { requirePromoted: true }) !==
        plan.candidateManifestDigest)
  )
    throw Error(
      'Schema-changing qualification waiver requires explicit schemaMigration approval and restored-copy migration validation.',
    );
  if (fromVersion === toVersion && plan.schemaMigration)
    throw Error('Schema-migration approval cannot authorize an unchanged or different transition.');
  return { fromVersion, toVersion, migrationRequired: fromVersion !== toVersion, qualification: 'waived' };
}

/** A reviewed adapter restores only the frozen local checkpoint, runs the exact
 * candidate migration there and proves data preservation before live DDL. */
export async function verifyMaintenanceMigrationReceipt(receipt, directory, request, { now = Date.now } = {}) {
  const preflight = request.stage === 'migration-preflight';
  const checks = preflight
    ? ['passed', 'supportsSchemaMigration', 'candidateImageVerified', 'restoreEnvironmentReady']
    : [
        'isolatedRestore',
        'migrationApplied',
        'targetSchemaVerified',
        'preservedDataVerified',
        'oldDatabaseReadersStopped',
      ];
  if (
    !['migration-preflight', 'migration-validation'].includes(request.stage) ||
    receipt?.formatVersion !== 1 ||
    receipt.kind !== `rivet-maintenance-migration-${preflight ? 'preflight' : 'validation'}` ||
    [
      'stage',
      'requestId',
      'token',
      'release',
      'namespace',
      'context',
      'namespaceUid',
      'operationPlanDigest',
      'installedManifestDigest',
      'candidateManifestDigest',
      'checkpointRequestId',
      'checkpointReceiptDigest',
      'checkpointDirectory',
    ].some((key) => receipt[key] !== request[key]) ||
    !isDeepStrictEqual(receipt.schemaMigration, request.schemaMigration) ||
    !checks.every((key) => receipt[key] === true) ||
    receipt.unrelatedDataExcluded !== true ||
    !Number.isFinite(Date.parse(request.startedAt)) ||
    !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
    Date.parse(receipt.verifiedAt) < Date.parse(request.startedAt) ||
    Date.parse(receipt.verifiedAt) > now()
  )
    throw Error('Restored-copy migration validation is incomplete or belongs to another checkpoint/candidate.');
  await verifyArtifacts(directory, receipt.artifacts, ['verification']);
  return { verified: true, requestId: request.requestId, checkpointRequestId: request.checkpointRequestId };
}

const migrationTarget = (approval) => ({
  fromVersion: approval.plan.schemaMigration.fromVersion,
  toVersion: approval.plan.schemaMigration.toVersion,
  candidateApiImage: approval.candidate.images.api,
});

async function runMigrationAdapter(approval, request, directory, timeoutMs, runHook) {
  const script = await localFile(approval.root, approval.plan.schemaMigration.script);
  if (hash(await fs.readFile(script)) !== approval.plan.schemaMigration.sha256)
    throw Error('The approved migration-validation adapter changed before invocation.');
  await fs.mkdir(directory, { mode: 0o700 });
  const identity = await recoveryDirectory(approval.root, directory);
  const requestPath = path.join(directory, 'request.json'),
    receiptPath = path.join(directory, 'receipt.json');
  const requestBytes = Buffer.from(JSON.stringify(request));
  await fs.writeFile(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
  await runHook(script, requestPath, receiptPath, { directory, timeoutMs });
  await recoveryDirectory(approval.root, directory, identity);
  const receiptBytes = await fs.readFile(await localFile(directory, 'receipt.json'));
  const receipt = parseJson(receiptBytes, 'Migration receipt');
  const result = await verifyMaintenanceMigrationReceipt(receipt, directory, request);
  await assertUnchangedMetadata(directory, { 'request.json': requestBytes, 'receipt.json': receiptBytes });
  await recoveryDirectory(approval.root, directory, identity);
  return result;
}

/** Probe actual adapter/image/restore prerequisites without capturing or
 * migrating production and before ownership or downtime can begin. */
export async function preflightMaintenanceMigration(
  approval,
  { artifactsDir, timeoutMs, runHook = executeMaintenanceBackupAdapter },
) {
  if (!approval.plan.schemaMigration) return null;
  assertMaintenancePlan(approval.plan, { ...approval.plan, candidateDigest: approval.plan.candidateManifestDigest });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimerMs)
    throw Error('Migration preflight requires a bounded positive timeout.');
  await recoveryDirectory(approval.root, artifactsDir);
  const requestId = randomUUID();
  const request = {
    formatVersion: 1,
    stage: 'migration-preflight',
    requestId,
    release: approval.plan.release,
    namespace: approval.plan.namespace,
    context: approval.plan.context,
    namespaceUid: approval.plan.namespaceUid,
    operationPlanDigest: approval.digest,
    installedManifestDigest: approval.plan.installedManifestDigest,
    candidateManifestDigest: approval.plan.candidateManifestDigest,
    schemaMigration: migrationTarget(approval),
    startedAt: new Date().toISOString(),
  };
  return runMigrationAdapter(
    approval,
    request,
    path.join(artifactsDir, `migration-preflight-${requestId}`),
    timeoutMs,
    runHook,
  );
}

export async function verifyRetainedMaintenanceMigration(approval, directory, checkpointRequest, checkpointReceipt) {
  const migration = approval.plan.schemaMigration;
  if (!migration) return;
  const folder = path.join(directory, 'migration-validation');
  const identity = await recoveryDirectory(approval.root, folder);
  const request = parseJson(await fs.readFile(await localFile(folder, 'request.json')), 'Migration request');
  const receipt = parseJson(await fs.readFile(await localFile(folder, 'receipt.json')), 'Migration receipt');
  const target = migrationTarget(approval);
  if (
    request.formatVersion !== 1 ||
    request.stage !== 'migration-validation' ||
    request.checkpointDirectory !== directory ||
    request.checkpointRequestId !== checkpointRequest.requestId ||
    request.checkpointReceiptDigest !== hash(JSON.stringify(checkpointReceipt)) ||
    !isDeepStrictEqual(request.schemaMigration, target) ||
    [
      'token',
      'release',
      'namespace',
      'context',
      'namespaceUid',
      'operationPlanDigest',
      'installedManifestDigest',
      'candidateManifestDigest',
    ].some((key) => request[key] !== checkpointRequest[key])
  )
    throw Error('Retained migration proof does not match the frozen checkpoint and approved transition.');
  const result = await verifyMaintenanceMigrationReceipt(receipt, folder, request);
  await recoveryDirectory(approval.root, folder, identity);
  return result;
}

async function verifyArtifacts(directory, artifacts, requiredRoles) {
  if (!Array.isArray(artifacts)) throw Error('Invalid recovery verification artifact inventory.');
  const roles = new Set(),
    paths = new Set();
  for (const item of artifacts) {
    if (!requiredRoles.includes(item?.role) || typeof item.path !== 'string' || !digestPattern.test(item.sha256 ?? ''))
      throw Error('Invalid backup artifact inventory.');
    const file = await localFile(directory, item.path);
    const canonical = await fs.realpath(file);
    const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (paths.has(identity)) throw Error('Invalid backup artifact inventory: duplicate artifact file.');
    if ((await fs.stat(file)).size === 0 || (await hashFile(file)) !== item.sha256)
      throw Error('A recovery artifact is empty or its checksum has changed.');
    roles.add(item.role);
    paths.add(identity);
  }
  if (!requiredRoles.every((role) => roles.has(role)))
    throw Error('Recovery requires database, objects, encryption keys and restore-verification artifacts.');
}

export async function verifyRecoveryReceipt(receipt, directory, request, { now = Date.now } = {}) {
  if (
    receipt?.formatVersion !== 1 ||
    receipt.kind !==
      (request.consistency === 'online' ? 'rivet-recovery-checkpoint' : 'rivet-frozen-recovery-checkpoint') ||
    receipt.requestId !== request.requestId ||
    receipt.token !== request.token ||
    !['online', 'quiesced'].includes(request.consistency) ||
    receipt.consistency !== request.consistency ||
    receipt.release !== request.release ||
    receipt.namespace !== request.namespace ||
    receipt.context !== request.context ||
    receipt.namespaceUid !== request.namespaceUid ||
    receipt.operationPlanDigest !== request.operationPlanDigest ||
    receipt.candidateManifestDigest !== request.candidateManifestDigest ||
    receipt.installedManifestDigest !== request.installedManifestDigest ||
    receipt.databaseRestoreVerified !== true ||
    receipt.objectReferencesCovered !== true ||
    receipt.encryptionKeysRecoverable !== true ||
    receipt.unrelatedDataExcluded !== true ||
    !Array.isArray(receipt.artifacts) ||
    receipt.artifacts.length < 1
  )
    throw new Error('Frozen backup receipt is incomplete or belongs to another operation.');
  const startedAt = Date.parse(request.startedAt),
    capturedAt = Date.parse(receipt.capturedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(capturedAt) || capturedAt < startedAt || capturedAt > now())
    throw new Error('Recovery backup is stale or its capture point is unconfirmed.');
  await verifyArtifacts(directory, receipt.artifacts, ['database', 'objects', 'keys', 'verification']);
  return { formatVersion: 1, requestId: request.requestId, verified: true, artifactCount: receipt.artifacts.length };
}

/** Invoked only under the cutover lease, after every old writer has stopped.
 * The reviewed adapter reads production and restores only into isolated local
 * scratch storage. Neither its output nor recovery data is printed or uploaded.
 */
export async function captureMaintenanceCheckpoint(
  approval,
  context,
  { artifactsDir, timeoutMs, runHook = executeMaintenanceBackupAdapter },
) {
  const { plan } = approval;
  // Expiry controls admission. The still-owned journal allows a previously
  // admitted operation (or its exact-token recovery) to finish its checkpoint.
  assertMaintenancePlan(plan, {
    ...plan,
    candidateDigest: plan.candidateManifestDigest,
    allowExpiredForRecovery: true,
  });
  if (
    typeof context.token !== 'string' ||
    !context.token ||
    context.release !== plan.release ||
    context.namespace !== plan.namespace ||
    context.manifestDigest !== plan.candidateManifestDigest ||
    context.operationPlanDigest !== approval.digest ||
    context.phase !== 'quiesced' ||
    !Number.isFinite(context.leaseExpiresAt) ||
    context.leaseExpiresAt <= Date.now()
  )
    throw new Error('Frozen backup requires the matching live quiesced operation context.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimerMs)
    throw new Error('Frozen backup requires a positive timeout within the supported timer range.');
  if (
    !within(approval.root, path.resolve(artifactsDir)) ||
    !(await fs.lstat(artifactsDir)).isDirectory() ||
    !within(await fs.realpath(approval.root), await fs.realpath(artifactsDir))
  )
    throw new Error('Frozen recovery directory must remain inside the repository.');
  if (
    hash(await fs.readFile(await localFile(approval.root, approval.plan.backup.script))) !== approval.plan.backup.sha256
  )
    throw new Error('The approved backup adapter changed before the frozen checkpoint.');
  const requestId = randomUUID();
  const directory = path.join(artifactsDir, `frozen-recovery-${requestId}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const directoryIdentity = await recoveryDirectory(approval.root, directory);
  const request = {
    formatVersion: 1,
    requestId,
    token: context.token,
    release: context.release,
    namespace: context.namespace,
    context: approval.plan.context,
    namespaceUid: approval.plan.namespaceUid,
    operationPlanDigest: approval.digest,
    installedManifestDigest: approval.plan.installedManifestDigest,
    candidateManifestDigest: approval.plan.candidateManifestDigest,
    consistency: 'quiesced',
    stage: 'backup',
    startedAt: new Date().toISOString(),
  };
  const requestPath = path.join(directory, 'request.json');
  const receiptPath = path.join(directory, 'receipt.json');
  const requestBytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
  await fs.writeFile(requestPath, requestBytes, { flag: 'wx', mode: 0o600 });
  // Never retry a lost acknowledgement. Explicit token recovery creates a fresh
  // checkpoint after re-quiescing, so newly accepted work is not omitted.
  await runHook(approval.scriptPath, requestPath, receiptPath, { directory, timeoutMs });
  // The adapter cannot redefine the trusted root by replacing its directory
  // with a symlink/junction or another directory while producing the receipt.
  await recoveryDirectory(approval.root, directory, directoryIdentity);
  const receiptBytes = await fs.readFile(await localFile(directory, 'receipt.json'));
  const receipt = parseJson(receiptBytes, 'Frozen backup receipt');
  const metadata = { 'request.json': requestBytes, 'receipt.json': receiptBytes };
  await assertUnchangedMetadata(directory, metadata);
  const verified = await verifyRecoveryReceipt(receipt, directory, request);
  if (plan.schemaMigration) {
    const folder = path.join(directory, 'migration-validation');
    const migrationRequest = {
      ...request,
      requestId: randomUUID(),
      stage: 'migration-validation',
      checkpointDirectory: directory,
      checkpointRequestId: request.requestId,
      checkpointReceiptDigest: hash(JSON.stringify(receipt)),
      schemaMigration: migrationTarget(approval),
      startedAt: new Date().toISOString(),
    };
    await runMigrationAdapter(approval, migrationRequest, folder, timeoutMs, runHook);
    await verifyRetainedMaintenanceMigration(approval, directory, request, receipt);
    // A migration adapter must not alter the recovery bytes it validated.
    await verifyRecoveryReceipt(receipt, directory, request);
  }
  await assertUnchangedMetadata(directory, metadata);
  await recoveryDirectory(approval.root, directory, directoryIdentity);
  await fs.writeFile(path.join(directory, 'verified.json'), `${JSON.stringify(verified)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { ...verified, directory };
}

export async function executeMaintenanceBackupAdapter(
  script,
  request,
  receipt,
  {
    directory,
    timeoutMs,
    shutdownTimeoutMs = 5_000,
    spawnProcess = spawn,
    platform = process.platform,
    signalProcess = process.kill,
  },
) {
  if (![timeoutMs, shutdownTimeoutMs].every((value) => Number.isFinite(value) && value > 0 && value <= maxTimerMs))
    throw new Error('Frozen backup adapter timeouts must be positive and within the supported timer range.');
  const output = await fs.open(path.join(directory, 'adapter-private.log'), 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, [script, '--request', request, '--receipt', receipt], {
        // A private process group lets a timed-out POSIX adapter's capture or
        // local-restore children be stopped together, without host-wide kills.
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', output.fd, output.fd],
      });
      let timedOut = false;
      let settled = false;
      let childClosed = false;
      let treeStopped = false;
      let helper;
      let helperClosed = false;
      let shutdownTimer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(shutdownTimer);
        if (error) reject(error);
        else resolve();
      };
      const failed = () =>
        finish(
          new Error(
            'Frozen backup adapter did not complete successfully. Inspect its private local log; no automatic retry or deployment follows.',
          ),
        );
      const unconfirmed = () => {
        if (settled) return;
        // Do not let an unconfirmed child keep the deploying CLI alive forever.
        // Its partial files are preserved; no verified checkpoint or retry follows.
        if (helper && !helperClosed) {
          tryKill(helper);
          // unref() alone does not release a POSIX inspector's piped stdout.
          helper.stdout?.destroy?.();
          helper.unref();
        }
        if (!childClosed) child.unref();
        finish(
          new Error(
            'Frozen backup adapter timed out and its process-tree shutdown is unconfirmed. Inspect its private local log and settle its children before recovery.',
          ),
        );
      };
      const timer = setTimeout(() => {
        timedOut = true;
        shutdownTimer = setTimeout(unconfirmed, shutdownTimeoutMs);
        stopAdapterTree(child, {
          spawnProcess,
          platform,
          signalProcess,
          isSettled: () => settled,
          onHelper: (value) => {
            helper = value;
            helperClosed = false;
            helper.once('close', () => {
              helperClosed = true;
            });
          },
        }).then((confirmed) => {
          if (settled) return;
          treeStopped = confirmed;
          if (!confirmed) unconfirmed();
          else if (childClosed) failed();
        }, unconfirmed);
      }, timeoutMs);
      child.once('error', (error) => {
        if (timedOut) unconfirmed();
        else finish(error);
      });
      child.once('close', (code) => {
        childClosed = true;
        if (timedOut) {
          if (treeStopped) failed();
        } else if (code === 0) finish();
        else failed();
      });
    });
  } finally {
    await output.close();
  }
}

function tryKill(child) {
  try {
    return child.kill('SIGKILL');
  } catch {
    return false;
  }
}

async function stopAdapterTree(child, { spawnProcess, platform, onHelper, signalProcess, isSettled }) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (platform !== 'win32') {
    try {
      signalProcess(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
    // Delivery is asynchronous. Parent closure does not prove that every child
    // has left the kernel (a paused child can even retain a listening socket).
    // Poll only this freshly owned process group, under the caller's existing
    // shutdown deadline. Zombies are terminal and may await reaping by PID 1.
    while (!isSettled()) {
      const stopped = await inspectAdapterGroup(child.pid, { spawnProcess, onHelper });
      if (stopped !== false) return stopped === true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }
  // This PID is the still-owned child object, not a discovered process name.
  // /T includes its pg_dump/local-restore children; /F cannot be ignored by an
  // adapter's signal handler. Wait for the command before reporting failure.
  return new Promise((resolve) => {
    const taskkill = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    onHelper(taskkill);
    taskkill.once('error', () => {
      tryKill(child);
      resolve(false);
    });
    taskkill.once('close', (code) => {
      if (code !== 0) tryKill(child);
      resolve(code === 0);
    });
  });
}

function inspectAdapterGroup(group, { spawnProcess, onHelper }) {
  return new Promise((resolve) => {
    const probe = spawnProcess('ps', ['-axo', 'pgid=,stat='], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    onHelper(probe); // The outer shutdown deadline kills/unrefs a hung probe.
    let output = '';
    let invalid = false;
    probe.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 1024 * 1024) {
        invalid = true;
        tryKill(probe);
      } else output += chunk;
    });
    probe.once('error', () => resolve(null));
    probe.once('close', (code) => {
      if (code !== 0 || invalid || !output.trim()) return resolve(null);
      let live = false;
      for (const line of output.split(/\r?\n/).filter((value) => value.trim())) {
        const entry = /^\s*(\d+)\s+([A-Zt][<NLSsl+EIXV]*)\s*$/.exec(line);
        if (!entry) return resolve(null);
        if (Number(entry[1]) === group && !/^[ZX]/.test(entry[2])) live = true;
      }
      resolve(!live);
    });
  });
}
