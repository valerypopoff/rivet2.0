export function buildHostedEvaluationGateConfig(input: { rootDir: string; env?: NodeJS.ProcessEnv }): {
  hostedEvaluation: {
    waitSeconds: number;
    publicProbeRequests: number;
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
  failure?: unknown;
  cleanupFailure?: unknown;
}): object;
