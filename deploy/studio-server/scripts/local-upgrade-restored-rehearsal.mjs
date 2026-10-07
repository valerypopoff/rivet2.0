import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { fsync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BACKUP_DOMAINS,
  scanBackupRoot,
  assertDisjointBackupDirectories,
  createFreshBackupDirectory,
  assertNoBackupWriters,
  verifyBackupManifestReceipt,
} from './local-upgrade-backup.mjs';

const execute = promisify(execFile);
const syncDescriptor = promisify(fsync);
const moduleRoot = '/app/packages/studio-server-api/dist/studio-server-api/src/';
const mounts = {
  workflows: '/workflows',
  recordings: '/workflow-recordings',
  appData: '/data/rivet-app',
  runtimeLibraries: '/data/runtime-libraries',
};

export const RESTORED_REHEARSAL_PHASES = Object.freeze([
  'isolated-startup',
  'conversion-restart-validation',
  'online-return-to-legacy',
  'corrupt-startup-key-free-offline-recovery',
  'legacy-resumption-commit-restart-source-fenced',
]);

export const RESTORED_REHEARSAL_STEPS = Object.freeze([
  'provision-control',
  'enter-maintenance',
  'fingerprint-source',
  'initial-startup',
  'initial-pause',
  'initial-transfer',
  'initial-activation',
  'initial-restart',
  'initial-validation',
  'return-to-legacy',
  'legacy-restart',
  'legacy-validation',
  'legacy-refence',
  'second-pause',
  'second-transfer',
  'second-activation',
  'second-restart',
  'second-validation',
  'corrupt-startup',
  'offline-recovery',
  'recovered-startup',
  'recovered-validation',
  'legacy-resumption',
]);

/** Only release a fixed operation name, never exception text, command output,
 * clone paths, settings, credentials, or arbitrary fields from a failed run. */
export function redactedRestoredFailureStep(result, expected) {
  if (
    result?.passed !== false ||
    result.imageId !== expected.imageId ||
    result.backupReceipt !== expected.backupReceipt ||
    !RESTORED_REHEARSAL_STEPS.includes(result.failureStep)
  )
    return null;
  return result.failureStep;
}

/** A top-level PASS alone is not a completed rehearsal. Bind the evidence to
 * the independently supplied backup/image/limits and require safe cleanup. */
export function assertRestoredRehearsalResult(result, expected) {
  assert.equal(result?.passed, true);
  assert.equal(result.cleanupFailed, false);
  assert.deepEqual(result.retainedContainers, []);
  assert.equal(result.finalSourceWritesPaused, true);
  assert.equal(result.requiresSeparateControlledFunctionalRehearsal, true);
  assert.match(expected.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(expected.backupReceipt, /^[a-f0-9]{64}$/);
  assert.equal(result.imageId, expected.imageId);
  assert.equal(result.backupReceipt, expected.backupReceipt);
  assert.equal(result.memoryLimitMiB, expected.memoryMiB);
  assert.equal(result.cpus, expected.cpus);
  assert.match(result.frozenSourceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(result.sampledPeakMemoryBytes) && result.sampledPeakMemoryBytes > 0);
  assert.match(result.container, /^rivet-restored-rehearsal-[a-f0-9-]{36}$/);
  assert.ok(Array.isArray(result.phases));
  assert.deepEqual(
    result.phases.map((entry) => entry.phase),
    RESTORED_REHEARSAL_PHASES,
  );
  for (const entry of result.phases) {
    assert.deepEqual(Object.keys(entry).sort(), ['checkedAt', 'phase']);
    assert.equal(typeof entry.checkedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(entry.checkedAt)));
  }
}

export function restoredOperatorRequestScript(route, data) {
  assert.ok(['', '/pause', '/fingerprint', '/copy', '/action'].includes(route), 'Unknown operator route.');
  return `
    const key=process.env.RIVET_KEY?.trim();
    if(!key)throw Error('Clone operator key is required');
    const proxyAuth=process.getBuiltinModule('node:crypto').createHash('sha256').update(key+':proxy-auth').digest('hex');
    const serviceHeaders={'X-Rivet-Proxy-Auth':proxyAuth};
    // This container has no nginx: use the backend route, with the same
    // authenticated service boundary that nginx normally supplies.
    const login=await fetch('http://127.0.0.1/ui-auth',{signal:AbortSignal.timeout(15_000),method:'POST',redirect:'manual',headers:{...serviceHeaders,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({key,return_to:'/'})});
    if(login.status!==303)throw Error('Login failed');
    const cookie=login.headers.get('set-cookie')?.split(';',1)[0];
    await login.body?.cancel();
    if(!cookie)throw Error('Clone operator session was not issued');
    const response=await fetch('http://127.0.0.1/api/app-settings/local-upgrade${route}',{signal:AbortSignal.timeout(15*60_000),headers:{...serviceHeaders,Cookie:cookie,'Content-Type':'application/json','X-Rivet-Migration-Intent':'1'},${data === undefined ? '' : `method:'POST',body:${JSON.stringify(JSON.stringify(data))},`}});
    if(!response.ok)throw Error('Operator request failed');
    console.log(response.status===204?'null':await response.text());`;
}

export function restoredReadinessProbeScript(timeoutMs = 5_000, port = 21890) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5_000);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  return `fetch('http://127.0.0.1:${port}/readyz',{signal:AbortSignal.timeout(${timeoutMs})}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`;
}

export function assertRestoredSourceFingerprint(actual, expected) {
  assert.match(actual, /^[a-f0-9]{64}$/);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(actual, expected, 'Restored authoritative source changed; it no longer qualifies the original backup.');
}

export async function resumeRestoredLegacyFenced({ action, request, restart }) {
  await action('resume');
  // Resumption closes old process admissions until restart. Re-fence before
  // that restart, so real retained production data cannot be pruned by cleanup.
  await request('/pause', {});
  await restart();
}

/** Track ownership before launching: a failed Docker CLI call may still have
 * created a live container. Transient offline tools need the same cleanup. */
export function createRestoredContainerTracker(runDocker, owner, cleanupDocker = runDocker) {
  const pending = new Map();
  let backendAttempted = false;
  const launch = async (args, transient) => {
    const name = transient ? `${owner}-tool-${randomUUID()}` : owner;
    pending.set(name, transient);
    if (!transient) backendAttempted = true;
    const result = await runDocker([
      'run',
      ...(transient ? ['--rm'] : ['-d']),
      '--name',
      name,
      '--label',
      `rivet.local-upgrade.restored=${owner}`,
      ...args,
    ]);
    if (transient) pending.delete(name);
    return result;
  };
  return {
    runTool: (args) => launch(args, true),
    start: (args) => launch(args, false),
    get backendAttempted() {
      return backendAttempted;
    },
    async cleanup(remove) {
      let failed = false;
      const retained = [];
      for (const [name, transient] of pending) {
        try {
          const stillListed = async () =>
            (await cleanupDocker(['ps', '-a', '--format', '{{.Names}}'])).stdout.split(/\r?\n/).includes(name);
          let inspection;
          try {
            inspection = JSON.parse((await cleanupDocker(['inspect', name])).stdout)[0];
          } catch (error) {
            // Docker --rm can remove a failed one-shot helper before the CLI
            // reports its nonzero exit. Never apply this exception to the
            // persistent backend container, or to an unverifiable daemon.
            if (transient && !(await stillListed())) continue;
            throw error;
          }
          assert.equal(inspection.Config.Labels?.['rivet.local-upgrade.restored'], owner);
          assert.match(inspection.Id, /^[a-f0-9]{64}$/, 'Invalid owned container ID.');
          assert.equal(typeof inspection.State?.Running, 'boolean', 'Invalid owned container state.');
          // The inspected ID, unlike a reusable name, still identifies the
          // same container if Docker auto-removes a helper during cleanup.
          if (inspection.State.Running) await cleanupDocker(['stop', '--time', '150', inspection.Id]);
          if (transient && !(await stillListed())) continue;
          if (remove) await cleanupDocker(['rm', inspection.Id]);
          else retained.push(name);
        } catch {
          failed = true;
          retained.push(name);
        }
      }
      return { failed, retained };
    },
  };
}

/** Cancel foreground commands, but leave ownership-checked cleanup usable.
 * A timeout or Ctrl-C must not abandon a writable restored-data clone. */
export async function withRestoredRehearsalInterruptions(work, events = process) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Isolated rehearsal interrupted.'));
  events.on('SIGINT', interrupt);
  events.on('SIGTERM', interrupt);
  try {
    return await work(controller.signal);
  } finally {
    events.off('SIGINT', interrupt);
    events.off('SIGTERM', interrupt);
  }
}

export async function inspectRestoredRehearsal({ restored, receipt, memoryMiB, cpus }) {
  restored = path.resolve(restored);
  assert.ok(
    Number.isInteger(memoryMiB) && memoryMiB >= 512 && memoryMiB <= 16384,
    'Explicit 512–16384 MiB memory limit required.',
  );
  assert.ok(Number.isFinite(cpus) && cpus > 0 && cpus <= 32, 'Explicit CPU limit required.');
  assert.match(receipt, /^[a-f0-9]{64}$/);
  const proofPath = path.join(restored, 'restored-copy.json');
  const stat = await fs.lstat(proofPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < 64 * 1048576);
  const proof = JSON.parse(await fs.readFile(proofPath, 'utf8'));
  assert.deepEqual(
    (await fs.readdir(restored)).sort(),
    [...BACKUP_DOMAINS, 'restored-copy.json'].sort(),
    'Unexpected restored root entries.',
  );
  assert.equal(proof.version, 2, 'Restore a fresh copy with receipt-bound proof version 2.');
  assert.equal(proof.backupReceipt, receipt);
  verifyBackupManifestReceipt(proof.backupManifest, receipt);
  await assertDisjointBackupDirectories(BACKUP_DOMAINS.map((domain) => path.join(restored, domain)));
  for (const domain of BACKUP_DOMAINS)
    assert.deepEqual(
      await scanBackupRoot(path.join(restored, domain), domain),
      proof.backupManifest.domains[domain],
      'Restored copy drifted; restore a fresh copy.',
    );
  return {
    restored,
    receipt,
    memoryMiB,
    cpus,
    mode: 'isolated-restored-copy',
    network: 'none',
    publishedPorts: [],
    executesProductionGraphs: false,
  };
}

async function docker(args, allowFailure = false, signal) {
  try {
    signal?.throwIfAborted();
    return await execute('docker', args, {
      maxBuffer: 2 * 1048576,
      timeout: 20 * 60_000,
      windowsHide: true,
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (allowFailure) return { stdout: '', failed: true };
    // Docker/Node errors can include environment data, package output or source
    // parser text. Never copy raw diagnostics into a qualification report.
    throw new Error('Isolated rehearsal command failed; retained clone and control data need operator inspection.');
  }
}

async function main(signal) {
  const runDocker = (args, allowFailure = false) => docker(args, allowFailure, signal);
  const args = process.argv.slice(2);
  const value = (key) => {
    const index = args.indexOf(key);
    assert.ok(index >= 0 && args[index + 1], `Missing ${key}.`);
    return args[index + 1];
  };
  const plan = await inspectRestoredRehearsal({
    restored: value('--restored'),
    receipt: value('--receipt'),
    memoryMiB: Number(value('--memory-mib')),
    cpus: Number(value('--cpus')),
  });
  const image = JSON.parse((await runDocker(['image', 'inspect', value('--image')])).stdout)[0];
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  if (!args.includes('--run')) {
    console.log(JSON.stringify({ ...plan, imageId: image.Id }, null, 2));
    return;
  }
  // Rootless/user-remapped Docker requires a separate, reviewed UID mapping.
  // Never silently chmod/chown restored data to make an unknown mapping work.
  assert.equal(process.platform, 'linux', 'Run the real-data rehearsal on a Linux Docker host.');
  const security = JSON.parse((await runDocker(['info', '--format', '{{json .SecurityOptions}}'])).stdout);
  assert.ok(
    !security.some((option) => /rootless|userns/.test(option)),
    'Rootless/user-remapped Docker needs a separately reviewed UID mapping.',
  );
  const listed = (await runDocker(['ps', '-aq'])).stdout.trim().split(/\s+/).filter(Boolean);
  const containers = listed.length ? JSON.parse((await runDocker(['inspect', ...listed])).stdout) : [];
  await assertNoBackupWriters(
    {
      knownWritersStopped: true,
      roots: Object.fromEntries(BACKUP_DOMAINS.map((domain) => [domain, { source: path.join(plan.restored, domain) }])),
    },
    containers,
  );
  const output = path.resolve(value('--output'));
  for (const domain of BACKUP_DOMAINS) {
    const stat = await fs.stat(path.join(plan.restored, domain));
    assert.equal(
      stat.uid,
      10001,
      'Restored roots must be owned by Docker UID 10001; change only the disposable clone.',
    );
  }
  await createFreshBackupDirectory(output, [
    plan.restored,
    ...BACKUP_DOMAINS.map((domain) => path.join(plan.restored, domain)),
  ]);
  const control = path.join(output, 'control');
  await fs.mkdir(control, { mode: 0o700 });
  await fs.chown(control, 10001, 10001);
  const envFile = path.join(output, 'clone.env');
  const env = {
    HOME: '/home/rivet',
    TMPDIR: '/tmp',
    PORT: '80',
    RIVET_DEPLOYMENT_TOPOLOGY: 'single-host',
    RIVET_API_PROFILE: 'combined',
    RIVET_BACKEND_API_PORT: '80',
    RIVET_BACKEND_EXECUTOR_PORT: '21889',
    RIVET_BACKEND_HEALTH_PORT: '21890',
    // This isolated, write-fenced clone has no active executions to drain.
    // Keep production's shutdown grace unchanged while allowing the several
    // required rehearsal restarts to finish within the host gate deadline.
    RIVET_SHUTDOWN_GRACE_SECONDS: '10',
    RIVET_WORKSPACE_ROOT: '/workspace',
    RIVET_WORKFLOWS_ROOT: mounts.workflows,
    RIVET_WORKFLOW_RECORDINGS_ROOT: mounts.recordings,
    RIVET_APP_DATA_ROOT: mounts.appData,
    RIVET_RUNTIME_LIBRARIES_ROOT: mounts.runtimeLibraries,
    RIVET_RUNTIME_PROCESS_ROLE: 'api',
    RIVET_SERVER_UI_AUTH_MODE: 'key',
    RIVET_KEY: randomBytes(32).toString('hex'),
    RIVET_LOCAL_METADATA_UPGRADE_ENABLED: '1',
    RIVET_VM_MIGRATION_EDITOR_CONTROL: '1',
    RIVET_LOCAL_METADATA_CONTROL_ROOT: '/data/local-metadata',
    RIVET_LOCAL_METADATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    RIVET_LOCAL_METADATA_MAX_BUNDLE_MIB: '32',
    RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED: 'false',
    RIVET_ENABLE_LATEST_REMOTE_DEBUGGER: 'false',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    NODE_OPTIONS: `--max-old-space-size=${Math.max(192, Math.floor(plan.memoryMiB * 0.5))}`,
  };
  await fs.writeFile(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    { mode: 0o600, flag: 'wx' },
  );
  const name = 'rivet-restored-rehearsal-' + randomUUID();
  const tracker = createRestoredContainerTracker(runDocker, name, docker);
  const common = [
    '--network',
    'none',
    '--read-only',
    '--user',
    '10001:10001',
    '--memory',
    `${plan.memoryMiB}m`,
    '--memory-swap',
    `${plan.memoryMiB}m`,
    '--cpus',
    String(plan.cpus),
    '--pids-limit',
    '256',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--env-file',
    envFile,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,mode=1777,size=128m',
    '--tmpfs',
    '/var/tmp:rw,nosuid,nodev,mode=1777,size=128m',
    '--tmpfs',
    '/workspace:rw,nosuid,nodev,mode=1777,size=16m',
  ];
  for (const [domain, target] of Object.entries(mounts))
    common.push('--mount', `type=bind,source=${path.join(plan.restored, domain)},target=${target}`);
  common.push(
    '--mount',
    `type=bind,source=${path.join(plan.restored, 'appData')},target=/home/rivet/.local/share/com.valerypopoff.rivet2`,
    '--mount',
    `type=bind,source=${control},target=/data/local-metadata`,
  );
  const tool = (script, argv = [], withoutKey = false) =>
    tracker.runTool([
      ...common,
      ...(withoutKey ? ['--env', 'RIVET_LOCAL_METADATA_ENCRYPTION_KEY='] : []),
      '--entrypoint',
      'node',
      image.Id,
      moduleRoot + 'scripts/' + script,
      ...argv,
    ]);
  const evaluate = (code) => runDocker(['exec', name, 'node', '--input-type=module', '-e', code]);
  const request = async (route, data) => {
    const result = await evaluate(restoredOperatorRequestScript(route, data));
    return JSON.parse(result.stdout.trim());
  };
  const phases = [];
  let passed = false,
    frozenSourceFingerprint,
    peakMemoryBytes = 0,
    failureStep = 'provision-control';
  const assertSourceSnapshot = async () =>
    assertRestoredSourceFingerprint((await request('/fingerprint')).sourceFingerprint, frozenSourceFingerprint);
  const evidence = (phase) => {
    phases.push({ phase, checkedAt: new Date().toISOString() });
    console.log(`[restored-rehearsal] ${phase}`);
  };
  const sample = async () => {
    const stats = JSON.parse((await runDocker(['stats', '--no-stream', '--format', '{{json .}}', name])).stdout);
    const used = stats.MemUsage.split('/')[0].trim();
    const match = /([\d.]+)([KMGT]?i?B)/.exec(used);
    if (match)
      peakMemoryBytes = Math.max(
        peakMemoryBytes,
        Number(match[1]) *
          ({ B: 1, kB: 1000, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1048576, GiB: 1073741824 }[match[2]] ?? 1),
      );
  };
  const ready = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await runDocker(['exec', name, 'node', '-e', restoredReadinessProbeScript()], true);
      if (!result.failed) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Combined clone backend did not become ready.');
  };
  const restart = async () => {
    await runDocker(['restart', '--time', '150', name]);
    await ready();
    await assertSourceSnapshot();
  };
  const action = async (action) => {
    const status = await request('');
    await request('/action', { action, revision: status.transition.revision });
  };
  const copy = async (cycle) => {
    failureStep = `${cycle}-pause`;
    await request('/pause', {});
    let status;
    for (let attempt = 0; attempt < 120; attempt++) {
      status = await request('');
      if (status.drain?.ready) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(status.drain?.ready, true);
    const { sourceFingerprint } = await request('/fingerprint');
    assertRestoredSourceFingerprint(sourceFingerprint, frozenSourceFingerprint);
    failureStep = `${cycle}-transfer`;
    await request('/copy', {
      revision: status.transition.revision,
      backupReference: `restored-backup:${plan.receipt}`,
      backupSourceFingerprint: sourceFingerprint,
      backupRestored: true,
      encryptionKeyBackedUp: true,
    });
    const deadline = Date.now() + 60 * 60_000;
    while (Date.now() < deadline) {
      status = await request('');
      await sample();
      if (status.job?.phase === 'verified') break;
      assert.ok(status.job?.phase !== 'failed', 'Clone conversion failed; retained report has a redacted domain/code.');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(status.job?.phase, 'verified', 'Clone conversion timed out.');
    failureStep = `${cycle}-activation`;
    await action('activate');
    failureStep = `${cycle}-restart`;
    await restart();
    failureStep = `${cycle}-validation`;
    await action('validate');
  };
  try {
    await tool('local-metadata-control.js', ['--provision']);
    failureStep = 'enter-maintenance';
    // Fence the clone BEFORE boot: retention/startup background work must not
    // quietly trim the restored dataset before it is compared or converted.
    await tracker.runTool([
      ...common,
      '--entrypoint',
      'node',
      image.Id,
      '--input-type=module',
      '-e',
      `const {enterVmMigrationMaintenance}=await import('${moduleRoot}vm-migration-maintenance.js');await enterVmMigrationMaintenance();`,
    ]);
    failureStep = 'fingerprint-source';
    frozenSourceFingerprint = JSON.parse(
      (await tool('local-metadata-control.js', ['--fingerprint'])).stdout.trim(),
    ).sourceFingerprint;
    failureStep = 'initial-startup';
    await tracker.start([...common, '--entrypoint', 'node', image.Id, '/opt/rivet/backend-supervisor.mjs']);
    await ready();
    await assertSourceSnapshot();
    const inspect = JSON.parse((await runDocker(['inspect', name])).stdout)[0];
    assert.equal(inspect.HostConfig.NetworkMode, 'none');
    assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
    evidence('isolated-startup');
    await copy('initial');
    evidence('conversion-restart-validation');
    failureStep = 'return-to-legacy';
    await action('return-to-legacy');
    failureStep = 'legacy-restart';
    await restart();
    failureStep = 'legacy-validation';
    await action('validate');
    evidence('online-return-to-legacy');
    failureStep = 'legacy-refence';
    await resumeRestoredLegacyFenced({ action, request, restart });
    await copy('second');
    const selected = await request('');
    failureStep = 'corrupt-startup';
    await runDocker(['stop', '--time', '150', name]);
    const damaged = path.join(control, 'generations', selected.transition.generationId, 'settings.sqlite');
    const handle = await fs.open(damaged, 'r+');
    try {
      await handle.write(Buffer.alloc(16), 0, 16, 0);
      await syncDescriptor(handle.fd);
    } finally {
      await handle.close();
    }
    await runDocker(['start', name]);
    // Corruption must fail startup, not silently fall back to legacy.
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = JSON.parse((await runDocker(['inspect', name])).stdout)[0].State;
      if (!state.Running) {
        assert.notEqual(state.ExitCode, 0);
        break;
      }
      if (attempt === 29) throw new Error('Corrupt selected clone failed to stop.');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    failureStep = 'offline-recovery';
    await tool(
      'recover-local-metadata.js',
      [String(selected.transition.revision), selected.transition.generationId],
      true,
    );
    failureStep = 'recovered-startup';
    await runDocker(['start', name]);
    await ready();
    await assertSourceSnapshot();
    failureStep = 'recovered-validation';
    await action('validate');
    evidence('corrupt-startup-key-free-offline-recovery');
    failureStep = 'legacy-resumption';
    await resumeRestoredLegacyFenced({ action, request, restart });
    const final = await request('');
    assert.equal(final.runningBackend, 'legacy');
    assert.equal(final.transition.backend, 'legacy');
    assert.ok(final.maintenance && final.drain?.ready);
    evidence('legacy-resumption-commit-restart-source-fenced');
    signal?.throwIfAborted();
    passed = true;
  } finally {
    // No volume removal or clone deletion. Failed runs retain owned containers
    // privately. Never touch a container if its ownership label does not match.
    const cleanup = await tracker.cleanup(passed);
    if (cleanup.failed || signal?.aborted) passed = false;
    const result = {
      passed,
      cleanupFailed: cleanup.failed,
      container: tracker.backendAttempted ? name : null,
      retainedContainers: cleanup.retained,
      imageId: image.Id,
      backupReceipt: plan.receipt,
      frozenSourceFingerprint: frozenSourceFingerprint ?? null,
      finalSourceWritesPaused: passed,
      memoryLimitMiB: plan.memoryMiB,
      cpus: plan.cpus,
      sampledPeakMemoryBytes: peakMemoryBytes,
      phases,
      ...(passed ? {} : { failureStep }),
      scope:
        'Read-only equivalence, restart and pre-write recovery; clone source stays fenced. No production workflow executions or live cutover.',
      requiresSeparateControlledFunctionalRehearsal: true,
    };
    if (passed)
      assertRestoredRehearsalResult(result, {
        imageId: image.Id,
        backupReceipt: plan.receipt,
        memoryMiB: plan.memoryMiB,
        cpus: plan.cpus,
      });
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    const report = await fs.open(path.join(output, 'result.json'), 'r');
    try {
      await syncDescriptor(report.fd);
    } finally {
      await report.close();
    }
    if (cleanup.failed) throw new Error('Rehearsal cleanup failed; inspect the retained isolated container.');
    signal?.throwIfAborted();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  withRestoredRehearsalInterruptions(main).catch(() => {
    console.error(
      'Restored-copy rehearsal refused or failed. Production was not touched. Keep the isolated clone/control/report; do not activate SQLite on production.',
    );
    process.exitCode = 1;
  });
