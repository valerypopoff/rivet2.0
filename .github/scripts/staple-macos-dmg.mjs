import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Apple CloudKit connection loss can outlast the initial short retries even
// after notarization is accepted. Keep a bounded recovery window for that same ticket.
const retryDelaysMs = [5_000, 15_000, 30_000, 60_000, 120_000];

// Exit 68 alone also covers permanent failures. Retry only an explicit Apple
// network error, not an absent/invalid ticket, signing failure or rejected submission.
export function isTransientStaplerFailure({ status, output }) {
  return status === 68 && /Error Domain=NSURLErrorDomain Code=-(?:1001|1004|1005|1009)\b/.test(output);
}

export function runStapler(program, args) {
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

/** Retry one stapler operation against the same artifact; never resubmit, rebuild or switch operations. */
export async function runMacDmgStaplerWithRetries(
  dmgPath,
  {
    action = 'staple',
    run = runStapler,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
    warn = console.warn,
    write = (output) => process.stdout.write(output),
  } = {},
) {
  if (action !== 'staple' && action !== 'validate') throw new Error(`Unsupported stapler action: ${action}`);
  for (let attempt = 0; ; attempt++) {
    const result = await run('xcrun', ['stapler', action, dmgPath]);
    if (result.output) write(result.output);
    const delay = retryDelaysMs[attempt];
    if (!isTransientStaplerFailure(result) || delay === undefined) return result;
    warn(
      `Apple ticket ${action} hit a transient network failure; retrying the same artifact in ${delay / 1000}s (attempt ${attempt + 2}/${retryDelaysMs.length + 1}).`,
    );
    await wait(delay);
  }
}

export function parseStaplerArgs(args) {
  if (args.length === 1 && args[0] && !args[0].startsWith('--')) return { dmgPath: args[0], action: 'staple' };
  if (args.length === 2 && args[0] === '--validate' && args[1] && !args[1].startsWith('--'))
    return { dmgPath: args[1], action: 'validate' };
  throw new Error('Usage: staple-macos-dmg.mjs [--validate] <already-notarized-dmg>');
}

async function main() {
  const { dmgPath, action } = parseStaplerArgs(process.argv.slice(2));
  const result = await runMacDmgStaplerWithRetries(dmgPath, { action });
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
