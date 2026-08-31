export function evaluateCapacityCertificate(
  report: unknown,
  snapshots: Array<Record<string, unknown>>,
  config: {
    capacity: {
      stages: Array<{ name: string; scenario: string; expect: string; requests: number }>;
      controlCanaryEveryRequests: number;
      requireExecutionMetrics: boolean;
      thresholds: {
        maximumP95Ms: Record<string, number>;
        maximumUnexpectedRate: number;
        maximumControlCanaryFailureRate: number;
        maximumRecordingDrops: number;
      };
    };
  },
): string[];
export function createCapacityEvidence(input: {
  mode: 'observe' | 'certify';
  phase: string;
  completed: boolean;
  report?: unknown;
  snapshots: Array<Record<string, unknown>>;
  certificate: string[];
  failure?: unknown;
  cleanupFailure?: unknown;
}): Record<string, unknown>;
export function createCapacityFixtureContents(template: string, options: { title: string; delayMs: number }): string;
export function isTerminalJob(job: { status?: { conditions?: Array<{ type?: string; status?: string }> } }): boolean;
export function renderPublishedCapacityJob(input: {
  namespace: string;
  name: string;
  image: string;
  registrySecretName: string;
  configMapName: string;
  authorizationSecretName?: string;
  timeoutSeconds: number;
}): string;
export function createCapacityCapabilityToken(input: {
  signingKey: string;
  endpoints: string[];
  nowMs?: number;
  lifetimeSeconds: number;
}): string;
export function getCapacityFixtureEndpoints(jobName: string): string[];
export function createPublishedCapacityLoadJobConfig(input: {
  serviceNamePrefix: string;
  namespace: string;
  jobName: string;
  capacity: {
    requestTimeoutMs: number;
    controlCanaryEveryRequests: number;
    controlCanaryTimeoutMs: number;
    stages: unknown[];
  };
}): Record<string, unknown>;
