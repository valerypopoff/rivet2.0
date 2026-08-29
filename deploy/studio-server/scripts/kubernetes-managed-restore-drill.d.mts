export function parseRestoreDriverJsonMarker(logs: string, marker: string, description: string): unknown;
export function assertRestoreDriverManifest(
  resources: unknown,
  context: {
    namespace: string;
    driver: { role: 'restore' | 'integrity' | 'cleanup'; jobName: string };
  },
): void;
export function createRestoreFailureReport(context: {
  startedAt: string;
  target: Record<string, unknown>;
  failureStage: string;
  failedAt?: string;
}): {
  formatVersion: 1;
  status: 'failed';
  startedAt: string;
  failedAt: string;
  failureStage: string;
  message: string;
  target: Record<string, unknown>;
};
export function createRestoreProbeRequest(context: {
  baseUrl: string;
  requestHeaders: Record<string, string>;
  probe: { path: string; method: 'GET' | 'POST'; body?: unknown };
}): { url: URL; init: RequestInit };
export function getRestoreDriverJobState(
  job: unknown,
): { state: 'completed' } | { state: 'running' } | { state: 'failed'; reason: string };
export function measureRestoreObjectives(context: {
  startedAtMs: number;
  completedAtMs: number;
  databaseRecoveryPointAt: string;
  objectStorageRecoveryPointAt: string;
}): { achievedRpoSeconds: number; achievedRtoSeconds: number };
