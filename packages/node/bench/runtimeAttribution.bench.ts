import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, type } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  createProcessor,
  loadProjectFromFile,
  type CodeRunner,
  type CodeRunnerOptions,
  type DataValue,
  type GraphId,
  type GraphProcessorRuntimeProfileBucket,
  type Inputs,
  type NodeGraph,
  type Outputs,
  type ProcessEvents,
  type Project,
} from '../src/index.js';
import { createCodeRunnerRequire } from '../src/native/codeRunnerRequire.js';
import {
  buildNodeCodeRunnerInvocation,
  compileNodeCodeRunnerFunction,
  type CodeInterpolationResolver,
  type NodeCodeRunnerFunction,
} from '../src/native/nodeCodeRunnerInvocation.js';

const benchDir = dirname(fileURLToPath(import.meta.url));
const nodePackageDir = join(benchDir, '..');
const repoRoot = join(nodePackageDir, '..', '..');
const localRealWorkflowFixturePath = join(repoRoot, '.fixtures', 'graph-fixture.rivet-project');
const outputPath = resolveAttributionOutputPath(process.env.RIVET_RUNTIME_ATTRIBUTION_OUTPUT?.trim());
const jsonMode = process.env.RIVET_RUNTIME_ATTRIBUTION_JSON === '1';
const runs = readPositiveIntegerEnv('RIVET_RUNTIME_ATTRIBUTION_RUNS', 1);
const ARGUMENT_SHAPE_SEPARATOR = '\0';

type CodeRunnerProfile = {
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
  compileMs: number;
  executeMs: number;
  invocationBuildMs: number;
  lookupMs: number;
  runCalls: number;
  totalMs: number;
};

type CodeCacheEntry = {
  codeFunction: NodeCodeRunnerFunction;
};

type NodeTypeSummary = {
  count: number;
  durationMs: number;
  errorCount: number;
  excludedCount: number;
  splitDurationMs: number;
};

type GraphSummary = {
  finishCount: number;
  graphId: string;
  graphName: string;
  graphRunId: string;
  nodeDurationMs: number;
  nodeTerminalCount: number;
  outputKeys: string[];
  parentGraphRunId?: string;
  startCount: number;
};

type TopNodeSummary = {
  durationMs: number;
  graphId: string;
  graphName: string;
  nodeId: string;
  nodeTitle: string;
  nodeType: string;
  processId: string;
  splitDurationMs: number;
};

type RuntimePhaseSummary = {
  bucket: GraphProcessorRuntimeProfileBucket;
  durationMs: number;
  percentOfRunWallMs: number;
};

type AttributionSummary = {
  codeRunner: CodeRunnerProfile;
  createProcessorMs: number;
  excludedNodes: number;
  graphRunCount: number;
  leafNodeDurationMs: number;
  loadProjectMs: number;
  nodeDurationMs: number;
  outputCount: number;
  runtimeProfiledInclusiveMs: number;
  runWallMs: number;
  terminalNodeEvents: number;
};

type AttributionOutput = {
  codeRunnerScenarios: Array<CodeRunnerScenarioSummary>;
  graphs: GraphSummary[];
  metadata: {
    arch: string;
    command: string;
    commit: string;
    cpuModel: string;
    date: string;
    fixturePath: string;
    gitDirty: boolean;
    gitStatusShort: string[];
    jsonMode: boolean;
    node: string;
    os: string;
    outputPath?: string;
    platform: NodeJS.Platform;
    release: string;
    runs: number;
  };
  nodeTypes: Array<NodeTypeSummary & { nodeType: string }>;
  runtimePhases: RuntimePhaseSummary[];
  summary: AttributionSummary;
  topNodes: TopNodeSummary[];
};

type CodeRunnerScenarioSummary = CodeRunnerProfile & {
  iterations: number;
  name: string;
};

class ProfilingCachedNodeCodeRunner implements CodeRunner {
  private readonly cacheByCode = new Map<string, Map<string, CodeCacheEntry>>();
  private readonly profile: CodeRunnerProfile = {
    cacheEntries: 0,
    cacheHits: 0,
    cacheMisses: 0,
    compileMs: 0,
    executeMs: 0,
    invocationBuildMs: 0,
    lookupMs: 0,
    runCalls: 0,
    totalMs: 0,
  };
  private readonly runtimeRequire = createCodeRunnerRequire();
  private interpolationResolverPromise: Promise<CodeInterpolationResolver> | undefined;
  private rivetModulePromise: Promise<unknown> | undefined;

  getProfile(): CodeRunnerProfile {
    return {
      ...this.profile,
      cacheEntries: this.cacheEntryCount(),
    };
  }

  async runCode(
    code: string,
    inputs: Inputs,
    options: CodeRunnerOptions,
    graphInputs?: Record<string, DataValue>,
    contextValues?: Record<string, DataValue>,
  ): Promise<Outputs> {
    this.profile.runCalls += 1;
    const totalStart = performance.now();

    const invocationStart = performance.now();
    const { argNames, args } = await buildNodeCodeRunnerInvocation({
      contextValues,
      graphInputs,
      inputs,
      loadInterpolationResolver: () => this.loadInterpolationResolver(),
      loadRivet: () => this.loadRivet(),
      options,
      runtimeRequire: this.runtimeRequire,
    });
    this.profile.invocationBuildMs += performance.now() - invocationStart;

    const codeFunction = this.getCodeFunction(argNames, code);

    const executeStart = performance.now();
    try {
      return await codeFunction(...args);
    } finally {
      this.profile.executeMs += performance.now() - executeStart;
      this.profile.totalMs += performance.now() - totalStart;
    }
  }

  private cacheEntryCount(): number {
    let count = 0;
    for (const entriesByShape of this.cacheByCode.values()) {
      count += entriesByShape.size;
    }
    return count;
  }

  private getCodeFunction(argNames: string[], code: string): NodeCodeRunnerFunction {
    const lookupStart = performance.now();
    const argShape = argNames.join(ARGUMENT_SHAPE_SEPARATOR);
    const cached = this.cacheByCode.get(code)?.get(argShape);
    this.profile.lookupMs += performance.now() - lookupStart;

    if (cached) {
      this.profile.cacheHits += 1;
      return cached.codeFunction;
    }

    this.profile.cacheMisses += 1;
    const compileStart = performance.now();
    const codeFunction = compileNodeCodeRunnerFunction(argNames, code);
    this.profile.compileMs += performance.now() - compileStart;

    this.storeCodeFunction(code, argShape, codeFunction);
    return codeFunction;
  }

  private storeCodeFunction(code: string, argShape: string, codeFunction: NodeCodeRunnerFunction): void {
    let entriesByShape = this.cacheByCode.get(code);
    if (!entriesByShape) {
      entriesByShape = new Map<string, CodeCacheEntry>();
      this.cacheByCode.set(code, entriesByShape);
    }

    entriesByShape.set(argShape, {
      codeFunction,
    });
  }

  private async loadRivet(): Promise<unknown> {
    const promise = this.rivetModulePromise ?? import('@valerypopoff/rivet2-node');
    this.rivetModulePromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.rivetModulePromise === promise) {
        this.rivetModulePromise = undefined;
      }
      throw error;
    }
  }

  private async loadInterpolationResolver(): Promise<CodeInterpolationResolver> {
    const promise =
      this.interpolationResolverPromise ??
      import('@valerypopoff/rivet2-core/interpolation-runtime').then(
        ({ resolveCodeInterpolationExpression }) => resolveCodeInterpolationExpression,
      );
    this.interpolationResolverPromise = promise;

    try {
      return await promise;
    } catch (error) {
      if (this.interpolationResolverPromise === promise) {
        this.interpolationResolverPromise = undefined;
      }
      throw error;
    }
  }
}

async function main() {
  await access(localRealWorkflowFixturePath);

  const loadStart = performance.now();
  const project = await loadProjectFromFile(localRealWorkflowFixturePath);
  const loadProjectMs = performance.now() - loadStart;
  const graphId = getMainGraphId(project);
  const codeRunner = new ProfilingCachedNodeCodeRunner();
  const graphRuns = new Map<string, GraphSummary>();
  const nodeTypes = new Map<string, NodeTypeSummary>();
  const runtimePhaseDurations = new Map<GraphProcessorRuntimeProfileBucket, number>();
  const topNodes: TopNodeSummary[] = [];
  let createProcessorMs = 0;
  let excludedNodes = 0;
  let outputCount = 0;
  let runWallMs = 0;

  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const createProcessorStart = performance.now();
    const processor = createProcessor(project, {
      captureNodeTimings: true,
      codeRunner,
      graph: graphId,
      onGraphFinish: (event) => {
        const graphRun = getOrCreateGraphSummary(graphRuns, event);
        graphRun.finishCount += 1;
        graphRun.outputKeys = Object.keys(event.outputs);
      },
      onGraphStart: (event) => {
        const graphRun = getOrCreateGraphSummary(graphRuns, event);
        graphRun.startCount += 1;
      },
      onNodeError: (event) => {
        const summary = getOrCreateNodeTypeSummary(nodeTypes, event.node.type);
        summary.count += 1;
        summary.errorCount += 1;
        summary.durationMs += event.durationMs ?? 0;
        summary.splitDurationMs += sumSplitDurations(event.splitRunDurationMs);
      },
      onNodeExcluded: (event) => {
        excludedNodes += 1;
        const summary = getOrCreateNodeTypeSummary(nodeTypes, event.node.type);
        summary.count += 1;
        summary.excludedCount += 1;
      },
      onNodeFinish: (event) => {
        const durationMs = event.durationMs ?? 0;
        const splitDurationMs = sumSplitDurations(event.splitRunDurationMs);
        const nodeType = event.node.type;
        const summary = getOrCreateNodeTypeSummary(nodeTypes, nodeType);
        summary.count += 1;
        summary.durationMs += durationMs;
        summary.splitDurationMs += splitDurationMs;

        const graphRun = getOrCreateGraphSummary(graphRuns, event);
        graphRun.nodeTerminalCount += 1;
        graphRun.nodeDurationMs += durationMs;

        topNodes.push({
          durationMs,
          graphId: event.execution.graphId,
          graphName: graphRun.graphName,
          nodeId: event.node.id,
          nodeTitle: event.node.title,
          nodeType,
          processId: event.processId,
          splitDurationMs,
        });
      },
      runtimeProfiler: {
        addDuration(bucket, durationMs) {
          runtimePhaseDurations.set(bucket, (runtimePhaseDurations.get(bucket) ?? 0) + durationMs);
        },
      },
    });
    createProcessorMs += performance.now() - createProcessorStart;

    const runStart = performance.now();
    const outputs = await processor.run();
    runWallMs += performance.now() - runStart;
    outputCount += Object.keys(outputs).length;
  }

  const output = createAttributionOutput({
    codeRunner,
    codeRunnerScenarios: await runCodeRunnerScenarios(),
    createProcessorMs,
    excludedNodes,
    graphRuns,
    loadProjectMs,
    nodeTypes,
    outputCount,
    runtimePhaseDurations,
    runWallMs,
    topNodes,
  });

  if (outputPath) {
    await writeAttributionOutput(outputPath, output);
  }

  if (jsonMode) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('Runtime attribution summary');
  console.table([formatSummaryForConsole(output.summary)]);
  console.log('Node types');
  console.table(output.nodeTypes.map(formatNodeTypeForConsole));
  console.log('Top nodes');
  console.table(output.topNodes.slice(0, 20).map(formatTopNodeForConsole));
  console.log('Graphs');
  console.table(output.graphs.slice(0, 20).map(formatGraphForConsole));
  console.log('Runtime phases');
  console.table(output.runtimePhases.map(formatRuntimePhaseForConsole));
  console.log('CodeRunner profile');
  console.table([formatCodeRunnerForConsole(output.summary.codeRunner)]);
  console.log('Synthetic CodeRunner scenarios');
  console.table(output.codeRunnerScenarios.map(formatCodeRunnerScenarioForConsole));
  if (outputPath) {
    console.log(`Wrote runtime attribution artifact to ${outputPath}`);
  }
}

function createAttributionOutput({
  codeRunner,
  codeRunnerScenarios,
  createProcessorMs,
  excludedNodes,
  graphRuns,
  loadProjectMs,
  nodeTypes,
  outputCount,
  runtimePhaseDurations,
  runWallMs,
  topNodes,
}: {
  codeRunner: ProfilingCachedNodeCodeRunner;
  codeRunnerScenarios: CodeRunnerScenarioSummary[];
  createProcessorMs: number;
  excludedNodes: number;
  graphRuns: Map<string, GraphSummary>;
  loadProjectMs: number;
  nodeTypes: Map<string, NodeTypeSummary>;
  outputCount: number;
  runtimePhaseDurations: Map<GraphProcessorRuntimeProfileBucket, number>;
  runWallMs: number;
  topNodes: TopNodeSummary[];
}): AttributionOutput {
  const nodeTypesArray = [...nodeTypes.entries()]
    .map(([nodeType, summary]) => ({ nodeType, ...summary }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const graphs = [...graphRuns.values()].sort((a, b) => b.nodeDurationMs - a.nodeDurationMs);
  const sortedTopNodes = [...topNodes].sort((a, b) => b.durationMs - a.durationMs);
  const nodeDurationMs = nodeTypesArray.reduce((sum, entry) => sum + entry.durationMs, 0);
  const leafNodeDurationMs = nodeTypesArray
    .filter((entry) => entry.nodeType !== 'subGraph')
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  const terminalNodeEvents = nodeTypesArray.reduce((sum, entry) => sum + entry.count, 0);
  const runtimePhases = [...runtimePhaseDurations.entries()]
    .map(([bucket, durationMs]) => ({
      bucket,
      durationMs,
      percentOfRunWallMs: runWallMs > 0 ? (durationMs / runWallMs) * 100 : 0,
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const runtimeProfiledInclusiveMs = runtimePhases.reduce((sum, entry) => sum + entry.durationMs, 0);

  return {
    codeRunnerScenarios,
    graphs,
    metadata: createMetadata(),
    nodeTypes: nodeTypesArray,
    runtimePhases,
    summary: {
      codeRunner: codeRunner.getProfile(),
      createProcessorMs,
      excludedNodes,
      graphRunCount: graphs.length,
      leafNodeDurationMs,
      loadProjectMs,
      nodeDurationMs,
      outputCount,
      runtimeProfiledInclusiveMs,
      runWallMs,
      terminalNodeEvents,
    },
    topNodes: sortedTopNodes,
  };
}

async function runCodeRunnerScenarios(): Promise<CodeRunnerScenarioSummary[]> {
  const iterations = readPositiveIntegerEnv('RIVET_RUNTIME_ATTRIBUTION_CODE_RUNS', 200);
  const baseOptions: CodeRunnerOptions = {
    includeConsole: false,
    includeFetch: false,
    includeProcess: false,
    includeRequire: false,
    includeRivet: false,
  };

  return [
    await profileCodeRunnerScenario({
      iterations,
      makeCode: () =>
        'return { output: { type: "number", value: inputs.input.value + 1 } };',
      name: 'repeated identical expression-like code',
      options: baseOptions,
    }),
    await profileCodeRunnerScenario({
      iterations,
      makeCode: (index) =>
        `return { output: { type: "number", value: inputs.input.value + ${index + 1} } };`,
      name: 'distinct expression-like code',
      options: baseOptions,
    }),
    await profileCodeRunnerScenario({
      iterations,
      makeCode: () =>
        'return { output: { type: "object", value: { value: inputs.input.value, nested: { ok: true } } } };',
      name: 'object-returning code',
      options: baseOptions,
    }),
    await profileCodeRunnerScenario({
      iterations,
      makeCode: () =>
        'const path = require("node:path"); return { output: { type: "string", value: path.basename("a/b.txt") } };',
      name: 'require-enabled code',
      options: {
        ...baseOptions,
        includeRequire: true,
      },
    }),
    await profileCodeRunnerScenario({
      iterations,
      makeCode: () =>
        'const value = await Promise.resolve(inputs.input.value + 1); return { output: { type: "number", value } };',
      name: 'async code',
      options: baseOptions,
    }),
    await profileCodeRunnerScenario({
      contextValues: {
        add: { type: 'number', value: 1 },
      },
      graphInputs: {
        seed: { type: 'number', value: 2 },
      },
      iterations,
      makeCode: () =>
        'return { output: { type: "number", value: inputs.input.value + graphInputs.seed.value + context.add.value } };',
      name: 'graphInputs and context code',
      options: baseOptions,
    }),
  ];
}

async function profileCodeRunnerScenario({
  contextValues,
  graphInputs,
  iterations,
  makeCode,
  name,
  options,
}: {
  contextValues?: Record<string, DataValue>;
  graphInputs?: Record<string, DataValue>;
  iterations: number;
  makeCode: (index: number) => string;
  name: string;
  options: CodeRunnerOptions;
}): Promise<CodeRunnerScenarioSummary> {
  const runner = new ProfilingCachedNodeCodeRunner();

  for (let index = 0; index < iterations; index += 1) {
    await runner.runCode(
      makeCode(index),
      {
        input: { type: 'number', value: index },
      },
      options,
      graphInputs,
      contextValues,
    );
  }

  return {
    ...runner.getProfile(),
    iterations,
    name,
  };
}

function getOrCreateGraphSummary(
  graphRuns: Map<string, GraphSummary>,
  event: ProcessEvents['graphStart'] | ProcessEvents['graphFinish'] | ProcessEvents['nodeFinish'],
): GraphSummary {
  const graphRunId = event.execution.graphRunId;
  let graphRun = graphRuns.get(graphRunId);
  if (!graphRun) {
    graphRun = {
      finishCount: 0,
      graphId: event.execution.graphId,
      graphName: 'graph' in event ? getGraphName(event.graph) : '',
      graphRunId,
      nodeDurationMs: 0,
      nodeTerminalCount: 0,
      outputKeys: [],
      parentGraphRunId: event.execution.parentGraphRunId,
      startCount: 0,
    };
    graphRuns.set(graphRunId, graphRun);
  }

  if ('graph' in event) {
    graphRun.graphName = getGraphName(event.graph);
  }

  return graphRun;
}

function getOrCreateNodeTypeSummary(nodeTypes: Map<string, NodeTypeSummary>, nodeType: string): NodeTypeSummary {
  let summary = nodeTypes.get(nodeType);
  if (!summary) {
    summary = {
      count: 0,
      durationMs: 0,
      errorCount: 0,
      excludedCount: 0,
      splitDurationMs: 0,
    };
    nodeTypes.set(nodeType, summary);
  }

  return summary;
}

function getGraphName(graph: NodeGraph): string {
  return graph.metadata?.name ?? '<unnamed graph>';
}

function getMainGraphId(project: Project): GraphId {
  const graphId = project.metadata.mainGraphId ?? Object.values(project.graphs)[0]?.metadata?.id;
  if (!graphId) {
    throw new Error('Project does not contain a graph to benchmark.');
  }

  return graphId;
}

function sumSplitDurations(splitRunDurationMs: Record<number, number> | undefined): number {
  if (!splitRunDurationMs) {
    return 0;
  }

  return Object.values(splitRunDurationMs).reduce((sum, durationMs) => sum + durationMs, 0);
}

function createMetadata(): AttributionOutput['metadata'] {
  const gitStatusShort = readGitStatusShort();
  return {
    arch: arch(),
    command: `${process.execPath} ${process.argv.slice(1).join(' ')}`,
    commit: readGitCommit(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    date: new Date().toISOString(),
    fixturePath: localRealWorkflowFixturePath,
    gitDirty: gitStatusShort.length > 0,
    gitStatusShort,
    jsonMode,
    node: process.version,
    os: `${type()} ${release()}`,
    outputPath,
    platform: platform(),
    release: release(),
    runs,
  };
}

function resolveAttributionOutputPath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }

  if (isAbsolute(path)) {
    return path;
  }

  return path.replaceAll('\\', '/').startsWith('packages/') ? join(repoRoot, path) : path;
}

async function writeAttributionOutput(path: string, output: AttributionOutput): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function readGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readGitStatusShort(): string[] {
  try {
    return execFileSync('git', ['status', '--short'], { cwd: repoRoot, encoding: 'utf8' })
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatMs(value: number): string {
  return value.toFixed(3);
}

function formatSummaryForConsole(summary: AttributionSummary) {
  return {
    excludedNodes: summary.excludedNodes,
    createProcessorMs: formatMs(summary.createProcessorMs),
    graphRunCount: summary.graphRunCount,
    leafNodeDurationMs: formatMs(summary.leafNodeDurationMs),
    loadProjectMs: formatMs(summary.loadProjectMs),
    nodeDurationMs: formatMs(summary.nodeDurationMs),
    outputCount: summary.outputCount,
    runtimeProfiledInclusiveMs: formatMs(summary.runtimeProfiledInclusiveMs),
    runWallMs: formatMs(summary.runWallMs),
    terminalNodeEvents: summary.terminalNodeEvents,
  };
}

function formatRuntimePhaseForConsole(summary: RuntimePhaseSummary) {
  return {
    bucket: summary.bucket,
    durationMs: formatMs(summary.durationMs),
    percentOfRunWallMs: summary.percentOfRunWallMs.toFixed(2),
  };
}

function formatNodeTypeForConsole(summary: NodeTypeSummary & { nodeType: string }) {
  return {
    count: summary.count,
    durationMs: formatMs(summary.durationMs),
    errorCount: summary.errorCount,
    excludedCount: summary.excludedCount,
    nodeType: summary.nodeType,
    splitDurationMs: formatMs(summary.splitDurationMs),
  };
}

function formatTopNodeForConsole(summary: TopNodeSummary) {
  return {
    durationMs: formatMs(summary.durationMs),
    graphName: summary.graphName,
    nodeTitle: summary.nodeTitle,
    nodeType: summary.nodeType,
    splitDurationMs: formatMs(summary.splitDurationMs),
  };
}

function formatGraphForConsole(summary: GraphSummary) {
  return {
    graphName: summary.graphName,
    graphRunId: summary.graphRunId,
    nodeDurationMs: formatMs(summary.nodeDurationMs),
    nodeTerminalCount: summary.nodeTerminalCount,
    outputKeys: summary.outputKeys.join(', '),
  };
}

function formatCodeRunnerForConsole(profile: CodeRunnerProfile) {
  return {
    cacheEntries: profile.cacheEntries,
    cacheHits: profile.cacheHits,
    cacheMisses: profile.cacheMisses,
    compileMs: formatMs(profile.compileMs),
    executeMs: formatMs(profile.executeMs),
    invocationBuildMs: formatMs(profile.invocationBuildMs),
    lookupMs: formatMs(profile.lookupMs),
    runCalls: profile.runCalls,
    totalMs: formatMs(profile.totalMs),
  };
}

function formatCodeRunnerScenarioForConsole(summary: CodeRunnerScenarioSummary) {
  return {
    ...formatCodeRunnerForConsole(summary),
    iterations: summary.iterations,
    name: summary.name,
  };
}

await main();
