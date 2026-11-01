import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { qualificationHash } from './runtime-qualification-execution.mjs';

export function qualificationDriverEnvironment(env) {
  const staging = Object.entries(env).find(
    ([key]) => key.toUpperCase() === 'RIVET_QUALIFICATION_STAGING_KUBECONFIG',
  )?.[1];
  assert.ok(typeof staging === 'string' && staging.length > 0, 'An explicit staging credential context is required');
  const result = Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const key = name.toUpperCase();
      return (
        !key.startsWith('RIVET_QUALIFICATION_PRODUCTION_') &&
        !key.startsWith('RIVET_PRODUCTION_') &&
        !key.startsWith('GITHUB_') &&
        !key.startsWith('ACTIONS_') &&
        !['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'KUBECONFIG'].includes(key)
      );
    }),
  );
  result.KUBECONFIG = staging;
  return result;
}

/** Provider provisioning/expiry cleanup are privileged infrastructure adapters.
 * Only an administrator-installed, completely hash-pinned bundle can execute;
 * dispatch inputs cannot select commands, scripts, projects or credentials. */
export async function verifyQualificationDriver(directory, expectedDigest) {
  assert.ok(path.isAbsolute(directory));
  assert.match(expectedDigest, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'driver.json'), 'utf8'));
  assert.equal(qualificationHash(manifest), expectedDigest, 'Provider driver manifest changed');
  assert.equal(manifest.protocol, 1);
  assert.ok(['compact-seven-v1', 'compact-seven-overlap-v1'].includes(manifest.suite));
  assert.equal(manifest.scope, 'isolated-provider');
  assert.equal(manifest.provider, 'gke');
  assert.match(manifest.entrypoint, /^[a-zA-Z0-9_./-]+\.mjs$/);
  assert.ok(Object.hasOwn(manifest.files, manifest.entrypoint));
  const actual = [];
  const walk = async (folder = '') => {
    for (const name of await fs.readdir(path.join(directory, folder))) {
      const relative = path.posix.join(folder, name);
      const item = await fs.lstat(path.join(directory, relative));
      assert.ok(!item.isSymbolicLink(), 'Provider bundles cannot contain symlinks');
      if (item.isDirectory()) await walk(relative);
      else {
        assert.ok(item.isFile());
        if (relative !== 'driver.json') actual.push(relative);
      }
    }
  };
  assert.ok(!(await fs.lstat(directory)).isSymbolicLink());
  await walk();
  assert.deepEqual(
    actual.sort(),
    Object.keys(manifest.files).sort(),
    'Provider bundle has unrecorded or missing files',
  );
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.ok(file && !path.isAbsolute(file) && !file.includes('\\') && !file.split('/').includes('..'));
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(
      createHash('sha256')
        .update(await fs.readFile(path.join(directory, file)))
        .digest('hex'),
      hash,
    );
  }
  return path.join(directory, manifest.entrypoint);
}

export function providerPhaseProcess(
  entrypoint,
  phase,
  request,
  { cwd, env = process.env, timeoutMs = 1_800_000, privateDirectory } = {},
) {
  assert.ok(['armExpiry', 'prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup', 'verifyCleanup'].includes(phase));
  return new Promise((resolve, reject) => {
    // The private driver owns durable inventory before any provider mutation.
    // On timeout, do not kill an unknown cloud writer or replay its command.
    // The independent expiry guard must settle it before deletion.
    const child = spawn(process.execPath, [entrypoint, phase], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      stderr = '',
      overflow = false,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdin.destroy();
      // Notify, then await actual shutdown. Never start cleanup concurrently.
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 4 * 1024 * 1024) overflow = true;
      else if (!overflow) output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += String(chunk).slice(0, 1024 * 1024 - stderr.length);
    });
    child.stdin.on('error', () => {});
    let processError;
    // A kill/transport error is not proof of process exit. Do not let an early
    // rejection start settlement concurrently with a still-running writer.
    child.on('error', (error) => {
      processError = error;
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (privateDirectory) {
        try {
          await fs.writeFile(path.join(privateDirectory, `${phase}-stderr.log`), stderr, { flag: 'wx', mode: 0o600 });
        } catch {
          return reject(new Error('Could not retain private provider diagnostics'));
        }
      }
      if (processError) return reject(new Error('Provider phase process failed', { cause: processError }));
      if (timedOut || overflow || code !== 0)
        return reject(
          new Error(
            `Provider phase ${phase} did not acknowledge success; inspect its private inventory. Never replay it.`,
          ),
        );
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('Provider phase returned an invalid private receipt'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** One cleanup allowance spans settlement, deletion, verification and export.
 * An expired wait never proves writer absence or authorizes a phase replay. */
export function qualificationTimeouts({ timeoutMs, now = Date.now } = {}) {
  let cleanupDeadline;
  return (operation, phase) => {
    const testing = ['armExpiry', 'prepare', 'upgrade', 'autoscaling'].includes(phase);
    const current = now();
    const deadline = testing ? Date.parse(operation.expiresAt) : (cleanupDeadline ??= current + 3_600_000);
    const remaining = deadline - current;
    assert.ok(remaining > 0, testing ? 'Provider admission expired' : 'Qualification cleanup deadline exceeded');
    return Math.min(timeoutMs ?? remaining, remaining);
  };
}

export function qualificationDriver(directory, digest, { cwd, privateDirectory, timeoutMs, env } = {}) {
  const childEnv = qualificationDriverEnvironment(env ?? process.env);
  const timeoutFor = qualificationTimeouts({ timeoutMs: timeoutMs ?? 7_200_000 });
  return Object.fromEntries(
    ['armExpiry', 'prepare', 'upgrade', 'autoscaling', 'settle', 'cleanup', 'verifyCleanup'].map((phase) => [
      phase,
      async (operation) => {
        const entrypoint = await verifyQualificationDriver(directory, digest);
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'driver.json'), 'utf8'));
        assert.equal(
          manifest.suite,
          operation.developerOverlapProfile ? 'compact-seven-overlap-v1' : 'compact-seven-v1',
        );
        const result = await providerPhaseProcess(
          entrypoint,
          phase,
          { operation, privateDirectory },
          {
            cwd,
            timeoutMs: timeoutFor(operation, phase),
            env: childEnv,
            privateDirectory,
          },
        );
        await fs.writeFile(path.join(privateDirectory, `${phase}-receipt.json`), JSON.stringify(result), {
          flag: 'wx',
          mode: 0o600,
        });
        return result;
      },
    ]),
  );
}
