import { coerce, gt, valid } from 'semver';

function normalizeVersion(version: string | undefined | null): string | undefined {
  if (!version) {
    return undefined;
  }

  return valid(version) ?? coerce(version)?.version;
}

export function getVisibleSkippedUpdateVersion(
  currentVersion: string | undefined,
  skippedVersion: string | undefined,
): string | undefined {
  if (!skippedVersion) {
    return undefined;
  }

  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  const normalizedSkippedVersion = normalizeVersion(skippedVersion);

  if (!normalizedCurrentVersion || !normalizedSkippedVersion) {
    return skippedVersion;
  }

  return gt(normalizedSkippedVersion, normalizedCurrentVersion) ? skippedVersion : undefined;
}
