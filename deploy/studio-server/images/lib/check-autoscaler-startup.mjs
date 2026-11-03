import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Starts the same packaged command as Helm. No cluster, credentials or network
// access is needed: missing service-account files are caught by its normal loop.
export async function checkAutoscalerStartup(entrypoint, { timeoutMs = 10000, env = process.env } = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      ...env,
      KUBERNETES_SERVICE_HOST: '127.0.0.1',
      KUBERNETES_SERVICE_PORT_HTTPS: '1',
      RIVET_AUTOSCALER_CONFIG: JSON.stringify({
        release: 'startup',
        namespace: 'startup',
        manifestDigest: `sha256:${'a'.repeat(64)}`,
        workload: 'startup-execution',
        service: 'startup-execution',
        image: 'startup',
        policy: {},
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    closed = false,
    spawnError;
  child.stdout.on('data', (part) => {
    output = (output + part).slice(-8192);
  });
  child.stderr.on('data', (part) => {
    output = (output + part).slice(-8192);
  });
  const closure = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
  try {
    const end = Date.now() + timeoutMs;
    let healthy = false;
    while (!closed && Date.now() < end) {
      try {
        const response = await fetch('http://127.0.0.1:9090', { signal: AbortSignal.timeout(500) });
        healthy = response.ok && (await response.text()) === 'autoscaler\n';
        if (healthy && output.includes('"component":"execution-autoscaler","state":"listening"')) break;
      } catch {}
      await sleep(50);
    }
    assert.ok(
      healthy && !closed && output.includes('"component":"execution-autoscaler","state":"listening"'),
      `Packaged autoscaler failed startup: ${spawnError?.message ?? output}`,
    );
    child.kill('SIGTERM');
    const result = await closure;
    if (process.platform === 'win32')
      assert.equal(result.signal, 'SIGTERM'); // Windows cannot deliver a catchable SIGTERM.
    else assert.equal(result.code, 0, `Packaged autoscaler did not shut down cleanly: ${output}`);
  } finally {
    if (!closed) child.kill('SIGKILL');
    await closure;
    clearTimeout(watchdog);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkAutoscalerStartup(
    process.argv[2] ?? '/app/packages/studio-server-api/autoscaler/execution-autoscaler-entry.mjs',
  );
  console.log('Packaged autoscaler startup and shutdown passed');
}
