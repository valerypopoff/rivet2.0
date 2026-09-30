/** Only fixed vocabulary crosses the operator boundary. Never persist an
 * exception's message, stack, path, SQL, package output or nested cause. */
export const LOCAL_UPGRADE_STAGES = [
  'preflight',
  'workflows',
  'recordings',
  'settings',
  'runtime-libraries',
  'serving-verification',
  'operational-snapshots',
  'runtime-cache',
  'certification',
] as const;
export type LocalUpgradeStage = (typeof LOCAL_UPGRADE_STAGES)[number];
export const LOCAL_UPGRADE_FAILURE_CODES = [
  'disk-full',
  'permission-denied',
  'missing-data',
  'io-error',
  'invalid-data',
  'verification-failed',
] as const;
export type LocalUpgradeFailureCode = (typeof LOCAL_UPGRADE_FAILURE_CODES)[number];
export type LocalUpgradeFailure = { stage: LocalUpgradeStage; code: LocalUpgradeFailureCode };

export function localUpgradeFailure(stage: LocalUpgradeStage, error: unknown): LocalUpgradeFailure {
  // Error getters can themselves throw. Classification must never strand the
  // background job or accidentally serialize untrusted diagnostic data.
  let code: unknown;
  try {
    code = (error as { code?: unknown })?.code;
  } catch {
    /* Treat as unknown. */
  }
  return {
    stage,
    code:
      code === 'ENOSPC' || code === 'EDQUOT'
        ? 'disk-full'
        : code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
          ? 'permission-denied'
          : code === 'ENOENT'
            ? 'missing-data'
            : code === 'EIO'
              ? 'io-error'
              : stage === 'serving-verification' || stage === 'certification'
                ? 'verification-failed'
                : 'invalid-data',
  };
}

/** Internal test seam, never supplied by an HTTP request or environment flag.
 * Checkpoints run after durable job progress and around authority commits. */
export type LocalUpgradeHooks = {
  checkpoint?: (name: string) => Promise<void>;
};
