import { performance } from 'node:perf_hooks';

/** Named phases never print command arguments, dotenv contents, or rendered config. */
export async function withLauncherProgress(label, step, operation, options = {}) {
  const log = options.log ?? console.log;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const elapsed = () => `${Math.floor((now() - started) / 1000)}s`;
  log(`[${label}] ${step}…`);
  const timer = setInterval(
    () => log(`[${label}] ${step}: still running (${elapsed()} elapsed).`),
    options.intervalMs ?? 10_000,
  );
  timer.unref?.();
  try {
    const result = await operation();
    log(`[${label}] ${step}: completed (${elapsed()}).`);
    return result;
  } catch (error) {
    log(`[${label}] ${step}: failed (${elapsed()}).`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}
