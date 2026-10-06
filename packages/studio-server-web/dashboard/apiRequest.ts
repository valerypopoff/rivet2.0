type ResponseError = Error & {
  status?: number;
  code?: string;
};

export function createResponseError(status: number, message: string, code?: string): ResponseError {
  const error = new Error(message) as ResponseError;
  error.status = status;
  if (code) error.code = code;
  return error;
}

async function jsonResponseError(response: Response): Promise<ResponseError> {
  const data: unknown = await response.json().catch((failure: unknown) => {
    if (failure instanceof Error && failure.name === 'AbortError') throw failure;
    return null;
  });
  const fields = data !== null && typeof data === 'object' ? (data as { error?: unknown; code?: unknown }) : null;
  return createResponseError(
    response.status,
    typeof fields?.error === 'string' && fields.error
      ? fields.error
      : response.statusText || `API request failed (HTTP ${response.status}).`,
    typeof fields?.code === 'string' ? fields.code : undefined,
  );
}

export async function parseJsonResponse<T>(
  response: Response,
  options: {
    nonJsonErrorMessage?: string;
  } = {},
): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase();

  if (mediaType !== 'application/json') {
    const html = mediaType === 'text/html';
    // A gateway's HTML body may be large or never finish. Its header already
    // identifies the error; do not wait for or expose that body.
    if (html) void response.body?.cancel().catch(() => {});
    const text = html ? '' : await response.text();

    if (html || /^\s*<(?:!doctype|html)\b/i.test(text)) {
      throw createResponseError(
        response.status,
        options.nonJsonErrorMessage ??
          `API returned HTML instead of JSON (HTTP ${response.status}). A gateway timeout or sign-in page may have replaced the API response. Check connection and server status before retrying.`,
      );
    }

    throw createResponseError(
      response.status,
      `API returned an unexpected response type (${contentType || 'unknown'}; HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    throw await jsonResponseError(response);
  }

  try {
    return (await response.json()) as T;
  } catch (failure) {
    // Preserve cancellation semantics, but never display a parser exception:
    // modern engines can include private response bytes in its message.
    if (failure instanceof Error && failure.name === 'AbortError') throw failure;
    throw createResponseError(response.status, `API returned incomplete or invalid JSON (HTTP ${response.status}).`);
  }
}

export async function parseTextResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.split(';', 1)[0]!.trim().toLowerCase() === 'application/json') {
      throw await jsonResponseError(response);
    }

    throw createResponseError(response.status, response.statusText);
  }

  return response.text();
}
