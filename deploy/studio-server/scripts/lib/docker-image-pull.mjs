import { setTimeout as sleep } from 'node:timers/promises';

/** Retry policy for read-only image downloads; callers own command execution. */
export async function pullImageWithRetry(image, pull, { wait = sleep, warn = console.warn } = {}) {
  const delays = [5_000, 15_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await pull(image);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const transient = /connection reset by peer|TLS handshake timeout|i\/o timeout|unexpected EOF/i.test(message);
      const deterministic =
        /unauthorized|authentication required|access.*denied|manifest unknown|no matching manifest|invalid reference|digest mismatch|no space left/i.test(
          message,
        );
      const delay = delays[attempt];
      if (!transient || deterministic || delay === undefined) throw error;
      warn(`[image-pull] ${image}: transport failure; retry ${attempt + 2}/3 in ${delay / 1_000}s.`);
      await wait(delay);
    }
  }
}
