import { createHash } from 'node:crypto';
import {
  LOCAL_UPGRADE_FAILURE_REASONS,
  type LocalUpgradeFailureReason,
} from '../../../studio-server-shared/local-upgrade-types.js';

/** Only fixed vocabulary crosses the operator boundary. Never persist an
 * exception's message, stack, path, SQL, package output or nested cause. */
export const LOCAL_UPGRADE_STAGES = [
  'preflight',
  'capacity',
  'source-fingerprint',
  'backup-verification',
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
export type LocalUpgradeFailure = {
  stage: LocalUpgradeStage;
  code: LocalUpgradeFailureCode;
  reason?: LocalUpgradeFailureReason;
  sourceReference?: string;
};

export class LocalUpgradeDiagnosticError extends Error {
  readonly code?: string;
  constructor(
    readonly reason: LocalUpgradeFailureReason,
    readonly sourceReference?: string,
    cause?: unknown,
    message?: string,
  ) {
    super(message ?? LOCAL_UPGRADE_FAILURE_REASONS[reason], { cause });
    try {
      const code = (cause as { code?: unknown })?.code;
      if (typeof code === 'string' && ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EIO'].includes(code))
        this.code = code;
    } catch {
      /* Untrusted error getters are not diagnostic authority. */
    }
  }
}

/** An opaque lookup key, never a filename, project content or exception text. */
export function localUpgradeSourceReference(relativePath: string): string {
  return createHash('sha256').update(relativePath.replace(/\\/g, '/')).digest('hex').slice(0, 16);
}

export function localUpgradeSourceError(error: unknown, relativePath: string, fallback: LocalUpgradeFailureReason) {
  return new LocalUpgradeDiagnosticError(
    error instanceof LocalUpgradeDiagnosticError ? error.reason : fallback,
    localUpgradeSourceReference(relativePath),
    error,
    error instanceof LocalUpgradeDiagnosticError ? error.message : undefined,
  );
}

export function localUpgradeFailure(stage: LocalUpgradeStage, error: unknown): LocalUpgradeFailure {
  // Error getters can themselves throw. Classification must never strand the
  // background job or accidentally serialize untrusted diagnostic data.
  let code: unknown;
  try {
    code = (error as { code?: unknown })?.code;
  } catch {
    /* Treat as unknown. */
  }
  let reason: LocalUpgradeFailureReason | undefined;
  let sourceReference: string | undefined;
  try {
    if (error instanceof LocalUpgradeDiagnosticError) {
      if (typeof error.reason === 'string' && Object.hasOwn(LOCAL_UPGRADE_FAILURE_REASONS, error.reason))
        reason = error.reason;
      if (typeof error.sourceReference === 'string' && /^[a-f0-9]{16}$/.test(error.sourceReference))
        sourceReference = error.sourceReference;
    }
  } catch {
    // Mutated diagnostics and hostile getters cannot become durable evidence.
    reason = undefined;
    sourceReference = undefined;
  }
  if (
    !reason &&
    !(typeof code === 'string' && ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EIO'].includes(code))
  )
    reason = 'unexpected-error';
  return {
    stage,
    ...(reason ? { reason } : {}),
    ...(sourceReference ? { sourceReference } : {}),
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
