import { Pipeline, StepRun, getPipelines, init } from './gentraceSdk.js';

import type { RivetPlugin, SecretPluginConfigurationSpec } from '../../model/RivetPlugin.js';

const apiKeyConfigSpec: SecretPluginConfigurationSpec = {
  type: 'secret',
  label: 'Gentrace API Key',
  description: 'The API key for the Gentrace service.',
  pullEnvironmentVariable: 'GENTRACE_API_KEY',
  helperText: 'Create at https://gentrace.ai/settings/api-keys',
};

/**
 * The core package deliberately does not import the Evaluations package: that
 * package depends on core to execute graphs. This narrow structural view keeps
 * Gentrace an optional reporter rather than creating another evaluator runner
 * or a package dependency cycle.
 */
export type GentraceEvaluationRun = {
  id: string;
  suiteName: string;
  startedAt: string;
  completedAt?: string;
  purpose: string;
  executionStatus: string;
  qualityStatus: string;
  qualityReason: { code: string; message: string };
  accountingStatus: string;
  aggregate?: unknown;
  trials: Array<{
    id: string;
    caseId: string;
    caseName: string;
    trialIndex: number;
    executionStatus: string;
    qualityStatus: string;
    qualityReason: { code: string; message: string };
    inputs: object;
    expected: object;
    outputs: object;
    observations: unknown[];
    totalMetrics: { durationMs: number };
    error?: string;
  }>;
};

function initializeGentrace(gentraceApiKey: string): void {
  if (!gentraceApiKey) throw new Error('Gentrace API key not set.');
  init({ apiKey: gentraceApiKey });
}

function timestampForTrial(
  run: GentraceEvaluationRun,
  durationMs: number,
  index: number,
): { start: string; end: string } {
  const runStart = Date.parse(run.startedAt);
  const safeStart = Number.isFinite(runStart) ? runStart + index : Date.now();
  const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  return {
    start: new Date(safeStart).toISOString(),
    end: new Date(safeStart + safeDuration).toISOString(),
  };
}

/**
 * Exports an already completed Rivet Evaluation as one Gentrace pipeline run.
 * It never fetches Gentrace test cases and never executes a Rivet graph: the
 * generic Evaluations runner remains the sole execution engine.
 */
export async function exportGentraceEvaluationRun(input: {
  gentraceApiKey: string;
  pipelineSlug: string;
  run: GentraceEvaluationRun;
}): Promise<{ resultId?: string; pipelineRunId?: string }> {
  initializeGentrace(input.gentraceApiKey);
  if (!input.pipelineSlug) throw new Error('Gentrace pipeline slug is required.');
  if (input.run.executionStatus !== 'completed') {
    throw new Error('Only completed Rivet Evaluation runs can be exported to Gentrace.');
  }

  const pipeline = new Pipeline({ slug: input.pipelineSlug });
  const runner = pipeline.start({
    metadata: {
      source: { type: 'string', value: 'rivet-evaluations' },
      evaluationRunId: { type: 'string', value: input.run.id },
      suiteName: { type: 'string', value: input.run.suiteName },
      purpose: { type: 'string', value: input.run.purpose },
      qualityStatus: { type: 'string', value: input.run.qualityStatus },
      qualityReason: { type: 'string', value: input.run.qualityReason.message },
      accountingStatus: { type: 'string', value: input.run.accountingStatus },
      executionStatus: { type: 'string', value: input.run.executionStatus },
    },
  });

  for (const [index, trial] of input.run.trials.entries()) {
    const durationMs = typeof trial.totalMetrics.durationMs === 'number' ? trial.totalMetrics.durationMs : 0;
    const { start, end } = timestampForTrial(input.run, durationMs, index);
    await runner.addStepRunNode(
      new StepRun(
        'rivet',
        'rivet_evaluation_trial',
        durationMs,
        start,
        end,
        {
          caseId: trial.caseId,
          caseName: trial.caseName,
          trialIndex: trial.trialIndex,
          inputs: trial.inputs,
          expected: trial.expected,
        },
        {
          source: 'rivet-evaluations',
          purpose: input.run.purpose,
        },
        {
          executionStatus: trial.executionStatus,
          qualityStatus: trial.qualityStatus,
          qualityReason: trial.qualityReason,
          outputs: trial.outputs,
          observations: trial.observations,
          metrics: trial.totalMetrics,
        },
        {},
        trial.error,
      ),
    );
  }

  return (await runner.submit({ waitForServer: true })) as { resultId?: string; pipelineRunId?: string };
}

export async function getGentracePipelines(gentraceApiKey: string) {
  initializeGentrace(gentraceApiKey);
  return getPipelines();
}

export const gentracePlugin: RivetPlugin = {
  id: 'gentrace',
  name: 'Gentrace',
  configSpec: { gentraceApiKey: apiKeyConfigSpec },
};
