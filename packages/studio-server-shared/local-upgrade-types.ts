/** Non-secret activity reported only by the authenticated local-upgrade API. */
export type LocalUpgradeOperation =
  | 'prepare'
  | 'restart'
  | 'inspect'
  | 'pause'
  | 'fingerprint'
  | 'backup'
  | 'copy'
  | 'activate'
  | 'validate'
  | 'return-to-legacy'
  | 'resume'
  | 'cancel';

export const LOCAL_UPGRADE_PREPARATION_KINDS = ['inspect', 'pause', 'pause-backup', 'fingerprint', 'backup'] as const;
export type LocalUpgradePreparationKind = (typeof LOCAL_UPGRADE_PREPARATION_KINDS)[number];
export type LocalUpgradeInventory = {
  source: Record<string, string>;
  capacity?: {
    payloadBytes: number;
    freeBytes: number;
    requiredBytes: number;
    maxPayloadBytes: number;
    fits: boolean;
    estimatedWorkingBytes?: number;
    memoryBudgetBytes?: number;
    measurementComplete?: boolean;
    reasons?: string[];
  };
  inventory: {
    projects: number;
    folders: number;
    recordingBundles: number;
    publishedEndpoints: number;
    publishedVersions: number;
    publishedWebApps: number;
    warnings: string[];
  } | null;
  backupRequired: string;
};
export type LocalUpgradePreparation = {
  id: string;
  kind: LocalUpgradePreparationKind;
  revision: number;
  phase: 'running' | 'ready' | 'failed' | 'interrupted';
  stage: 'inspect' | 'pause' | 'fingerprint' | 'backup';
  inventory?: LocalUpgradeInventory;
  fingerprint?: { pausedAt: string; sourceFingerprint: string };
  error?: string;
};

/** Fixed diagnostics only. Never derive display text from a storage exception. */
export const LOCAL_UPGRADE_FAILURE_REASONS = {
  'capacity-refused': 'Capacity checks failed. Inspect source again for disk, bundle and memory requirements.',
  'source-fingerprint-mismatch': 'The frozen source differs from the certified backup. Do not bypass verification.',
  'backup-evidence-mismatch': 'The backup evidence is stale or unavailable. Review the current backup status.',
  'backup-archive-mismatch': 'The retained backup archive no longer matches its verified checksum.',
  'unsupported-source-entry': 'The workflow tree contains an unsupported file, folder or symbolic link.',
  'project-parse-failed': 'A project or published project snapshot could not be decoded.',
  'project-id-missing': 'A project has no stable project ID.',
  'project-id-duplicate': 'Two source projects have the same project ID.',
  'project-settings-invalid': 'A project settings sidecar could not be read or validated.',
  'publication-history-invalid': 'Published-version history could not be read or validated.',
  'publication-project-missing': 'Published-version history refers to a project that is absent from the source tree.',
  'publication-snapshot-missing': 'A published endpoint or web app has no readable snapshot.',
  'publication-owner-mismatch': 'A published snapshot belongs to another project.',
  'publication-route-conflict': 'Projects have conflicting endpoint names or web-app slugs.',
  'source-bundle-limit': 'A decoded source bundle exceeds the configured memory safety limit.',
  'source-invalid-utf8': 'A source artifact is not valid UTF-8; conversion cannot preserve its bytes as text.',
  'source-changed-during-read': 'A source artifact changed while being read. Keep all source writers paused.',
  'catalog-import-failed': 'Importing a workflow into the candidate catalog failed. The source is unchanged.',
  'candidate-retry-mismatch':
    'The existing candidate differs on retry from the frozen source; it cannot be overwritten.',
  'unexpected-error':
    'An unclassified storage or converter failure occurred. This does not prove the source is corrupt.',
} as const;
export type LocalUpgradeFailureReason = keyof typeof LOCAL_UPGRADE_FAILURE_REASONS;
