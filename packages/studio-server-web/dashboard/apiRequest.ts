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

export async function parseJsonResponse<T>(
  response: Response,
  options: {
    nonJsonErrorMessage?: string;
  } = {},
): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    const text = await response.text();

    if (text.trim().startsWith('<!doctype') || text.trim().startsWith('<html')) {
      throw new Error(
        options.nonJsonErrorMessage ??
          'API returned HTML instead of JSON. Make sure you are accessing the app through the proxy.',
      );
    }

    throw new Error(`API returned an unexpected response type (${contentType || 'unknown'}).`);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: response.statusText }));
    throw createResponseError(response.status, data.error || response.statusText, data.code);
  }

  return response.json() as Promise<T>;
}

export async function parseTextResponse(response: Response): Promise<string> {
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({ error: response.statusText }));
      throw createResponseError(response.status, data.error || response.statusText, data.code);
    }

    throw createResponseError(response.status, response.statusText);
  }

  return response.text();
}
