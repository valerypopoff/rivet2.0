const PUBLICATION_VERSION_PATTERN = /^(0|[1-9][0-9]*)$/;

export function isPublicationVersion(value: unknown): value is string {
  return typeof value === 'string' && PUBLICATION_VERSION_PATTERN.test(value);
}

export function isNextPublicationVersion(previous: string, next: unknown): next is string {
  return isPublicationVersion(previous) && isPublicationVersion(next) && BigInt(next) === BigInt(previous) + 1n;
}
