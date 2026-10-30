import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { temporaryHash } from './temporary-staging-contract.mjs';
import { deploymentFailureDetails } from './deployment-diagnostics.mjs';

/** kubectl supports control planes within one minor of its own version. */
export function assertKubectlVersionSkew(clientVersion, serverVersion) {
  const parse = (version) => {
    assert.equal(typeof version, 'string', 'Kubernetes version must be a string');
    const match = /^v?(\d+)\.(\d+)\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
    assert.ok(match, `Invalid Kubernetes version: ${version}`);
    return match.slice(1).map(Number);
  };
  const [clientMajor, clientMinor] = parse(clientVersion);
  const [serverMajor, serverMinor] = parse(serverVersion);
  assert.ok(
    clientMajor === serverMajor && Math.abs(clientMinor - serverMinor) <= 1,
    `kubectl ${clientVersion} is outside the supported version range for Kubernetes ${serverVersion}`,
  );
}

/** Bound terminal diagnostics, not cleanup authority. A successful exec with
 * truncated/corrupt contents cannot qualify a release. */
export function verifyTemporaryActorExport(value) {
  assert.deepEqual(Object.keys(value).sort(), ['files']);
  assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 10000);
  const names = new Set();
  let total = 0;
  for (const item of value.files) {
    assert.ok(typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 4096);
    assert.ok(!item.name.startsWith('/') && !/[\\\x00]/.test(item.name));
    assert.ok(item.name.split('/').every((part) => part && part !== '.' && part !== '..'));
    assert.ok(!names.has(item.name), 'Duplicate diagnostic file');
    names.add(item.name);
    if (item.omitted !== undefined) {
      assert.deepEqual(Object.keys(item).sort(), ['name', 'omitted', 'size']);
      assert.equal(item.omitted, 'bounded-diagnostics');
      assert.ok(Number.isSafeInteger(item.size) && item.size >= 0);
    } else {
      assert.deepEqual(Object.keys(item).sort(), ['bytes', 'hash', 'name']);
      assert.ok(typeof item.bytes === 'string');
      const bytes = Buffer.from(item.bytes, 'base64');
      assert.equal(bytes.toString('base64'), item.bytes, 'Invalid diagnostic encoding');
      assert.ok(bytes.length <= 2 * 1024 * 1024 && (total += bytes.length) <= 16 * 1024 * 1024);
      assert.equal(temporaryHash(bytes), item.hash, 'Diagnostic contents changed');
    }
  }
  return value;
}

/** Offline admission only: no cloud credentials, network, host mounts or Docker
 * socket enter the actor. Wait for actual process closure, not just JSON output. */
export function verifyOfflineTemporaryActor(plan, { spawnImpl = spawn, timeoutMs = 240000, diagnosticFile } = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      'docker',
      [
        'run',
        '--rm',
        '--pull=never',
        '--network=none',
        '--interactive',
        '--init',
        '--entrypoint',
        'timeout',
        plan.actorImage,
        // This deadline runs inside the credential-free offline container.
        // It survives a lost/killed Docker client; --rm removes the container.
        '-s',
        'TERM',
        '-k',
        '10',
        String(Math.ceil(timeoutMs / 1000)),
        'node',
        `${plan.actorSourceRoot}/deploy/studio-server/scripts/qualification/temporary-actor.mjs`,
        'preflight',
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks = [];
    const diagnostics = [];
    let diagnosticBytes = 0;
    const fail = async (message, cause, code) => {
      let detail = message;
      if (diagnosticFile) {
        try {
          await fs.writeFile(
            diagnosticFile,
            JSON.stringify({
              formatVersion: 1,
              exitCode: code,
              timedOut,
              overflow,
              failure: deploymentFailureDetails(cause),
              stderr: Buffer.concat(diagnostics).toString(),
              stderrTruncated: diagnosticBytes > 65536,
            }),
            { flag: 'wx', mode: 0o600 },
          );
          detail += `; private diagnostics: ${diagnosticFile}`;
        } catch (error) {
          cause = new AggregateError(
            [cause, error].filter(Boolean),
            'Preflight failed and private diagnostics could not be retained',
          );
        }
      }
      reject(new Error(detail, { cause }));
    };
    let bytes = 0,
      overflow = false,
      timedOut = false,
      failure;
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdin.destroy();
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        if (!overflow) child.kill('SIGTERM');
        overflow = true;
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      const remaining = Math.max(0, 65536 - diagnosticBytes);
      if (remaining) diagnostics.push(chunk.subarray(0, remaining));
      diagnosticBytes += chunk.length;
    }); // Private command output is never copied to Actions.
    child.stdin.on('error', (error) => {
      failure ??= error;
    });
    child.on('error', (error) => {
      failure ??= error;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure || timedOut || overflow || code !== 0)
        return void fail(
          'Offline actor preflight did not acknowledge success after process closure',
          failure ?? new Error(`Actor exited with code ${code}`),
          code,
        );
      try {
        const result = JSON.parse(Buffer.concat(chunks));
        assert.equal(result.offlineFixturePassed, true, 'Offline actor fixture did not pass');
        assert.equal(result.sourceSha, plan.sourceSha, 'Offline actor acknowledged another source');
        resolve(result);
      } catch (error) {
        void fail('Offline actor returned an invalid receipt', error, code);
      }
    });
    child.stdin.end(
      JSON.stringify({
        sourceRoot: plan.actorSourceRoot,
        sourceSha: plan.sourceSha,
        kubernetesVersion: plan.kubernetesVersion,
      }),
    );
  });
}
