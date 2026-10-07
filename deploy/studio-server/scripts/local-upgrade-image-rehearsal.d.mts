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
export function readOnlyRehearsalSqliteScript(
  body: string,
  options?: { module?: boolean; busyTimeoutMs?: number },
): string;
export function webAppBindingProbeScript(controlRoot?: string, busyTimeoutMs?: number): string;
export function waitForRehearsalCondition(
  probe: (budgetMs: number) => Promise<boolean>,
  timeoutMs: number,
  failureMessage: string,
): Promise<void>;
export function readRehearsalSourceFingerprint(output: string): string;
