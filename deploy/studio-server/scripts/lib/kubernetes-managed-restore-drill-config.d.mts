type StudioServerReleaseManifest = Record<string, unknown>;

export type ManagedRestoreProbe = {
  path: string;
  method: 'GET' | 'POST';
  body: unknown;
  expectedStatus: number;
  contains: string;
};

export type ManagedRestoreBackupManifest = {
  formatVersion: 1;
  createdAt: string;
  source: { namespace: string; baseUrl: string };
  release: StudioServerReleaseManifest;
  database: { provider: string; sourceId: string; recoveryPointId: string; recoveryPointAt: string };
  objectStorage: {
    provider: string;
    bucket: string;
    prefix: string;
    recoveryPointId: string;
    recoveryPointAt: string;
    versioningRetentionSeconds: number;
  };
  appSettings: { encryptionKeyIds: string[] };
};

export type ManagedRestoreDrillConfig = {
  context: string;
  allowedContext: string;
  configFile: string;
  configDirectory: string;
  valuesFile: string;
  registry: { server: string; username: string; password: string; secretName: string };
  backup: ManagedRestoreBackupManifest;
  target: {
    namespace: string;
    release: string;
    baseUrl: string;
    databaseId: string;
    objectStorage: { bucket: string; prefix: string };
  };
  objectives: { maximumRpoSeconds: number; maximumRtoSeconds: number };
  requestHeaders: Record<string, string>;
  probes: Record<string, ManagedRestoreProbe>;
  restoreDriver: ManagedRestoreDriver;
  integrityDriver: ManagedRestoreDriver;
  cleanupDriver: ManagedRestoreDriver;
  artifactsDir: string;
};

export type ManagedRestoreDriver = {
  applyFile: string;
  jobName: string;
  timeoutSeconds: number;
  role: 'restore' | 'integrity' | 'cleanup';
};

export const MANAGED_RESTORE_BACKUP_MANIFEST_VERSION: 1;
export const MANAGED_RESTORE_DRIVER_REPORT_VERSION: 1;
export const MANAGED_RESTORE_INTEGRITY_REPORT_VERSION: 1;
export const MANAGED_RESTORE_REQUIRED_PROBES: string[];

export function parseManagedRestoreBackupManifest(value: unknown): ManagedRestoreBackupManifest;
export function assertManagedRestoreDriverReport(
  value: unknown,
  context: {
    backup: ManagedRestoreBackupManifest;
    target: Pick<ManagedRestoreDrillConfig['target'], 'databaseId' | 'objectStorage'>;
    startedAt: string;
  },
): unknown;
export function assertManagedRestoreIntegrityReport(value: unknown): unknown;
export function buildManagedRestoreDrillConfig(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): ManagedRestoreDrillConfig;
export function releaseImagesForRestore(release: StudioServerReleaseManifest): Record<string, unknown>;
