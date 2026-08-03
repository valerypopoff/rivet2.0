export const DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES = 1;
export const DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS = 0;

export function normalizeLLMChatV2RetryCount(value: number | undefined): number {
  const retryCount =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_REPEAT_TIMES;

  return Math.max(1, Math.floor(retryCount));
}

export function normalizeLLMChatV2RetryCooldownMs(value: number | undefined): number {
  const cooldownMs =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_LLM_CHAT_V2_RETRY_ON_NON_200_COOLDOWN_MS;

  return Math.max(0, Math.floor(cooldownMs));
}

/** Keeps cancellation identity consistent before and during a retry cooldown. */
export function createLLMChatV2RetryAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export async function waitForLLMChatV2RetryCooldown(cooldownMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw createLLMChatV2RetryAbortError();
  }

  if (cooldownMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createLLMChatV2RetryAbortError());
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, cooldownMs);

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}
