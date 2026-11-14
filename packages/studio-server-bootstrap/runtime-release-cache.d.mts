export type RuntimeLibrarySnapshot = Readonly<{
  version: 1;
  root: string;
  directory: string;
  releaseId: string | null;
  integrity: string;
  requireAnchorPath: string;
}>;
export type RuntimeCacheManifest = {
  packages: Record<string, { version: string; name?: string; installedAt?: string }>;
  updatedAt: string;
  activeReleaseId?: string;
  runtimeCache?: { version: 1; directory: string; integrity: string };
};
export function readRuntimeCacheManifest(root: string): RuntimeCacheManifest;
export function runtimePackagesKey(packages: unknown): string;
export function selectRuntimeLibrarySource(root: string): {
  manifest: RuntimeCacheManifest;
  directory: string | null;
  snapshot: RuntimeLibrarySnapshot | null | undefined;
};
export function selectRuntimeLibrarySource<M extends RuntimeCacheManifest>(
  root: string,
  manifest: M,
): {
  manifest: M;
  directory: string | null;
  snapshot: RuntimeLibrarySnapshot | null | undefined;
};
export function readRuntimeSnapshotLink(root: string, manifest?: RuntimeCacheManifest): RuntimeLibrarySnapshot;
export function inspectRuntimeLibraryDirectory(directory: string): Promise<{ integrity: string; bytes: bigint }>;
export function writeRuntimeCacheManifest(root: string, manifest: RuntimeCacheManifest): Promise<void>;
export function publishRuntimeLibraryCandidate(
  root: string,
  candidate: string,
  manifest: RuntimeCacheManifest,
  options?: { integrity?: string; publishManifest?: boolean },
): Promise<{ manifest: RuntimeCacheManifest; snapshot: RuntimeLibrarySnapshot }>;
export function extractRuntimeLibraryArchive(
  root: string,
  archive: Uint8Array,
): Promise<{ candidate: string; dispose(): Promise<void> }>;
export function publishEmptyRuntimeRelease(
  root: string,
  manifest: RuntimeCacheManifest,
  options?: { publishManifest?: boolean },
): Promise<{ manifest: RuntimeCacheManifest; snapshot: RuntimeLibrarySnapshot }>;
export function prepareFilesystemRuntimeSnapshot(
  root: string,
  options?: { allowAbsent?: boolean },
): Promise<RuntimeLibrarySnapshot | null>;
export function createRuntimeLibrarySync<T>(
  run: () => Promise<T>,
  intervalMs: number,
): { reset(): void; drain(): Promise<void>; sync(force?: boolean): Promise<T> };
