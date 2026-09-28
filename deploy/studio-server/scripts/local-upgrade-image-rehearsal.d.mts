export function run(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  allowFailure?: boolean,
  timeoutMs?: number,
): Promise<{ code: number | null; output: string }>;
export function controlLocalUpgradeRehearsal(
  file: string,
  action:
    | 'restart'
    | 'recreate'
    | 'drop-runtime-cache'
    | 'assert-isolation'
    | 'assert-selected-integrity'
    | 'restore-backup'
    | 'corrupt-candidate'
    | 'offline-return'
    | 'assert-source-unchanged'
    | 'backup-and-restore-selected'
    | 'assert-rollback-closed'
    | 'read-web-app-binding',
): Promise<string | void>;
export function loadLocalUpgradeRehearsal(file: string): Promise<{ sourceRecordingId: string }>;
export function recordLocalUpgradeRehearsalPhase(file: string, phase: string): Promise<void>;
