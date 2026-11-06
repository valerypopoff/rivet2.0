import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { executeMaintenanceBackupAdapter, verifyRecoveryReceipt } from './maintenance-deployment-plan.mjs';
import { deploymentPreparationBinding } from './deployment-safety.mjs';
import { preserveDeploymentFailure } from './deployment-operation.mjs';
export { assertDeploymentBaseline, deploymentRecoveryIdentity } from './deployment-safety.mjs';

const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function regular(root, file) {
  const resolved = path.resolve(root, file);
  if (
    !inside(root, resolved) ||
    !(await fs.lstat(resolved)).isFile() ||
    !inside(await fs.realpath(root), await fs.realpath(resolved))
  )
    throw Error('Deployment policy files must remain regular files inside the repository.');
  return resolved;
}
function json(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Error('Deployment policy or adapter receipt is invalid JSON.');
  }
}

/** Installation policy is configured once. Every invocation still binds its
 * own immutable candidate, live baseline, values and namespace UID. */
export async function readDeploymentPolicy(file, root, identity) {
  const bytes = await fs.readFile(await regular(root, file));
  const policy = json(bytes);
  if (
    policy.formatVersion !== 1 ||
    policy.release !== identity.release ||
    policy.namespace !== identity.namespace ||
    policy.context !== identity.context ||
    typeof policy.namespaceUid !== 'string' ||
    !policy.namespaceUid
  )
    throw Error('Deployment policy installation identity is invalid.');
  const scripts = {};
  if (policy.preparation !== undefined && policy.preparation !== 'parallel-online')
    throw Error('Unknown deployment preparation contract.');
  if (policy.longProbeCutoff !== undefined && policy.longProbeCutoff !== 'after-rollout')
    throw Error('Unknown long-probe admission cutoff contract.');
  for (const name of ['backup', 'acceptance']) {
    const entry = policy[name];
    if (
      typeof entry?.script !== 'string' ||
      !entry.script.endsWith('.mjs') ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.sha256 ?? '')
    )
      throw Error(`Deployment policy needs a reviewed ${name} adapter and checksum.`);
    scripts[name] = await regular(root, entry.script);
    if (hash(await fs.readFile(scripts[name])) !== entry.sha256) throw Error(`Reviewed ${name} adapter changed.`);
  }
  return { policy, scripts, root, digest: hash(bytes) };
}

/** Reverify a retained observer using its original binding. This request grants
 * no deployment/recovery authority; the CLI separately verifies the installed
 * exact candidate and absence of an unfinished operation. */
export async function readAcceptanceVerificationContext(file, root, context, policyDigest) {
  const request = json(await fs.readFile(await regular(root, file)));
  const originalAcceptanceStartedAt = request.originalAcceptanceStartedAt ?? request.startedAt;
  if (
    request.formatVersion !== 1 ||
    !['after', 'long-probe-cutoff'].includes(request.stage) ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    typeof request.operationId !== 'string' ||
    !request.operationId ||
    !Number.isFinite(Date.parse(originalAcceptanceStartedAt)) ||
    !Number.isFinite(Date.parse(request.startedAt)) ||
    Date.parse(originalAcceptanceStartedAt) > Date.parse(request.startedAt) ||
    !/^sha256:[a-f0-9]{64}$/.test(request.installedManifestDigest ?? '') ||
    request.operationPlanDigest !== policyDigest ||
    [
      'release',
      'namespace',
      'context',
      'namespaceUid',
      'candidateManifestDigest',
      'valuesDigest',
      'authorizationManifestDigest',
      'adoptionStage',
    ].some((key) => request[key] !== context[key])
  )
    throw Error('Original acceptance request must match the current installation, candidate, values and policy.');
  return {
    ...context,
    operationId: request.operationId,
    installedManifestDigest: request.installedManifestDigest,
    originalAcceptanceStartedAt,
    recovering: true,
  };
}

/** The adapter implements installation-specific capture and safe application
 * journeys. It gets private request/receipt files, never shell interpolation. */
export async function runDeploymentStage(
  approval,
  stage,
  context,
  { artifactsDir, timeoutMs, runAdapter = executeMaintenanceBackupAdapter, now = Date.now } = {},
) {
  if (
    !['preflight', 'backup', 'before', 'after', 'backend', 'abort-preparation', 'long-probe-cutoff'].includes(stage) ||
    context.namespaceUid !== approval.policy.namespaceUid ||
    context.release !== approval.policy.release ||
    context.namespace !== approval.policy.namespace ||
    context.context !== approval.policy.context ||
    !context.installedManifestDigest ||
    !context.candidateManifestDigest ||
    !context.valuesDigest ||
    typeof context.operationId !== 'string' ||
    !context.operationId
  )
    throw Error('Deployment stage must match the live installation and immutable inputs.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw Error('Deployment adapter timeout is invalid.');
  if (
    !inside(approval.root, path.resolve(artifactsDir)) ||
    !(await fs.lstat(artifactsDir)).isDirectory() ||
    !inside(await fs.realpath(approval.root), await fs.realpath(artifactsDir))
  )
    throw Error('Deployment artifacts escaped the repository.');
  const adapter = ['preflight', 'backup'].includes(stage) ? 'backup' : 'acceptance';
  const consistency = stage === 'backup' ? context.consistency ?? 'online' : undefined;
  if (
    stage === 'backup' &&
    consistency !== 'online' &&
    (consistency !== 'quiesced' ||
      context.phase !== 'quiesced' ||
      !context.journalToken ||
      !(context.leaseExpiresAt > now()))
  )
    throw Error('Frozen recovery requires a live quiesced cutover lease.');
  const script = await regular(approval.root, approval.policy[adapter].script);
  if (hash(await fs.readFile(script)) !== approval.policy[adapter].sha256)
    throw Error('Reviewed deployment adapter changed before invocation.');
  const requestId = randomUUID();
  const directory = path.join(artifactsDir, `${stage}-${requestId}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const initial = await fs.lstat(directory, { bigint: true });
  const request = {
    ...context,
    formatVersion: 1,
    requestId,
    stage,
    token: context.journalToken ?? context.operationId,
    operationPlanDigest: approval.digest,
    consistency,
    startedAt: new Date(now()).toISOString(),
  };
  const requestPath = path.join(directory, 'request.json'),
    receiptPath = path.join(directory, 'receipt.json');
  await fs.writeFile(requestPath, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  await runAdapter(script, requestPath, receiptPath, { directory, timeoutMs });
  const assertDirectory = async () => {
    const current = await fs.lstat(directory, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      !inside(await fs.realpath(approval.root), await fs.realpath(directory))
    )
      throw Error('Deployment adapter directory identity changed.');
  };
  await assertDirectory();
  const receipt = json(await fs.readFile(await regular(directory, 'receipt.json')));
  if (
    receipt.formatVersion !== 1 ||
    receipt.requestId !== requestId ||
    receipt.operationId !== context.operationId ||
    receipt.stage !== stage ||
    receipt.release !== context.release ||
    receipt.namespace !== context.namespace ||
    receipt.context !== context.context ||
    receipt.valuesDigest !== context.valuesDigest ||
    receipt.namespaceUid !== context.namespaceUid ||
    receipt.candidateManifestDigest !== context.candidateManifestDigest ||
    receipt.installedManifestDigest !== context.installedManifestDigest ||
    receipt.authorizationManifestDigest !== context.authorizationManifestDigest ||
    receipt.adoptionStage !== context.adoptionStage ||
    receipt.operationPlanDigest !== approval.digest
  )
    throw Error('Deployment adapter receipt belongs to another attempt or installation.');
  let report;
  if (stage === 'backup') {
    report = await verifyRecoveryReceipt(receipt, directory, request, { now });
  } else if (stage === 'preflight') {
    if (
      receipt.kind !== 'rivet-deployment-preflight' ||
      receipt.passed !== true ||
      !['dependencies', 'capacity'].every(
        (name) =>
          receipt.checks?.[name]?.passed === true &&
          receipt.checks[name].observed === true &&
          typeof receipt.checks[name].evidence === 'string',
      )
    )
      throw Error(
        'Local deployment prerequisites are unverified. Update the reviewed backup adapter to support stage=preflight; no maintenance has started.',
      );
    for (const name of ['dependencies', 'capacity']) {
      if (!(await fs.stat(await regular(directory, receipt.checks[name].evidence))).size)
        throw Error('Deployment preflight evidence is empty.');
    }
    report = { verified: true, requestId, checks: ['dependencies', 'capacity'] };
  } else {
    const checks =
      stage === 'long-probe-cutoff'
        ? ['longProbeAdmissionClosed']
        : stage === 'abort-preparation'
          ? ['observerStopped', 'acceptedWorkSettled', 'fixtureCleaned']
          : stage === 'backend'
            ? ['developerApi', 'editorSession']
            : ['workflow', 'webApp', 'remoteDebugger'];
    if (
      stage === 'backend' &&
      (!context.backendCandidate?.uid ||
        !context.backendCandidate?.incarnation ||
        receipt.backendCandidate?.uid !== context.backendCandidate.uid ||
        receipt.backendCandidate?.incarnation !== context.backendCandidate.incarnation)
    )
      throw Error('Developer acceptance belongs to another backend incarnation.');
    if (
      receipt.kind !==
        (stage === 'long-probe-cutoff'
          ? 'rivet-deployment-observer-cutoff'
          : stage === 'abort-preparation'
            ? 'rivet-deployment-preparation-abort'
            : 'rivet-deployment-acceptance') ||
      receipt.passed !== true ||
      !checks.every(
        (name) =>
          receipt.checks?.[name]?.passed === true &&
          receipt.checks[name].observed === true &&
          typeof receipt.checks[name].evidence === 'string',
      )
    )
      throw Error(
        `Deployment ${stage} application acceptance failed or is incomplete. Inspect the private receipt; no automatic rollback follows.`,
      );
    for (const name of checks) {
      const evidence = await regular(directory, receipt.checks[name].evidence);
      if (!(await fs.stat(evidence)).size) throw Error('Application acceptance evidence is empty.');
    }
    report = { verified: true, requestId, checks };
  }
  await assertDirectory();
  await fs.writeFile(path.join(directory, 'verified.json'), JSON.stringify({ ...report, stage }), {
    flag: 'wx',
    mode: 0o600,
  });
  return Object.freeze({
    ...report,
    stage,
    directory,
    binding: deploymentPreparationBinding(context, approval.digest, stage),
  });
}

/** Own the order once: no deployment mutation before prechecks/recovery proof,
 * and no application failure routed back into workload retirement/rollback. */
export async function executeDeploymentWorkflow({
  approval,
  context,
  maintenance = false,
  verificationOnly = false,
  run,
  prepareSafety,
  verifyActivation = async () => {},
  artifactsDir,
  timeoutMs,
  stage = runDeploymentStage,
  artifact = async () => {},
}) {
  const report = {
    formatVersion: 1,
    operationId: context?.operationId,
    state: 'preparing',
    candidateManifestDigest: context?.candidateManifestDigest,
    stages: [],
    outcome: {
      infrastructure: 'not-started',
      autoscaling: 'not-verified',
      application: context ? 'not-verified' : 'not-configured',
    },
    recoveryMode: verificationOnly
      ? 'verification-only'
      : maintenance
        ? 'quiesced'
        : context
          ? 'online'
          : 'not-configured',
  };
  const earlyCutoff = context && !maintenance && approval?.policy?.longProbeCutoff === 'after-rollout';
  const acceptanceRecovery = earlyCutoff
    ? '--acceptance-only --acceptance-request <original long-probe-cutoff request.json>'
    : '--acceptance-only';
  const save = async (state) => {
    report.state = state;
    await artifact('deployment-result.json', JSON.stringify(report, null, 2));
  };
  const saveFailure = async (state, cause) => {
    try {
      await save(state);
    } catch (writeError) {
      // Preserve both causes even when the disk also prevents a failure receipt.
      cause = preserveDeploymentFailure(
        cause,
        writeError,
        `${cause instanceof Error ? cause.message : String(cause)}\nDeployment result acknowledgement is unconfirmed.`,
      );
    }
    return cause;
  };
  const failAfterInfrastructure = async (state, message, cause) => {
    throw Error(message, { cause: await saveFailure(state, cause) });
  };
  const unconfirmedEvidence = (cause) =>
    failAfterInfrastructure(
      'infrastructure-complete-evidence-unconfirmed',
      `Infrastructure deployment completed but saving its result is unconfirmed. Inspect diagnostics before any retry; no rollback was attempted.${earlyCutoff ? ` Retain the observer with ${acceptanceRecovery}.` : ''}`,
      cause,
    );
  let sequentialObserverReady = false;
  const abortOnlinePreparation = async (failures) => {
    try {
      report.stages.push(await stage(approval, 'abort-preparation', context, { artifactsDir, timeoutMs }));
    } catch (error) {
      failures.push(error);
    }
    throw new AggregateError(failures, 'Online deployment preparation failed; nothing applied.');
  };
  try {
    await save('preparing');
    if (context && typeof prepareSafety !== 'function')
      throw Error('Production deployment requires a safety-contract preparation step.');
    let before,
      backup,
      parallelPreparation = false;
    if (context) {
      parallelPreparation =
        approval?.policy?.preparation === 'parallel-online' && !context.recovering && !maintenance && !verificationOnly;
      if (parallelPreparation) {
        // Independent reviewed adapters share immutable inputs, not files or
        // journals. Settle both even on failure before any mutation or recovery.
        await save('checking-recovery');
        const results = await Promise.allSettled(
          ['before', 'backup'].map((name) =>
            Promise.resolve().then(() => stage(approval, name, context, { artifactsDir, timeoutMs })),
          ),
        );
        for (const result of results) if (result.status === 'fulfilled') report.stages.push(result.value);
        const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (failures.length) await abortOnlinePreparation(failures);
        [before, backup] = results.map((result) => result.value);
      } else if (!context.recovering) {
        before = await stage(approval, 'before', context, { artifactsDir, timeoutMs });
        sequentialObserverReady = Boolean(earlyCutoff);
        report.stages.push(before);
      }
      if (!parallelPreparation) await save('checking-recovery');
      if (!parallelPreparation && !maintenance && !verificationOnly) {
        backup = await stage(approval, 'backup', context, { artifactsDir, timeoutMs });
        report.stages.push(backup);
      }
    }
    let safety;
    try {
      safety = prepareSafety ? await prepareSafety({ before, backup }) : undefined;
      report.outcome.infrastructure = verificationOnly ? 'checking-existing' : 'in-progress';
      await save(verificationOnly ? 'verifying' : 'deploying');
    } catch (error) {
      // No infrastructure command has started. A failed readiness receipt must
      // close the prepared observer just like any other preparation failure.
      report.state = 'preparing';
      report.outcome.infrastructure = 'not-started';
      if (parallelPreparation) await abortOnlinePreparation([error]);
      throw error;
    }
    const applied = await run(safety);
    report.outcome.infrastructure = verificationOnly ? 'existing-verified' : 'applied';
    if (applied?.phase === 'complete') report.operation = { token: applied.token, phase: applied.phase };
  } catch (error) {
    // Only an acknowledged before stage grants cleanup authority. Never stop an
    // observer once workload mutation may have started, or replay a partial seed.
    if (sequentialObserverReady && report.outcome.infrastructure === 'not-started') {
      try {
        await abortOnlinePreparation([error]);
      } catch (settlementError) {
        error = settlementError;
      }
    }
    if (error?.deploymentOperation) report.operation = error.deploymentOperation;
    if (verificationOnly && report.state === 'verifying') {
      report.outcome.infrastructure = 'verification-incomplete';
      const cause = await saveFailure('verification-incomplete', error);
      const recovery =
        report.operation?.phase && report.operation.phase !== 'complete'
          ? `--resume-cutover ${report.operation.token} --verify-only`
          : '--acceptance-only';
      throw Error(
        `Installed-release verification failed; no release changes were made. Resolve the observation failure and retry ${recovery}, not the deployment.\n${error instanceof Error ? error.message : String(error)}`,
        { cause },
      );
    }
    if (report.state === 'deploying' && report.operation?.aborted && report.operation.acknowledgement === 'confirmed') {
      report.outcome.infrastructure = 'not-changed';
      throw await saveFailure('deployment-aborted', error);
    }
    if (report.state === 'deploying') report.outcome.infrastructure = 'unconfirmed';
    throw await saveFailure(report.state === 'deploying' ? 'deployment-incomplete' : 'preparation-failed', error);
  }
  // Stop admitting new five-minute requests before slower autoscaler checks and
  // final acceptance. Already accepted probes and short availability monitoring
  // remain owned by the observer until the normal after stage settles them.
  if (earlyCutoff) {
    try {
      report.stages.push(await stage(approval, 'long-probe-cutoff', context, { artifactsDir, timeoutMs }));
    } catch (cause) {
      await failAfterInfrastructure(
        'infrastructure-complete-observation-unconfirmed',
        `Long-probe admission cutoff is unconfirmed after infrastructure completed. Inspect the retained observer; recover with ${acceptanceRecovery}, not another deployment.`,
        cause,
      );
    }
  }
  try {
    await save('infrastructure-complete');
  } catch (cause) {
    await unconfirmedEvidence(cause);
  }
  try {
    const activation = await verifyActivation();
    report.outcome.autoscaling = activation?.skipped ? 'not-configured' : 'verified';
  } catch (cause) {
    report.outcome.autoscaling = 'unconfirmed';
    await failAfterInfrastructure(
      'infrastructure-complete-activation-unverified',
      `Workloads settled, but post-deployment autoscaler verification is unconfirmed. No workloads were stopped or rolled back. Inspect diagnostics and use ${acceptanceRecovery} after resolving the cause; do not replay the deployment.`,
      cause,
    );
  }
  if (context) {
    try {
      report.stages.push(await stage(approval, 'after', context, { artifactsDir, timeoutMs }));
      report.outcome.application = 'passed';
    } catch (cause) {
      report.outcome.application = 'failed';
      await failAfterInfrastructure(
        'infrastructure-complete-application-failed',
        "Infrastructure deployment completed, but application acceptance failed. Traffic and scaling remain active. Inspect the private after receipt and repair forward; no automatic rollback was attempted. Use --acceptance-only --acceptance-request <original after request.json> to retain this attempt's observer identity.",
        cause,
      );
    }
  }
  try {
    await save(context ? 'complete' : 'infrastructure-complete');
  } catch (cause) {
    await unconfirmedEvidence(cause);
  }
  return report;
}
