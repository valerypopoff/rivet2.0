import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { assertStudioServerReleaseManifest, getStudioServerReleaseManifestDigest } from './studio-server-release-manifest.mjs';

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
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${description} is not valid JSON.`); }
};

async function localFile(root, file) {
  const resolved = path.resolve(root, file);
  if (!within(root, resolved) || !(await fs.lstat(resolved)).isFile() || !within(await fs.realpath(root), await fs.realpath(resolved)))
    throw new Error('Maintenance files must be regular, repository-contained files.');
  return resolved;
}

async function recoveryDirectory(root, directory, expected) {
  const identity = await fs.lstat(directory, { bigint: true });
  if (!identity.isDirectory() || !within(root, path.resolve(directory))
    || !within(await fs.realpath(root), await fs.realpath(directory))
    || (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)))
    throw new Error('Frozen recovery directory identity changed or escaped the repository.');
  return identity;
}

export function assertMaintenancePlan(plan, { release, namespace, context, candidateDigest, valuesDigest, now = Date.now(), allowExpiredForRecovery = false }) {
  const issued = Date.parse(plan?.issuedAt);
  const expiry = Date.parse(plan?.expiresAt);
  if (plan?.formatVersion !== 1 || plan.kind !== 'rivet-maintenance-deployment' ||
      plan.release !== release || plan.namespace !== namespace || plan.context !== context ||
      !digestPattern.test(valuesDigest ?? '') || plan.valuesDigest !== valuesDigest ||
      typeof plan.namespaceUid !== 'string' || !plan.namespaceUid ||
      plan.candidateManifestDigest !== candidateDigest || !digestPattern.test(candidateDigest) ||
      !digestPattern.test(plan.installedManifestDigest ?? '') ||
      typeof plan.installedManifestPath !== 'string' || !plan.installedManifestPath ||
      plan.accepts?.interruption !== true || plan.accepts?.qualificationWaived !== true || plan.accepts?.dataLoss !== false ||
      typeof plan.reason !== 'string' || !plan.reason.trim() ||
      !Number.isFinite(issued) || !Number.isFinite(expiry) || issued > now || expiry <= issued
      || (!allowExpiredForRecovery && expiry <= now) || expiry - issued > 2 * 60 * 60 * 1000 ||
      typeof plan.backup?.script !== 'string' || !plan.backup.script.endsWith('.mjs') || !digestPattern.test(plan.backup.sha256 ?? ''))
    throw new Error('Invalid, expired or mismatched explicit maintenance deployment plan.');
  return plan;
}

/** A maintenance waiver is local operation authority, never a qualification certificate. */
export async function readMaintenancePlan(file, root, identity) {
  const bytes = await fs.readFile(await localFile(root, file));
  const plan = assertMaintenancePlan(parseJson(bytes, 'Maintenance deployment plan'), identity);
  const baseline = assertStudioServerReleaseManifest(parseJson(await fs.readFile(await localFile(root, plan.installedManifestPath)), 'Installed release manifest'), { requirePromoted: true });
  if (getStudioServerReleaseManifestDigest(baseline, { requirePromoted: true }) !== plan.installedManifestDigest)
    throw new Error('The maintenance baseline is not the exact promoted installed manifest.');
  const scriptPath = await localFile(root, plan.backup.script);
  if (hash(await fs.readFile(scriptPath)) !== plan.backup.sha256)
    throw new Error('The reviewed maintenance backup script has changed.');
  return { plan, baseline, scriptPath, digest: hash(bytes), root };
}

export function assertMaintenanceBaseline(approval, { installed, manifest, namespaceUid, now = Date.now(), recovering = false,
  recoveryJournal, resumeToken }) {
  const { plan, baseline } = approval;
  const ownsRecovery = recovering && typeof resumeToken === 'string' && !!resumeToken
    && recoveryJournal?.token === resumeToken && ['quiescing', 'quiesced', 'validating', 'resuming'].includes(recoveryJournal.phase)
    && recoveryJournal.release === plan.release && recoveryJournal.namespace === plan.namespace
    && recoveryJournal.manifestDigest === plan.candidateManifestDigest && recoveryJournal.operationPlanDigest === approval.digest;
  if (recovering && !ownsRecovery) throw new Error('Maintenance recovery requires the exact unfinished journal token and operation plan.');
  assertMaintenancePlan(plan, { ...plan, candidateDigest: getStudioServerReleaseManifestDigest(manifest, { requirePromoted: true }),
    now, allowExpiredForRecovery: ownsRecovery });
  if (namespaceUid !== plan.namespaceUid)
    throw new Error('Maintenance namespace identity changed. No deployment is allowed.');
  const installedDigest = installed?.release?.production?.manifestDigest;
  if (installedDigest !== plan.installedManifestDigest && !(ownsRecovery && installedDigest === plan.candidateManifestDigest))
    throw new Error('The live release does not match the maintenance baseline or exact recovery candidate.');
  const schema = manifest.database.managedWorkflowSchema.version;
  if (baseline.database.managedWorkflowSchema.version !== schema || installed?.release?.production?.database?.managedWorkflowSchemaVersion !== schema)
    throw new Error('The qualification waiver requires an unchanged managed schema; use the qualified migration procedure.');
}

export async function verifyRecoveryReceipt(receipt, directory, request, { now = Date.now } = {}) {
  if (receipt?.formatVersion !== 1 || receipt.kind !== (request.consistency === 'online' ? 'rivet-recovery-checkpoint' : 'rivet-frozen-recovery-checkpoint') ||
      receipt.requestId !== request.requestId || receipt.token !== request.token ||
      !['online', 'quiesced'].includes(request.consistency) || receipt.consistency !== request.consistency ||
      receipt.release !== request.release || receipt.namespace !== request.namespace || receipt.context !== request.context ||
      receipt.namespaceUid !== request.namespaceUid || receipt.operationPlanDigest !== request.operationPlanDigest ||
      receipt.candidateManifestDigest !== request.candidateManifestDigest ||
      receipt.installedManifestDigest !== request.installedManifestDigest ||
      receipt.databaseRestoreVerified !== true || receipt.objectReferencesCovered !== true ||
      receipt.encryptionKeysRecoverable !== true || receipt.unrelatedDataExcluded !== true ||
      !Array.isArray(receipt.artifacts) || receipt.artifacts.length < 1)
    throw new Error('Frozen backup receipt is incomplete or belongs to another operation.');
  const startedAt = Date.parse(request.startedAt), capturedAt = Date.parse(receipt.capturedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(capturedAt) || capturedAt < startedAt || capturedAt > now())
    throw new Error('Recovery backup is stale or its capture point is unconfirmed.');
  const roles = new Set();
  const paths = new Set();
  for (const item of receipt.artifacts) {
    if (!['database', 'objects', 'keys', 'verification'].includes(item?.role) || typeof item.path !== 'string' ||
        !digestPattern.test(item.sha256 ?? '')) throw new Error('Invalid backup artifact inventory.');
    const file = await localFile(directory, item.path);
    const canonical = await fs.realpath(file);
    const identity = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (paths.has(identity)) throw new Error('Invalid backup artifact inventory: duplicate artifact file.');
    if ((await fs.stat(file)).size === 0 || await hashFile(file) !== item.sha256)
      throw new Error('A recovery artifact is empty or its checksum has changed.');
    roles.add(item.role);
    paths.add(identity);
  }
  if (!['database', 'objects', 'keys', 'verification'].every(role => roles.has(role)))
    throw new Error('Recovery requires database, objects, encryption keys and restore-verification artifacts.');
  return { formatVersion: 1, requestId: request.requestId, verified: true, artifactCount: receipt.artifacts.length };
}

/** Invoked only under the cutover lease, after every old writer has stopped.
 * The reviewed adapter reads production and restores only into isolated local
 * scratch storage. Neither its output nor recovery data is printed or uploaded.
 */
export async function captureMaintenanceCheckpoint(approval, context, { artifactsDir, timeoutMs, runHook = executeMaintenanceBackupAdapter }) {
  const { plan } = approval;
  // Expiry controls admission. The still-owned journal allows a previously
  // admitted operation (or its exact-token recovery) to finish its checkpoint.
  assertMaintenancePlan(plan, { ...plan, candidateDigest: plan.candidateManifestDigest, allowExpiredForRecovery: true });
  if (typeof context.token !== 'string' || !context.token || context.release !== plan.release || context.namespace !== plan.namespace
    || context.manifestDigest !== plan.candidateManifestDigest || context.operationPlanDigest !== approval.digest
    || context.phase !== 'quiesced' || !Number.isFinite(context.leaseExpiresAt) || context.leaseExpiresAt <= Date.now())
    throw new Error('Frozen backup requires the matching live quiesced operation context.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimerMs)
    throw new Error('Frozen backup requires a positive timeout within the supported timer range.');
  if (!within(approval.root, path.resolve(artifactsDir)) || !(await fs.lstat(artifactsDir)).isDirectory()
    || !within(await fs.realpath(approval.root), await fs.realpath(artifactsDir)))
    throw new Error('Frozen recovery directory must remain inside the repository.');
  if (hash(await fs.readFile(await localFile(approval.root, approval.plan.backup.script))) !== approval.plan.backup.sha256)
    throw new Error('The approved backup adapter changed before the frozen checkpoint.');
  const requestId = randomUUID();
  const directory = path.join(artifactsDir, `frozen-recovery-${requestId}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const directoryIdentity = await recoveryDirectory(approval.root, directory);
  const request = {
    formatVersion: 1, requestId, token: context.token, release: context.release, namespace: context.namespace,
    context: approval.plan.context, namespaceUid: approval.plan.namespaceUid,
    operationPlanDigest: approval.digest,
    installedManifestDigest: approval.plan.installedManifestDigest,
    candidateManifestDigest: approval.plan.candidateManifestDigest,
    consistency: 'quiesced',
    startedAt: new Date().toISOString(),
  };
  const requestPath = path.join(directory, 'request.json');
  const receiptPath = path.join(directory, 'receipt.json');
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  // Never retry a lost acknowledgement. Explicit token recovery creates a fresh
  // checkpoint after re-quiescing, so newly accepted work is not omitted.
  await runHook(approval.scriptPath, requestPath, receiptPath, { directory, timeoutMs });
  // The adapter cannot redefine the trusted root by replacing its directory
  // with a symlink/junction or another directory while producing the receipt.
  await recoveryDirectory(approval.root, directory, directoryIdentity);
  const receipt = parseJson(await fs.readFile(await localFile(directory, 'receipt.json')), 'Frozen backup receipt');
  const verified = await verifyRecoveryReceipt(receipt, directory, request);
  await recoveryDirectory(approval.root, directory, directoryIdentity);
  await fs.writeFile(path.join(directory, 'verified.json'), `${JSON.stringify(verified)}\n`, { flag: 'wx', mode: 0o600 });
  return verified;
}

export async function executeMaintenanceBackupAdapter(script, request, receipt, { directory, timeoutMs,
  shutdownTimeoutMs = 5_000, spawnProcess = spawn, platform = process.platform }) {
  if (![timeoutMs, shutdownTimeoutMs].every(value => Number.isFinite(value) && value > 0 && value <= maxTimerMs))
    throw new Error('Frozen backup adapter timeouts must be positive and within the supported timer range.');
  const output = await fs.open(path.join(directory, 'adapter-private.log'), 'wx', 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, [script, '--request', request, '--receipt', receipt], {
        // A private process group lets a timed-out POSIX adapter's capture or
        // local-restore children be stopped together, without host-wide kills.
        shell: false, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', output.fd, output.fd],
      });
      let timedOut = false;
      let settled = false;
      let childClosed = false;
      let treeStopped = false;
      let helper;
      let helperClosed = false;
      let shutdownTimer;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(shutdownTimer);
        if (error) reject(error); else resolve();
      };
      const failed = () => finish(new Error('Frozen backup adapter did not complete successfully. Inspect its private local log; no automatic retry or deployment follows.'));
      const unconfirmed = () => {
        if (settled) return;
        // Do not let an unconfirmed child keep the deploying CLI alive forever.
        // Its partial files are preserved; no verified checkpoint or retry follows.
        if (helper && !helperClosed) { tryKill(helper); helper.unref(); }
        if (!childClosed) child.unref();
        finish(new Error('Frozen backup adapter timed out and its process-tree shutdown is unconfirmed. Inspect its private local log and settle its children before recovery.'));
      };
      const timer = setTimeout(() => {
        timedOut = true;
        shutdownTimer = setTimeout(unconfirmed, shutdownTimeoutMs);
        stopAdapterTree(child, { spawnProcess, platform, onHelper: value => {
          helper = value;
          helper.once('close', () => { helperClosed = true; });
        } }).then(confirmed => {
          if (settled) return;
          treeStopped = confirmed;
          if (!confirmed) unconfirmed();
          else if (childClosed) failed();
        }, unconfirmed);
      }, timeoutMs);
      child.once('error', error => { if (timedOut) unconfirmed(); else finish(error); });
      child.once('close', code => {
        childClosed = true;
        if (timedOut) { if (treeStopped) failed(); }
        else if (code === 0) finish();
        else failed();
      });
    });
  } finally { await output.close(); }
}

function tryKill(child) {
  try { return child.kill('SIGKILL'); } catch { return false; }
}

async function stopAdapterTree(child, { spawnProcess, platform, onHelper }) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); return true; }
    catch (error) { return error.code === 'ESRCH'; }
  }
  // This PID is the still-owned child object, not a discovered process name.
  // /T includes its pg_dump/local-restore children; /F cannot be ignored by an
  // adapter's signal handler. Wait for the command before reporting failure.
  return new Promise(resolve => {
    const taskkill = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore',
    });
    onHelper(taskkill);
    taskkill.once('error', () => { tryKill(child); resolve(false); });
    taskkill.once('close', code => {
      if (code !== 0) tryKill(child);
      resolve(code === 0);
    });
  });
}
