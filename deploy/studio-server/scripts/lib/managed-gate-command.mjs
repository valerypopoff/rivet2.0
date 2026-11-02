import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../../../../', import.meta.url));
const scope = new AsyncLocalStorage();
const active = new Set();

// Cancellation applies only to the test phase. Settlement and cleanup run in a
// fresh scope and must remain usable after a failed or interrupted observation.
export const withManagedGateSignal = (signal, action) => scope.run(signal, action);
export async function waitForManagedGateCommands() {
  await Promise.all([...active]);
}

export async function runManagedGateCommand(program, args, options = {}) {
  const {
    cwd = rootDir,
    input,
    capture = process.env.RIVET_QUALIFICATION_RECEIPT_STDOUT === '1',
    allowFailure = false,
    env = process.env,
    signal: commandSignal,
    killAfterMs = 5000,
  } = options;
  const phaseSignal = scope.getStore();
  const signal =
    phaseSignal && commandSignal ? AbortSignal.any([phaseSignal, commandSignal]) : phaseSignal ?? commandSignal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env,
      stdio: capture ? ['pipe', 'pipe', 'pipe'] : input == null ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    });
    let stdout = '',
      stderr = '',
      childError,
      timer;
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdin?.on('error', () => {}); // EPIPE is explained by the child's closure.
    child.stdin?.end(input); // Captured commands always receive input or EOF.
    let closed;
    const closure = new Promise((done) => {
      closed = done;
    });
    active.add(closure);
    const abort = () => {
      child.kill('SIGTERM');
      // Only this owned client process is killed; never shorten Pod draining.
      timer ??= setTimeout(() => child.kill('SIGKILL'), killAfterMs);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => {
      childError = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active.delete(closure);
      closed(); // A kill request is not proof of closure.
      if (signal?.aborted) return reject(signal.reason);
      if (childError) return reject(childError);
      const exitCode = code ?? 1;
      if (exitCode === 0 || allowFailure) return resolve({ exitCode, stdout, stderr });
      reject(
        new Error(
          `Command failed with exit code ${exitCode}: ${[program, ...args].join(' ')}${stderr ? `\n${stderr}` : ''}`,
        ),
      );
    });
  });
}
