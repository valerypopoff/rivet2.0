/** Explicit membership only. A hosted null overrides any stale local manifest. */
export function getExecutionBundleKey(
  info:
    | {
        hostedBundleKey?: string | null;
        bundleMember?: boolean;
        bundleManifestPath?: string;
      }
    | undefined,
): string | undefined {
  if (info?.hostedBundleKey !== undefined) return info.hostedBundleKey || undefined;
  if (info?.bundleMember === false) return undefined;
  return info?.bundleManifestPath ? `manifest:${info.bundleManifestPath}` : undefined;
}
