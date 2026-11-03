import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { TemporaryStagingStore } from './lib/temporary-staging-store.mjs';
import { temporaryGcp } from './lib/temporary-staging-gcp.mjs';
import {
  temporaryStagingPlan,
  temporaryHash,
  verifyTemporaryPlan,
  temporaryAdmission,
  temporaryExpiry,
} from './lib/temporary-staging-contract.mjs';
import {
  provisionTemporaryEnvironment,
  cleanupTemporaryEnvironment,
  runTemporaryQualification,
  inspectTemporaryEnvironment,
} from './lib/temporary-staging-lifecycle.mjs';
import {
  linuxProcessIdentity,
  assertTemporaryWatchdog,
  writeWatchdogHealth,
  requestTemporaryStop,
  releaseTemporaryAdmission,
} from './lib/temporary-staging-watchdog.mjs';

const exec = promisify(execFile),
  root = fileURLToPath(new URL('../../../', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (file) => fs.readFile(file, 'utf8').then(JSON.parse);
const entry = fileURLToPath(import.meta.url);
export async function temporaryCodeHashes(source = root) {
  const files = {};
  const walk = async (folder) => {
    for (const name of (await fs.readdir(path.join(source, folder))).sort()) {
      const relative = path.posix.join(folder, name),
        stat = await fs.lstat(path.join(source, relative));
      assert.ok(!stat.isSymbolicLink());
      if (stat.isDirectory()) await walk(relative);
      else if (name.endsWith('.mjs')) files[relative] = temporaryHash(await fs.readFile(path.join(source, relative)));
    }
  };
  await walk('deploy/studio-server/scripts');
  const lock = 'deploy/studio-server/images/api/maintenance-lock.mjs';
  files[lock] = temporaryHash(await fs.readFile(path.join(source, lock)));
  return files;
}
export async function verifyTemporarySource(plan) {
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), plan.sourceSha);
  assert.equal(
    (await exec('git', ['status', '--porcelain'], { cwd: root, maxBuffer: 1024 * 1024 })).stdout.trim(),
    '',
    'Published exact clean checkout required before infrastructure writes',
  );
  assert.deepEqual(await temporaryCodeHashes(), plan.codeHashes, 'Reviewed infrastructure/cleanup code changed');
}
const outside = (directory) => {
  assert.ok(path.isAbsolute(directory));
  const relative = path.relative(root, directory);
  assert.ok(
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    'Private durable state must live outside the checkout',
  );
};

/** Keep bounded diagnostics private for both direct and workflow callers. */
export async function retainTemporaryFailure(directory, mode, error) {
  try {
    outside(directory);
    const stat = await fs.lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    outside(await fs.realpath(directory));
    const causes = [],
      seen = new Set([error]);
    for (let cause = error?.cause; cause && causes.length < 4 && !seen.has(cause); cause = cause.cause) {
      seen.add(cause);
      causes.push({
        name: String(cause.name ?? 'Error').slice(0, 128),
        message: String(cause.message ?? 'Unknown failure').slice(0, 8192),
      });
    }
    await fs.writeFile(
      path.join(directory, `terminal-error-${randomUUID()}.json`),
      JSON.stringify({
        at: new Date().toISOString(),
        mode: String(mode).slice(0, 64),
        name: String(error?.name ?? 'Error').slice(0, 128),
        message: String(error?.message ?? 'Unknown failure').slice(0, 8192),
        ...(causes.length ? { causes } : {}),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch {
    // Diagnostic failure cannot change cleanup authority or hide the exit.
  }
}

export async function runTemporaryCommand(mode, directory, { inputs, refreshInstalled, env = process.env } = {}) {
  outside(directory);
  const store = new TemporaryStagingStore(directory);
  if (mode === 'initialize') {
    assert.equal(process.platform, 'linux');
    const plan = verifyTemporaryPlan(await json(env.RIVET_TEMPORARY_STAGING_PLAN));
    inputs ??= await json(env.RIVET_TEMPORARY_STAGING_INPUTS);
    await verifyTemporarySource(plan);
    await store.initialize(plan);
    await fs.writeFile(path.join(directory, 'inputs.json'), JSON.stringify(inputs), { flag: 'wx', mode: 0o600 });
    await store.locked(() =>
      store.change((r) => {
        r.inputsHash = temporaryHash(inputs);
      }),
    );
    return;
  }
  const { record } = await store.read(),
    plan = verifyTemporaryPlan(record.plan);
  assert.equal(path.basename(directory), plan.operationId);
  if (mode === 'status')
    return {
      operationId: plan.operationId,
      phase: record.phase,
      expiresAt: record.expiresAt,
      complete: record.complete,
      testsPassed: record.testsPassed === true,
      evidenceExported: record.evidenceExported === true,
      cleanupVerified: record.cleanupVerified === true,
      evidenceFailure: record.evidenceFailure ?? null,
      hostname: record.hostname?.name ?? null,
      certificateWorker: record.certificateWorker
        ? {
            name: record.certificateWorker.name,
            id: record.certificateWorker.identity?.id ?? null,
            stopIssued: record.certificateWorker.stopIssued === true,
            removed: record.certificateWorker.removed === true,
          }
        : null,
      resources: record.resources.map((r) => ({ key: r.key, id: r.identity?.id ?? null, absent: !!r.absent })),
      residualResources: record.residualResources ?? [],
    };
  await verifyTemporarySource(plan);
  const signal = new AbortController(),
    stop = () => signal.abort(Error('Temporary environment admission stopped'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const cloud = temporaryGcp(plan);
  const { temporaryStagingRuntime } = await import('./lib/temporary-staging-runtime.mjs');
  inputs ??= await json(path.join(directory, 'inputs.json'));
  assert.equal(temporaryHash(inputs), record.inputsHash, 'Frozen qualification inputs changed');
  const runtime = temporaryStagingRuntime({
    root,
    diagnosticDirectory: directory,
    inputs,
    refreshInstalled,
    certificateFile: env.RIVET_TEMPORARY_STAGING_CERTIFICATE,
    keyFile: env.RIVET_TEMPORARY_STAGING_KEY,
    estimateFile: env.RIVET_TEMPORARY_STAGING_ESTIMATE,
    registryFile: env.RIVET_TEMPORARY_STAGING_REGISTRY,
    signal: signal.signal,
  });
  const wait = async (label, check) => {
    const end = Date.now() + 30 * 60 * 1000;
    while (true) {
      const value = await check();
      if (value) return value;
      assert.ok(Date.now() < end, `Temporary staging wait exceeded: ${label}`);
      await sleep(1000);
    }
  };
  try {
    if (mode === 'arm') {
      assert.ok(!env.KUBERNETES_SERVICE_HOST, 'The outer watchdog cannot live in GKE');
      for (const marker of ['/.dockerenv', '/run/.containerenv'])
        assert.equal(
          await fs.stat(marker).then(
            () => true,
            (e) => {
              if (e.code === 'ENOENT') return false;
              throw e;
            },
          ),
          false,
          'Use a durable native self-hosted control host, not a disposable job container',
        );
      await store.locked(async () => {
        assert.equal(record.phase, 'planned');
        assert.ok(!record.watchdog);
        const nonce = randomUUID();
        const log = await fs.open(path.join(directory, 'watchdog.log'), 'ax', 0o600);
        const watchEnv = Object.fromEntries(
          Object.entries(env).filter(([key]) =>
            [
              'PATH',
              'HOME',
              'LANG',
              'LC_ALL',
              'NODE_OPTIONS',
              'CLOUDSDK_CONFIG',
              'RIVET_GCLOUD_BIN',
              'RIVET_TEMPORARY_STAGING_CERTIFICATE',
              'RIVET_TEMPORARY_STAGING_KEY',
            ].includes(key),
          ),
        );
        const child = spawn(process.execPath, [entry, 'watch', directory, nonce], {
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          env: watchEnv,
        });
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        await log.close();
        child.unref();
        // Spawn acknowledgement is not watchdog health. Pin its precise live
        // process and wait for a separately written matching heartbeat.
        let identity;
        for (let i = 0; i < 50 && !identity; i++) {
          identity = await linuxProcessIdentity(child.pid);
          if (!identity) await sleep(100);
        }
        assert.ok(identity);
        await store.change((r) => {
          r.watchdog = { identity, nonce };
        });
      });
      await wait('external watchdog health', async () => {
        signal.signal.throwIfAborted();
        try {
          await assertTemporaryWatchdog(store);
          return true;
        } catch {
          return false;
        }
      });
      return;
    }
    if (mode === 'watch') {
      assert.ok(!env.KUBERNETES_SERVICE_HOST, 'The foundation watchdog must run outside the deletable cluster');
      const nonce = process.argv[4],
        identity = await linuxProcessIdentity(process.pid);
      for (let i = 0; i < 50; i++) {
        const value = (await store.read()).record;
        if (value.watchdog) {
          assert.deepEqual(value.watchdog, { identity, nonce });
          break;
        }
        await sleep(100);
      }
      assert.equal((await store.read()).record.watchdog?.nonce, nonce);
      let lastAlert = '';
      while (!signal.signal.aborted) {
        await writeWatchdogHealth(directory, identity, nonce, plan.inputHash);
        const current = (await store.read()).record;
        if (current.complete || Date.now() >= temporaryExpiry(current)) {
          try {
            if (!current.complete) await requestTemporaryStop(store);
            await store.locked(async () => {
              // The operator may have finished while the watchdog waited for
              // shutdown/ownership. Never settle an already verified operation.
              if (!(await store.read()).record.complete) {
                await verifyTemporarySource(plan);
                await cleanupTemporaryEnvironment(store, cloud, runtime, { wait });
              }
              await releaseTemporaryAdmission(store);
            });
            return;
          } catch (error) {
            if (current.complete && error.code === 'RIVET_TEMPORARY_WRITER_BUSY') {
              await sleep(5000);
              continue;
            }
            const value = (await store.read()).record;
            const alert = {
              status: 'cleanup-blocked',
              operationId: plan.operationId,
              resources: value.resources
                .filter((r) => !r.absent && !r.rejected)
                .map((r) => ({ key: r.key, id: r.identity?.id ?? null, billable: !!r.billable })),
              residualResources: value.residualResources ?? [],
              blockedInventory: value.blockedInventory ?? [],
              writer: value.writer ?? null,
              requiredAction:
                'Inspect the frozen private journal and exact live identities. Do not force deletion or replay uncertain writes.',
            };
            const hash = temporaryHash(alert);
            if (hash !== lastAlert) {
              await fs.writeFile(
                path.join(directory, `watchdog-alert-${randomUUID()}.json`),
                JSON.stringify({ ...alert, observedAt: new Date().toISOString() }),
                { flag: 'wx', mode: 0o600 },
              );
              console.error(JSON.stringify(alert));
              lastAlert = hash;
            }
            await sleep(25000);
          }
        }
        await sleep(5000);
      }
      return;
    }
    assert.ok(['run', 'inspect', 'cleanup'].includes(mode));
    return await store.locked(async () => {
      if (mode === 'inspect') return inspectTemporaryEnvironment(store, cloud);
      if (mode === 'cleanup' && (await store.read()).record.complete) {
        const receipt = await cleanupTemporaryEnvironment(store, cloud, runtime, { wait });
        await releaseTemporaryAdmission(store);
        return receipt;
      }
      const parent = path.dirname(directory),
        active = path.join(parent, `active-${plan.projectId}.json`);
      const lease = { operationId: plan.operationId, inputHash: plan.inputHash, directory };
      const existing = await json(active).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (existing) assert.deepEqual(existing, lease, 'Another environment operation must finish cleanup first');
      else await fs.writeFile(active, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
      await store.change(async (r) => {
        r.writer = await linuxProcessIdentity(process.pid);
      });
      try {
        if (mode === 'cleanup') return await cleanupTemporaryEnvironment(store, cloud, runtime, { wait });
        assert.equal((await store.read()).record.phase, 'planned', 'Provisioning/qualification cannot be replayed');
        const guard = async () => {
          assert.ok(!signal.signal.aborted);
          await assertTemporaryWatchdog(store);
          temporaryAdmission((await store.read()).record);
        };
        await guard();
        try {
          await provisionTemporaryEnvironment(store, cloud, runtime, { wait, guard });
        } catch (e) {
          try {
            await cleanupTemporaryEnvironment(store, cloud, runtime, { wait });
          } catch {}
          throw e;
        }
        return await runTemporaryQualification(store, cloud, runtime, { wait, guard });
      } finally {
        const terminal = (await store.read()).record;
        if (terminal.complete && terminal.cleanupVerified) await releaseTemporaryAdmission(store);
      }
    });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

/** Called only after ordinary exact-main build/artifact validation. A private
 * administrator template is not a dispatch-supplied command or credential. */
export async function executeTemporaryQualification({ packet, inputs, refreshInstalled, env = process.env }) {
  assert.equal(env.RIVET_AUTOMATED_QUALIFICATION_ENABLED, 'true');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.ok(!env.KUBERNETES_SERVICE_HOST, 'The outer coordinator must run outside the staging cluster');
  const operationId = `rivet-q-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const template = await json(env.RIVET_TEMPORARY_STAGING_TEMPLATE);
  const { getStudioServerReleaseManifestDigest } = await import('./lib/studio-server-release-manifest.mjs');
  const plan = temporaryStagingPlan({
    ...template,
    protocol: 1,
    operationId,
    sourceSha: inputs.candidate.source.sha,
    candidateDigest: getStudioServerReleaseManifestDigest(inputs.candidate),
    predecessorDigest: getStudioServerReleaseManifestDigest(inputs.previous, { requirePromoted: true }),
    codeHashes: await temporaryCodeHashes(),
  });
  assert.equal(plan.projectId, env.RIVET_QUALIFICATION_PROJECT_ID);
  assert.equal(plan.projectNumber, env.RIVET_QUALIFICATION_PROJECT_NUMBER);
  assert.equal(
    plan.allowance.maxUsd,
    Number(env.RIVET_QUALIFICATION_MAX_USD),
    'Template differs from protected spending approval',
  );
  assert.equal(
    plan.allowance.maxSeconds,
    Number(env.RIVET_QUALIFICATION_MAX_SECONDS),
    'Template cannot extend the protected allowance',
  );
  const base = env.RIVET_QUALIFICATION_PRIVATE_STORE;
  outside(base);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const directory = path.join(base, operationId),
    planFile = path.join(packet, 'private-temporary-plan.json');
  await fs.writeFile(planFile, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
  env = { ...env, RIVET_TEMPORARY_STAGING_PLAN: planFile };
  let result;
  try {
    await runTemporaryCommand('initialize', directory, { inputs, env });
    await runTemporaryCommand('arm', directory, { env });
    result = await runTemporaryCommand('run', directory, { inputs, refreshInstalled, env });
  } catch (error) {
    await retainTemporaryFailure(directory, 'execute', error);
    throw error;
  }
  assert.equal(result.status, 'qualified');
  assert.equal(result.environmentCleanup.cleanupVerified, true);
  const { record } = await new TemporaryStagingStore(directory).read();
  await fs.writeFile(path.join(packet, 'qualification-result.json'), JSON.stringify(result), {
    flag: 'wx',
    mode: 0o600,
  });
  const operation = record.operation;
  await fs.writeFile(
    path.join(packet, 'operation-public.json'),
    JSON.stringify({
      protocol: 1,
      operationId,
      inputHash: operation.inputHash,
      predecessorManifestDigest: operation.predecessorManifestDigest,
      installed: operation.installed,
      driverBundleSha256: record.driverDigest,
      candidate: {
        sourceSha: inputs.candidate.source.sha,
        images: inputs.candidate.images,
        chartDigest: inputs.candidate.chart.contentDigest,
      },
    }),
    { flag: 'wx', mode: 0o600 },
  );
  for (const key of ['control', 'autoscaling'])
    await fs.appendFile(env.GITHUB_OUTPUT, `${key}=${JSON.stringify(result[key])}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  runTemporaryCommand(process.argv[2], process.argv[3])
    .then((result) => {
      if (result) console.log(JSON.stringify(result));
    })
    .catch(async (error) => {
      // Keep operational failure reasons in private state, not Actions output.
      // Do not serialize arbitrary error properties (HTTP bodies or credentials).
      await retainTemporaryFailure(process.argv[3], process.argv[2], error);
      if (process.argv[2] === 'watch')
        await fs
          .writeFile(
            path.join(process.argv[3], 'watchdog-failure.json'),
            JSON.stringify({
              at: new Date().toISOString(),
              status: 'blocked-inspect-exact-private-inventory',
              requiredAction:
                'Restore the frozen checkout/credentials and inspect the recorded resources; never replay an uncertain write.',
            }),
            { flag: 'wx', mode: 0o600 },
          )
          .catch(() => {});
      console.error('[temporary-staging] Stopped. Inspect the exact private journal; no uncertain write was replayed.');
      process.exitCode = 1;
    });
}
