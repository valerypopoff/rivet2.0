import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { serveRecordingTransitionGuard } from '../../../deploy/studio-server/scripts/lib/recording-transition-guard.mjs';
import { readRecordingRestoreIdentity } from './recording-recompression.js';
import {
  readRecordingStorageConfig,
  recordingStorageRequiredEncodings,
  withRecordingOperatorLease,
} from './recording-storage-operator.js';

/** Only the journaled release CLI can safely recover a lost wrapper owner. */
export function resolveGuardedReleaseCommand(program: string, args: string[]) {
  const entry = fileURLToPath(
    new URL('../../../deploy/studio-server/scripts/deploy-kubernetes-release.mjs', import.meta.url),
  );
  const requested = args[0] && path.resolve(args[0]);
  const samePath =
    process.platform === 'win32' ? requested?.toLowerCase() === entry.toLowerCase() : requested === entry;
  if (!['node', 'node.exe'].includes(path.basename(program).toLowerCase()) || !samePath)
    throw new Error(
      "The recording transition wrapper only supports Node running this checkout's deploy-kubernetes-release.mjs.",
    );
  return { program: process.execPath, args: [entry, ...args.slice(1)] };
}

/** Keep coordination until physical close, including a cooperative zero exit
 * after interruption and process errors which precede the close event. */
export function waitForGuardedStorageCommand(
  child: ChildProcess,
  signal: AbortSignal,
  check: () => Promise<void>,
  interrupts: Pick<EventEmitter, 'on' | 'removeListener'> = process,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let interrupted = false;
    let failure: Error | undefined;
    const abort = () => {
      interrupted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // A failed kill is not evidence that the command stopped. Wait for close.
      }
    };
    const timer = setInterval(() => {
      void check().catch(abort);
    }, 5000);
    timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    interrupts.on('SIGINT', abort);
    interrupts.on('SIGTERM', abort);
    const onError = (error: Error) => {
      failure = error;
    };
    child.on('error', onError);
    child.once('close', (code) => {
      clearInterval(timer);
      signal.removeEventListener('abort', abort);
      interrupts.removeListener('SIGINT', abort);
      interrupts.removeListener('SIGTERM', abort);
      child.removeListener('error', onError);
      if (failure) reject(failure);
      else if (code === 0 && !interrupted && !signal.aborted) resolve();
      else
        reject(
          new Error(
            'Guarded command did not complete successfully. Helper and remote work may remain unconfirmed; inspect its original result before any retry.',
          ),
        );
    });
    if (signal.aborted) abort();
  });
}

async function main() {
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log(
      'Hold recording coordination for the journaled release CLI: --context <kube-context> --namespace <namespace> --release <release> -- node deploy/studio-server/scripts/deploy-kubernetes-release.mjs <arguments>. Native migrations/restores manage their own locks; arbitrary commands are not supported.',
    );
    return;
  }
  const divider = process.argv.indexOf('--');
  if (divider < 0 || !process.argv[divider + 1])
    throw new Error('Specify --context, --namespace, --release, then -- <command> <arguments>.');
  const { values } = parseArgs({
    args: process.argv.slice(2, divider),
    options: {
      context: { type: 'string' },
      namespace: { type: 'string' },
      release: { type: 'string' },
    },
  });
  const { context, namespace, release } = values;
  if (!context || !namespace || !release) throw new Error('An explicit deployment identity is required.');
  const invocation = resolveGuardedReleaseCommand(process.argv[divider + 1]!, process.argv.slice(divider + 2));
  const config = await readRecordingStorageConfig();
  await withRecordingOperatorLease(config, 'transition', async (pool, signal, check, client) => {
    if (JSON.parse(await readRecordingRestoreIdentity(client)).deployment !== `${namespace}/${release}`)
      throw new Error('The configured database belongs to another deployment.');
    const requiredEncodings = await recordingStorageRequiredEncodings(pool);
    const guard = await serveRecordingTransitionGuard(check, {
      protocol: 1,
      context,
      namespace,
      release,
      requiredEncodings,
    });
    try {
      signal.throwIfAborted();
      const child = spawn(invocation.program, invocation.args, {
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
        env: { ...process.env, RIVET_RECORDING_TRANSITION_GUARD: guard.url },
      });
      await waitForGuardedStorageCommand(child, signal, check);
    } finally {
      await guard.close();
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Guarded transition failed.');
    process.exitCode = 1;
  });
