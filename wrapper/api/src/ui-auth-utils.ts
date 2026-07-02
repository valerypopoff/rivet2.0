const defaultUiReturnTo = '/';

export function sanitizeUiAuthReturnTo(value: unknown): string {
  if (typeof value !== 'string') {
    return defaultUiReturnTo;
  }

  const candidate = value.trim();
  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    /[\u0000-\u001f\u007f\\]/.test(candidate)
  ) {
    return defaultUiReturnTo;
  }

  try {
    const parsed = new URL(candidate, 'http://rivet.local');
    if (parsed.origin !== 'http://rivet.local') {
      return defaultUiReturnTo;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}` || defaultUiReturnTo;
  } catch {
    return defaultUiReturnTo;
  }
}

export function addUiAuthErrorToReturnTo(returnTo: string, authError: string): string {
  const parsed = new URL(sanitizeUiAuthReturnTo(returnTo), 'http://rivet.local');
  parsed.searchParams.set('auth_error', authError);
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || defaultUiReturnTo;
}

export function removeUiAuthErrorFromReturnTo(returnTo: string): string {
  const parsed = new URL(sanitizeUiAuthReturnTo(returnTo), 'http://rivet.local');
  parsed.searchParams.delete('auth_error');
  return `${parsed.pathname}${parsed.search}${parsed.hash}` || defaultUiReturnTo;
}
