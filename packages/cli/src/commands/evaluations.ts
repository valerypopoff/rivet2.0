import {
  createProcessor,
  loadProjectAndAttachedDataFromFile,
  type GraphInputNode,
  type GraphOutputs,
} from '@valerypopoff/rivet2-node';
import {
  deserializeEvaluationProjectData,
  EvaluationGraphExecutionError,
  runEvaluationSuite,
  validateEvaluationDataset,
  type EvaluationDataset,
  type EvaluationExecutionMetrics,
  type EvaluationRun,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import { readFile } from 'node:fs/promises';
import type * as yargs from 'yargs';
import {
  addDatasetOptions,
  addProviderOptions,
  createDatasetProvider,
  getProjectFile,
  resolveDatasetFilePath,
  withCliProcessorOptions,
  type DatasetCliOptions,
  type ProviderCliOptions,
} from '../cliRuntime.js';

export class EvaluationCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

type EvaluationRunArgs = {
  project?: string;
  suite?: string;
  trials?: number;
  concurrency?: number;
  baseline?: string;
  json?: boolean;
  junit?: boolean;
  benchmark?: boolean;
} & DatasetCliOptions &
  ProviderCliOptions;

export function makeEvaluationCommand<T>(y: yargs.Argv<T>) {
  return addDatasetOptions(addProviderOptions(y))
    .option('project', {
      demandOption: true,
      describe: 'The Rivet project that owns the evaluation suite',
      type: 'string',
    })
    .option('suite', { demandOption: true, describe: 'Evaluation suite ID or name', type: 'string' })
    .option('trials', { describe: 'Override the suite trial count', type: 'number' })
    .option('concurrency', { describe: 'Override the suite worker-pool concurrency (1–32)', type: 'number' })
    .option('baseline', { describe: 'Use this saved baseline ID instead of the suite default', type: 'string' })
    .option('benchmark', {
      describe: 'Measure execution without requiring or applying output-quality checks',
      type: 'boolean',
      default: false,
    })
    .option('json', { describe: 'Write the complete evaluation run as JSON', type: 'boolean', default: false })
    .option('junit', { describe: 'Write a JUnit XML report', type: 'boolean', default: false });
}

function findSuite(data: ReturnType<typeof deserializeEvaluationProjectData>, input: string) {
  return data.suites.find((suite) => suite.id === input || suite.name === input);
}

async function loadEvaluationDataset(projectPath: string, projectId: string, datasetId: string, datasetFile?: string) {
  const path = resolveDatasetFilePath(projectPath, datasetFile);
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    throw new EvaluationCliError(
      `Could not read evaluation dataset file "${path}": ${error instanceof Error ? error.message : String(error)}`,
      3,
    );
  }
  let parsed: { evaluationDatasets?: unknown };
  try {
    parsed = JSON.parse(content) as { evaluationDatasets?: unknown };
  } catch {
    throw new EvaluationCliError(`Evaluation dataset file "${path}" is not valid JSON.`, 3);
  }
  const dataset = Array.isArray(parsed.evaluationDatasets)
    ? (parsed.evaluationDatasets as EvaluationDataset[]).find(
        (candidate) => candidate.id === datasetId && candidate.projectId === projectId,
      )
    : undefined;
  if (!dataset) throw new EvaluationCliError(`Evaluation dataset "${datasetId}" was not found in "${path}".`, 3);
  return validateEvaluationDataset(dataset);
}

function graphInputsToOutputs(
  project: Parameters<typeof createProcessor>[0],
  graphId: string,
  inputs: Record<string, PortableJson>,
): GraphOutputs {
  const graph = project.graphs[graphId as keyof typeof project.graphs];
  if (!graph) throw new Error(`Evaluation graph "${graphId}" does not exist.`);
  const graphInputs = new Map(
    graph.nodes
      .filter((node): node is GraphInputNode => node.type === 'graphInput')
      .map((node) => [node.data.id, node]),
  );
  return Object.fromEntries(
    Object.entries(inputs).map(([id, value]) => {
      const input = graphInputs.get(id);
      if (!input) throw new Error(`Evaluation supplied unknown graph input "${id}".`);
      return [id, { type: input.data.dataType, value }];
    }),
  ) as GraphOutputs;
}

export function formatEvaluationRunAsJUnit(run: Awaited<ReturnType<typeof runEvaluationSuite>>): string {
  const escape = (value: string) =>
    value.replace(
      /[<>&"']/gu,
      (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!,
    );
  const cases = run.trials.map((trial) => {
    const observationDetails = trial.observations
      .filter((observation) => observation.status !== 'passed')
      .map((observation) => observation.message ?? observation.name)
      .join('; ');
    const details = trial.error ?? (observationDetails || trial.qualityReason.message);
    const body =
      trial.executionStatus === 'error'
        ? `<error message="${escape(details || 'Evaluation execution error')}" />`
        : trial.executionStatus === 'canceled'
          ? `<skipped message="Evaluation execution was canceled." />`
          : trial.qualityStatus === 'unable-to-evaluate'
            ? `<error message="${escape(details || 'Evaluation infrastructure error')}" />`
            : trial.qualityStatus === 'failed'
              ? `<failure message="${escape(details || 'Evaluation failed')}" />`
              : trial.qualityStatus === 'not-evaluated'
                ? `<skipped message="${escape(trial.qualityReason.message)}" />`
                : '';
    return {
      xml: `<testcase name="${escape(trial.caseName)} [trial ${trial.trialIndex + 1}]" time="${(trial.totalMetrics.durationMs / 1000).toFixed(3)}">${body}</testcase>`,
      outcome:
        trial.executionStatus === 'error' ||
        (trial.executionStatus === 'completed' && trial.qualityStatus === 'unable-to-evaluate')
          ? ('error' as const)
          : trial.executionStatus === 'canceled' || trial.qualityStatus === 'not-evaluated'
            ? ('skipped' as const)
            : trial.qualityStatus === 'failed'
              ? ('failure' as const)
              : ('passed' as const),
    };
  });

  const representedRunQuality = cases.some((item) =>
    run.qualityStatus === 'failed'
      ? item.outcome === 'failure'
      : run.qualityStatus === 'unable-to-evaluate'
        ? item.outcome === 'error'
        : false,
  );
  const representedRunExecution = cases.some((item) =>
    run.executionStatus === 'error'
      ? item.outcome === 'error'
      : run.executionStatus === 'canceled'
        ? item.outcome === 'skipped'
        : false,
  );
  if (run.executionStatus !== 'completed' && !representedRunExecution) {
    const details = run.qualityReason.message;
    cases.push(
      run.executionStatus === 'canceled'
        ? {
            xml: `<testcase name="Evaluation execution"><skipped message="${escape(details)}" /></testcase>`,
            outcome: 'skipped',
          }
        : {
            xml: `<testcase name="Evaluation execution"><error message="${escape(details)}" /></testcase>`,
            outcome: 'error',
          },
    );
  } else if (
    run.executionStatus === 'completed' &&
    !representedRunQuality &&
    !cases.some((item) => item.outcome === 'error')
  ) {
    const thresholdDetails = run.thresholdResults
      .filter((result) => result.status !== 'passed')
      .map((result) => result.message)
      .join('; ');
    const details = thresholdDetails || run.qualityReason.message;
    if (run.qualityStatus === 'failed') {
      cases.push({
        xml: `<testcase name="Evaluation aggregate requirements"><failure message="${escape(details)}" /></testcase>`,
        outcome: 'failure',
      });
    } else if (
      run.qualityStatus === 'unable-to-evaluate' ||
      (run.purpose === 'evaluation' && run.qualityStatus === 'not-evaluated')
    ) {
      cases.push({
        xml: `<testcase name="Evaluation aggregate requirements"><error message="${escape(details)}" /></testcase>`,
        outcome: 'error',
      });
    }
  }

  const failures = cases.filter((item) => item.outcome === 'failure').length;
  const errors = cases.filter((item) => item.outcome === 'error').length;
  const skipped = cases.filter((item) => item.outcome === 'skipped').length;
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="${escape(run.suiteName)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}">${cases.map((item) => item.xml).join('')}</testsuite>`;
}

export function evaluationRunFailure(
  run: Pick<EvaluationRun, 'purpose' | 'executionStatus' | 'qualityStatus' | 'qualityReason' | 'aggregate' | 'trials'>,
): EvaluationCliError | undefined {
  if (run.executionStatus !== 'completed') {
    return new EvaluationCliError(`Evaluation execution ${run.executionStatus}: ${run.qualityReason.message}`, 3);
  }
  const erroredTrials =
    run.aggregate?.erroredTrialCount ?? run.trials.filter((trial) => trial.executionStatus === 'error').length;
  const canceledTrials =
    run.aggregate?.canceledTrialCount ?? run.trials.filter((trial) => trial.executionStatus === 'canceled').length;
  if (erroredTrials > 0 || canceledTrials > 0) {
    return new EvaluationCliError(
      `Evaluation execution completed with ${erroredTrials} errored and ${canceledTrials} canceled trials.`,
      3,
    );
  }
  if (run.qualityStatus === 'failed') {
    return new EvaluationCliError('Evaluation thresholds or required checks failed.', 2);
  }
  if (run.qualityStatus === 'unable-to-evaluate') {
    return new EvaluationCliError(run.qualityReason.message, 3);
  }
  if (run.purpose === 'evaluation' && run.qualityStatus === 'not-evaluated') {
    return new EvaluationCliError(run.qualityReason.message, 3);
  }
  return undefined;
}

export async function runEvaluation(args: EvaluationRunArgs): Promise<void> {
  if (!args.project || !args.suite) throw new EvaluationCliError('Both --project and --suite are required.', 3);
  const projectPath = await getProjectFile(args.project);
  const [project, attachedData] = await loadProjectAndAttachedDataFromFile(projectPath);
  const rawData = (attachedData as { evaluations?: unknown }).evaluations;
  if (!rawData) throw new EvaluationCliError('This project has no Evaluation definitions.', 3);
  const evaluationData = deserializeEvaluationProjectData(rawData);
  const suite = findSuite(evaluationData, args.suite);
  if (!suite) throw new EvaluationCliError(`Evaluation suite "${args.suite}" was not found.`, 3);
  const dataset = await loadEvaluationDataset(projectPath, project.metadata.id, suite.datasetId, args.datasetFile);
  const datasetProvider = await createDatasetProvider(projectPath, args);
  const effectiveData =
    args.trials === undefined && args.concurrency === undefined
      ? evaluationData
      : {
          ...evaluationData,
          suites: evaluationData.suites.map((candidate) =>
            candidate.id === suite.id
              ? {
                  ...candidate,
                  configuration: {
                    ...candidate.configuration,
                    ...(args.trials === undefined ? {} : { trialCount: args.trials }),
                    ...(args.concurrency === undefined ? {} : { concurrency: args.concurrency }),
                  },
                }
              : candidate,
          ),
        };
  const actualSuite = effectiveData.suites.find((candidate) => candidate.id === suite.id)!;
  const selectedBaseline =
    args.baseline === undefined
      ? undefined
      : effectiveData.baselines.find(
          (candidate) => candidate.id === args.baseline && candidate.suiteId === actualSuite.id,
        );
  if (args.baseline !== undefined && !selectedBaseline) {
    throw new EvaluationCliError(
      `Baseline "${args.baseline}" was not found for evaluation suite "${actualSuite.name}".`,
      3,
    );
  }
  const run = await runEvaluationSuite({
    project,
    evaluationData: effectiveData,
    dataset,
    suiteId: actualSuite.id,
    purpose: args.benchmark ? 'execution-benchmark' : 'evaluation',
    ...(selectedBaseline === undefined ? {} : { baseline: selectedBaseline }),
    executionMode: 'node-cli',
    runGraph: async ({ graphId, inputs, signal, metadata }) => {
      const startedAt = Date.now();
      const metrics: EvaluationExecutionMetrics = {
        durationMs: 0,
        modelCallCount: 0,
        toolCallCount: 0,
        toolFailureCount: 0,
      };
      const providerAttempts: PortableJson[] = [];
      const processorInfo = createProcessor(
        project,
        withCliProcessorOptions({ datasetProvider, projectPath }, args, {
          graph: graphId,
          inputs: graphInputsToOutputs(project, graphId, inputs),
          abortSignal: signal,
          evaluation: metadata,
        }),
      );
      processorInfo.processor.on('llmCallFinished', (event) => {
        metrics.modelCallCount = (metrics.modelCallCount ?? 0) + 1;
        metrics.inputTokens = (metrics.inputTokens ?? 0) + (event.normalizedUsage?.promptTokens ?? 0);
        metrics.outputTokens = (metrics.outputTokens ?? 0) + (event.normalizedUsage?.completionTokens ?? 0);
        metrics.cachedInputTokens = (metrics.cachedInputTokens ?? 0) + (event.normalizedUsage?.cachedTokens ?? 0);
        metrics.reasoningTokens = (metrics.reasoningTokens ?? 0) + (event.normalizedUsage?.reasoningTokens ?? 0);
        if (event.pricing.status === 'known') metrics.costUsd = (metrics.costUsd ?? 0) + (event.pricing.costUsd ?? 0);
        else metrics.hasUnknownCost = true;
        providerAttempts.push({
          kind: 'provider-call',
          provider: event.provider,
          model: event.model,
          customProviderApi: event.customProviderApi ?? null,
          outcome: event.outcome,
          profileIndex: event.profileIndex ?? null,
          attemptIndex: event.attemptIndex,
          roundIndex: event.roundIndex ?? null,
          durationMs: event.durationMs ?? null,
        });
      });
      processorInfo.processor.on('llmProfileAttempt', (event) => {
        providerAttempts.push({
          kind: 'profile-decision',
          provider: event.provider,
          model: event.model,
          customProviderApi: event.customProviderApi ?? null,
          stage: event.stage,
          outcome: event.outcome,
          profileIndex: event.profileIndex ?? null,
          attemptIndex: event.attemptIndex ?? null,
          roundIndex: event.roundIndex,
          status: event.status ?? null,
          healthState: event.healthState ?? null,
          healthDisposition: event.healthDisposition ?? null,
          timeoutKind: event.timeoutKind ?? null,
        });
      });
      processorInfo.processor.on('toolCallFinished', (event) => {
        metrics.toolCallCount = (metrics.toolCallCount ?? 0) + 1;
        if (event.outcome !== 'success') metrics.toolFailureCount = (metrics.toolFailureCount ?? 0) + 1;
      });
      try {
        const outputs = await processorInfo.run();
        metrics.durationMs = Date.now() - startedAt;
        return {
          outputs: Object.fromEntries(
            Object.entries(outputs).map(([key, value]) => [key, value.value as PortableJson]),
          ),
          metrics,
          ...(providerAttempts.length === 0 ? {} : { providerAttempts }),
        };
      } catch (error) {
        metrics.durationMs = Math.max(metrics.durationMs, Date.now() - startedAt);
        throw new EvaluationGraphExecutionError(error instanceof Error ? error.message : String(error), {
          metrics,
          ...(providerAttempts.length === 0 ? {} : { providerAttempts }),
        });
      } finally {
        processorInfo.dispose();
      }
    },
  });
  if (args.junit) process.stdout.write(`${formatEvaluationRunAsJUnit(run)}\n`);
  else if (args.json) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  else {
    const measured =
      run.purpose === 'execution-benchmark'
        ? `${run.aggregate?.trialCount ?? 0} trials measured`
        : `${run.aggregate?.passedTrialCount ?? 0}/${run.aggregate?.evaluatedTrialCount ?? 0} evaluated trials passed`;
    process.stdout.write(`${run.suiteName}: ${run.qualityStatus} (${run.executionStatus}; ${measured})\n`);
  }
  const failure = evaluationRunFailure(run);
  if (failure) throw failure;
}
