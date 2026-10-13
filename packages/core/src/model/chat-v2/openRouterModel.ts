import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';

/** OpenRouter may send a provider error inside an otherwise successful
 * response. Normalize it before the shared SDK consumer would stringify the
 * plain object and lose its message/status. Do not reinterpret other providers. */
function normalizeEmbeddedError(error: unknown): unknown {
  if (error instanceof Error || error == null || typeof error !== 'object' || Array.isArray(error)) return error;
  const record = error as Record<string, unknown>;
  if (typeof record.message !== 'string') return error;
  const normalized = new Error(record.message, { cause: error });
  const code = typeof record.code === 'string' && /^\d{3}$/.test(record.code) ? Number(record.code) : record.code;
  if (typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599) {
    return Object.assign(normalized, { name: 'AI_APICallError', statusCode: code });
  }
  return normalized;
}

const responseValidation: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  wrapGenerate: async ({ doGenerate }) => {
    try {
      return await doGenerate();
    } catch (error) {
      // Non-stream errors in a 200 response are wrapped by the adapter with
      // statusCode=200. Only a valid embedded error code may replace it.
      if (error instanceof Error && (error as { statusCode?: unknown }).statusCode === 200) {
        const normalized = normalizeEmbeddedError((error as { data?: unknown }).data);
        if (normalized instanceof Error && 'statusCode' in normalized) {
          normalized.cause = error;
          throw normalized;
        }
      }
      throw error;
    }
  },
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    let sawError = false;
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'error') {
              sawError = true;
              controller.enqueue({ ...part, error: normalizeEmbeddedError(part.error) });
              return;
            }
            // The adapter synthesizes a finish event on EOF, and can even infer
            // tool-calls from incomplete arguments. Require a provider finish
            // reason before accepting the response or delegating any tools.
            if (part.type === 'finish' && !sawError) {
              if (part.finishReason.raw == null) {
                sawError = true;
                controller.enqueue({
                  type: 'error',
                  error: Object.assign(
                    new Error('OpenRouter stream ended before a provider finish reason was received.'),
                    { name: 'OpenRouterIncompleteStreamError', code: 'ERR_STREAM_PREMATURE_CLOSE' },
                  ),
                });
              } else if (part.finishReason.unified === 'error' || part.finishReason.raw === 'error') {
                sawError = true;
                controller.enqueue({ type: 'error', error: new Error('OpenRouter reported an unsuccessful stream.') });
              }
            }
            controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

export function withOpenRouterResponseValidation(model: Parameters<typeof wrapLanguageModel>[0]['model']) {
  return wrapLanguageModel({ model, middleware: responseValidation });
}
