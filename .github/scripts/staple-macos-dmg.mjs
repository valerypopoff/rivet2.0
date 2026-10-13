import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const retryDelaysMs = [5_000, 15_000];

// Exit 68 alone also covers permanent failures. Retry only an explicit Apple
// network error, not an absent/invalid ticket, signing failure or rejected submission.
export function isTransientStaplerFailure({ status, output }) {
  return status === 68 && /Error Domain=NSURLErrorDomain Code=-(?:1001|1004|1005|1009)\b/.test(output);
}

function runStapler(program, args) {
  return new Promise((done) => {
    execFile(program, args, { timeout: 120_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      done({
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        output: stdout + stderr,
        error,
      });
    });
  });
}

/** Retry ticket retrieval against the same already-notarized DMG; never resubmit or rebuild it. */
export async function stapleMacDmgWithRetries(
  dmgPath,
  {
    run = runStapler,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
    warn = console.warn,
    write = (output) => process.stdout.write(output),
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    const result = await run('xcrun', ['stapler', 'staple', dmgPath]);
    if (result.output) write(result.output);
    const delay = retryDelaysMs[attempt];
    if (!isTransientStaplerFailure(result) || delay === undefined) return result;
    warn(
      `Apple ticket retrieval hit a transient network failure; retrying the same DMG in ${delay / 1000}s (attempt ${attempt + 2}/3).`,
    );
    await wait(delay);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) throw new Error('Usage: staple-macos-dmg.mjs <already-notarized-dmg>');
  const result = await stapleMacDmgWithRetries(args[0]);
  if (result.status !== 0) {
    if (result.error && !result.output) console.error(`Unable to run stapler: ${result.error.message}`);
    process.exitCode = Number.isInteger(result.status) && result.status > 0 && result.status <= 255 ? result.status : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
