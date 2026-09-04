type JointCapacityConfig = {
  trialDelayMs: number;
  capacityConfig: {
    mode: 'certify';
    capacity: {
      jobTimeoutSeconds: number;
    };
  };
};

export function buildHostedEvaluationGateConfig(input?: { rootDir?: string; env?: NodeJS.ProcessEnv }): {
  hostedEvaluation: {
    waitSeconds: number;
    publicProbeRequests: number;
    jointCapacity: JointCapacityConfig | null;
  };
  artifactsDir: string;
};

export function createHostedEvaluationSubmission(input: { runId: string; label: string }): {
  projectContents: string | null;
  projectPath: string;
  evaluationData: {
    suites: Array<{
      targetGraphId: string;
      assertions: [];
      configuration: { trialCount: number };
    }>;
  };
  dataset: { projectId: string };
  suiteId: string;
  purpose: 'execution-benchmark';
  runId: string;
};

export function createHostedEvaluationEvidence(input: {
  phase: string;
  completed: boolean;
  runs: Array<{ id: string; state: unknown }>;
  publicProbe: unknown;
  jointCapacity?: {
    requested: boolean;
    status?: string;
    phase?: string;
    certificatePassed?: boolean;
  } | null;
  failure?: unknown;
  cleanupFailure?: unknown;
}): object;

export function createHostedEvaluationFixtureContents(template: string, options?: { trialDelayMs?: number }): string;
