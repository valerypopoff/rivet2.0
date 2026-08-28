export function normalizeBasePath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  const candidate = trimmed && trimmed.length > 0 ? trimmed : fallback;
  const withLeadingSlash = candidate.startsWith('/') ? candidate : `/${candidate}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || fallback;
}

export function normalizeBasePathFromAliases(
  values: Array<string | undefined>,
  fallback: string,
): string {
  const firstConfigured = values.find((value) => {
    const trimmed = value?.trim();
    return trimmed != null && trimmed.length > 0;
  });

  return normalizeBasePath(firstConfigured, fallback);
}
