import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const emptyEventLoop = 'ERROR: Yarn is terminating due to an unexpected empty event loop.';
const installArgs = ['.yarn/releases/yarn-4.17.1.cjs', 'install', '--immutable', '--immutable-cache'];

function executeInstall(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let interrupted;
    // Preserve live logs, retaining only a bounded diagnostic tail for classification.
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-16_384);
      });
      stream.pipe(destination, { end: false });
    }
    const interrupt = () => {
      interrupted = 'SIGINT';
      child.kill('SIGINT');
    };
    const terminate = () => {
      interrupted = 'SIGTERM';
      child.kill('SIGTERM');
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      resolve({ code, signal: interrupted ?? signal, output });
    });
  });
}

/** Retry only Yarn's incomplete-execution sentinel, never dependency validation. */
export async function installDependencies({ execute = executeInstall, wait = setTimeout, log = console.warn } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await execute([...installArgs]);
    if (attempt === 2 || result.signal || result.code !== 42 || !result.output.includes(emptyEventLoop)) return result;
    log('Yarn exited before completing installation (code 42). Retrying the unchanged immutable install once.');
    await wait(1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await installDependencies();
  process.exitCode = result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : result.code ?? 1;
}
