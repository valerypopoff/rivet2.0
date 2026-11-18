const PUBLICATION_VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;

export function isPublicationVersion(value: unknown): value is string {
  return typeof value === 'string' && PUBLICATION_VERSION_PATTERN.test(value);
}

export function isNextPublicationVersion(previous: string, next: unknown): next is string {
  return isPublicationVersion(previous) && isPublicationVersion(next) && BigInt(next) === BigInt(previous) + 1n;
}

/** Transport failures and unreadable success responses can arrive after commit. */
export function isUnconfirmedPublication(error: unknown): boolean {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  return typeof status !== 'number' || status < 400 || status === 408 || status >= 500;
}
