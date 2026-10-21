import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMacDmgStaplerWithRetries, runStapler } from './staple-macos-dmg.mjs';

/** Tauri v1 calls `xcrun stapler staple -v <app>` after accepted notarization.
 * Retry that exact command, not the encompassing build/sign/submit sequence. */
export function runTauriAppStapler(args, { run = runStapler, ...options } = {}) {
  const valid =
    args.length === 4 &&
    args[0] === 'stapler' &&
    args[1] === 'staple' &&
    args[2] === '-v' &&
    typeof args[3] === 'string' &&
    !args[3].startsWith('-') &&
    args[3].endsWith('.app');
  if (!valid) throw new Error('Unsupported Tauri app stapler invocation.');
  const command = [...args];
  return runMacDmgStaplerWithRetries(command[3], {
    ...options,
    // Bypass the build-only PATH adapter. Preserve Tauri's exact argv and cwd.
    run: () => run('/usr/bin/xcrun', [...command]),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runTauriAppStapler(process.argv.slice(2));
    process.exitCode =
      result.status === 0
        ? 0
        : Number.isInteger(result.status) && result.status > 0 && result.status <= 255
          ? result.status
          : 1;
    if (result.error && !result.output) console.error(`Unable to run app stapler: ${result.error.message}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
