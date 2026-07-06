import {
  loadProjectFromFile,
  NodeDatasetProvider,
  type NodeCreateProcessorOptions,
  type Project,
  type UiGraph,
} from '@valerypopoff/rivet2-node';
import chalk from 'chalk';
import didYouMean from 'didyoumean2';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type * as yargs from 'yargs';

export type DatasetCliOptions = {
  datasetFile?: string;
  requireDatasetFile?: boolean;
  saveDatasets?: boolean;
};

export type ProviderCliOptions = {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  customAiApiKey?: string;
  openaiEndpoint?: string;
  openaiOrganization?: string;
};

export type LoadedProjectRuntime = {
  datasetProvider: NodeDatasetProvider;
  project: Project;
  projectPath: string;
};

export type GraphSummary = {
  id: string;
  name: string;
};

export type UiGraphSummary = {
  id: string;
  name: string;
};

type GraphArgumentStyle = 'option' | 'positional';

export async function loadProjectRuntime(
  projectFile: string | undefined,
  datasetOptions: DatasetCliOptions,
): Promise<LoadedProjectRuntime> {
  const projectPath = await getProjectFile(projectFile);
  const project = await loadProjectFromFile(projectPath);
  const datasetProvider = await createDatasetProvider(projectPath, datasetOptions);

  return { datasetProvider, project, projectPath };
}

export async function createDatasetProvider(
  projectPath: string,
  { datasetFile, requireDatasetFile = false, saveDatasets = false }: DatasetCliOptions,
): Promise<NodeDatasetProvider> {
  const datasetsFilePath = resolveDatasetFilePath(projectPath, datasetFile);

  if (datasetFile) {
    return NodeDatasetProvider.fromDatasetsFile(datasetsFilePath, {
      requireFile: requireDatasetFile,
      save: saveDatasets,
    });
  }

  return NodeDatasetProvider.fromProjectFile(projectPath, {
    requireFile: requireDatasetFile,
    save: saveDatasets,
  });
}

export function resolveDatasetFilePath(projectPath: string, datasetFile?: string): string {
  return datasetFile ? resolve(process.cwd(), datasetFile) : projectPath.replace(/\.rivet-project$/i, '.rivet-data');
}

export function withRuntimeProcessorOptions(
  runtime: Pick<LoadedProjectRuntime, 'datasetProvider' | 'projectPath'>,
  options: Omit<NodeCreateProcessorOptions, 'datasetProvider' | 'projectPath'>,
): NodeCreateProcessorOptions {
  return {
    ...options,
    datasetProvider: runtime.datasetProvider,
    projectPath: runtime.projectPath,
  };
}

export function withCliProcessorOptions(
  runtime: Pick<LoadedProjectRuntime, 'datasetProvider' | 'projectPath'>,
  providerOptions: ProviderCliOptions,
  options: Omit<
    NodeCreateProcessorOptions,
    | 'anthropicApiKey'
    | 'customAiApiKey'
    | 'datasetProvider'
    | 'googleApiKey'
    | 'openAiApiKey'
    | 'openAiEndpoint'
    | 'openAiKey'
    | 'openAiOrganization'
    | 'projectPath'
  >,
): NodeCreateProcessorOptions {
  return withRuntimeProcessorOptions(runtime, withProviderProcessorOptions(providerOptions, options));
}

export function withProviderProcessorOptions(
  providerOptions: ProviderCliOptions,
  options: Omit<
    NodeCreateProcessorOptions,
    'anthropicApiKey' | 'customAiApiKey' | 'googleApiKey' | 'openAiApiKey' | 'openAiEndpoint' | 'openAiKey' | 'openAiOrganization'
  >,
): NodeCreateProcessorOptions {
  const providerSettings: Partial<NodeCreateProcessorOptions> = {};

  if (providerOptions.openaiEndpoint != null) {
    providerSettings.openAiEndpoint = providerOptions.openaiEndpoint;
  }

  if (providerOptions.openaiApiKey != null) {
    providerSettings.openAiApiKey = providerOptions.openaiApiKey;
  }

  if (providerOptions.anthropicApiKey != null) {
    providerSettings.anthropicApiKey = providerOptions.anthropicApiKey;
  }

  if (providerOptions.googleApiKey != null) {
    providerSettings.googleApiKey = providerOptions.googleApiKey;
  }

  if (providerOptions.customAiApiKey != null) {
    providerSettings.customAiApiKey = providerOptions.customAiApiKey;
  }

  if (providerOptions.openaiOrganization != null) {
    providerSettings.openAiOrganization = providerOptions.openaiOrganization;
  }

  return {
    ...options,
    ...providerSettings,
  };
}

export function addProviderOptions<T>(y: yargs.Argv<T>): yargs.Argv<T> {
  return y
    .option('openai-api-key', {
      describe:
        'The OpenAI API key to use for the project. If omitted, the environment variable OPENAI_API_KEY is used.',
      type: 'string',
      demandOption: false,
    })
    .option('anthropic-api-key', {
      describe:
        'The Anthropic API key to use for LLM Chat nodes. If omitted, the environment variable ANTHROPIC_API_KEY is used.',
      type: 'string',
      demandOption: false,
    })
    .option('google-api-key', {
      describe:
        'The Google Generative AI API key to use for LLM Chat nodes. If omitted, the environment variable GOOGLE_GENERATIVE_AI_API_KEY is used.',
      type: 'string',
      demandOption: false,
    })
    .option('custom-ai-api-key', {
      describe:
        'The generic custom-provider API key to use for LLM Chat custom providers. If omitted, CUSTOM_AI_API_KEY, CUSTOM_PROVIDER_API_KEY, or the node-specific environment variable is used.',
      type: 'string',
      demandOption: false,
    })
    .option('openai-endpoint', {
      describe:
        'The OpenAI API endpoint to use for the project. If omitted, the environment variable OPENAI_ENDPOINT is used.',
      type: 'string',
      demandOption: false,
    })
    .option('openai-organization', {
      describe:
        'The OpenAI organization to use for the project. If omitted, the environment variable OPENAI_ORGANIZATION is used.',
      type: 'string',
      demandOption: false,
    });
}

export function addDatasetOptions<T>(
  y: yargs.Argv<T>,
  { includeSaveDatasets = true }: { includeSaveDatasets?: boolean } = {},
): yargs.Argv<T> {
  let result = y.option('dataset-file', {
    describe: 'Use a specific .rivet-data file instead of the project-adjacent default',
    type: 'string',
  });

  if (includeSaveDatasets) {
    result = result.option('save-datasets', {
      describe: 'Persist dataset mutations back to the dataset file',
      type: 'boolean',
      default: false,
    });
  }

  return result.option('require-dataset-file', {
    describe: 'Fail if the dataset file does not exist',
    type: 'boolean',
    default: false,
  });
}

export function warnIfServerSavesDatasets(saveDatasets: boolean | undefined, label = 'CLI server'): void {
  if (!saveDatasets) {
    return;
  }

  console.warn(
    chalk.yellow(
      `--save-datasets persists mutations from this ${label} process. Avoid concurrent production writes; use a wrapper with explicit write policy for shared deployments.`,
    ),
  );
}

export function getGraphSummaries(project: Project): GraphSummary[] {
  return Object.values(project.graphs).map((graph) => ({
    id: graph.metadata!.id!,
    name: graph.metadata!.name!,
  }));
}

export function findGraph(project: Project, graphIdOrName: string | undefined): GraphSummary | undefined {
  if (!graphIdOrName) {
    return undefined;
  }

  return getGraphSummaries(project).find((graph) => graph.id === graphIdOrName || graph.name === graphIdOrName);
}

export function formatGraphList(project: Project): string {
  return getGraphSummaries(project)
    .map((graph) => `- "${graph.name}" (${graph.id})`)
    .join('\n');
}

export function resolveServedGraphName(project: Project, graph: string | undefined): string {
  const servedGraph = findGraph(project, graph ?? project.metadata.mainGraphId);

  if (!servedGraph) {
    throw new Error(`Project main graph "${project.metadata.mainGraphId}" was not found in the project file.`);
  }

  return servedGraph.name;
}

export function throwIfNoMainGraph(
  project: Project,
  graph: string | undefined,
  projectFilePath: string,
  argumentStyle: GraphArgumentStyle = 'option',
): void {
  if (project.metadata.mainGraphId || graph) {
    return;
  }

  const validGraphs = getGraphSummaries(project);

  if (validGraphs.length === 0) {
    throw new Error('No graphs found in the project file. Please edit the project file in Rivet and add a graph.');
  }

  const firstExample = formatGraphSelectionExample(projectFilePath, validGraphs[0]!.id, argumentStyle);
  const secondExample = formatGraphSelectionExample(projectFilePath, `"${validGraphs[0]!.name}"`, argumentStyle);

  throw new Error(
    `No graph name provided, and project does not specify a main graph. Valid graphs are: \n\n${formatGraphList(
      project,
    )}\n\nUse either the graph's name or its ID. For example, \n- \`${chalk.bold(firstExample)}\` or\n- \`${chalk.bold(secondExample)}\``,
  );
}

export function throwIfInvalidGraph(
  project: Project,
  graph: string | undefined,
  argumentStyle: GraphArgumentStyle = 'option',
): void {
  if (!graph) {
    const mainGraphId = project.metadata.mainGraphId;

    if (!mainGraphId || findGraph(project, mainGraphId)) {
      return;
    }

    throw new Error(`Project main graph "${mainGraphId}" was not found in the project file.`);
  }

  if (findGraph(project, graph)) {
    return;
  }

  const validGraphsAndIds = getGraphSummaries(project).flatMap((validGraph) => [validGraph.id, validGraph.name]);
  const suggestion = didYouMean(graph, validGraphsAndIds);

  if (suggestion) {
    const suggestedArgument = formatGraphArgument(suggestion, argumentStyle);
    throw new Error(
      `Graph "${graph}" not found in project file. Did you mean \`${chalk.bold(suggestedArgument)}\`?`,
    );
  }

  throw new Error(`Graph "${graph}" not found in project file. Valid graphs are: \n${formatGraphList(project)}`);
}

function formatGraphSelectionExample(projectFilePath: string, graph: string, argumentStyle: GraphArgumentStyle): string {
  return argumentStyle === 'positional'
    ? `rivet run ${projectFilePath} ${graph}`
    : `rivet serve ${projectFilePath} --graph ${graph}`;
}

function formatGraphArgument(graph: string, argumentStyle: GraphArgumentStyle): string {
  return argumentStyle === 'positional' ? `"${graph}"` : `--graph "${graph}"`;
}

export function getUiGraphSummaries(project: Project): UiGraphSummary[] {
  return Object.values(project.uiGraphs ?? {}).map((uiGraph) => ({
    id: uiGraph.id,
    name: uiGraph.name,
  }));
}

export function resolveUiGraph(project: Project, uiGraphIdOrName: string | undefined): UiGraph {
  const uiGraphs = Object.values(project.uiGraphs ?? {});

  if (uiGraphIdOrName) {
    const uiGraph = uiGraphs.find((candidate) => candidate.id === uiGraphIdOrName || candidate.name === uiGraphIdOrName);
    if (uiGraph) {
      return uiGraph;
    }

    const validUiGraphs = getUiGraphSummaries(project).flatMap((uiGraph) => [uiGraph.id, uiGraph.name]);
    const suggestion = didYouMean(uiGraphIdOrName, validUiGraphs);
    const suffix = suggestion ? ` Did you mean "${suggestion}"?` : '';
    throw new Error(`Web app "${uiGraphIdOrName}" not found in project file.${suffix}`);
  }

  if (uiGraphs.length === 1) {
    return uiGraphs[0]!;
  }

  if (uiGraphs.length === 0) {
    throw new Error('No Rivet web apps found in the project file.');
  }

  const validUiGraphs = getUiGraphSummaries(project)
    .map((uiGraph) => `- "${uiGraph.name}" (${uiGraph.id})`)
    .join('\n');

  throw new Error(`Multiple Rivet web apps found. Specify one by name or ID:\n${validUiGraphs}`);
}

export async function getProjectFile(initialProjectFilePath: string | undefined): Promise<string> {
  let projectFilePath = resolve(
    process.cwd(),
    initialProjectFilePath ?? (await getProjectFilePathFromDirectory(process.cwd())),
  );

  await throwIfMissingFile(projectFilePath);

  if ((await stat(projectFilePath)).isDirectory()) {
    projectFilePath = await getProjectFilePathFromDirectory(projectFilePath);
  }

  return projectFilePath;
}

async function getProjectFilePathFromDirectory(directory: string): Promise<string> {
  const files = await readdir(directory);
  const projectFiles = files.filter((file) => extname(file).toLowerCase() === '.rivet-project');

  if (projectFiles.length === 0) {
    throw new Error('No project file found in the current directory. Project files should end with .rivet-project.');
  }

  if (projectFiles.length > 1) {
    throw new Error(
      `Multiple project files found in the current directory. Please specify which one to serve: \n${projectFiles.join(
        '\n',
      )}`,
    );
  }

  return join(directory, projectFiles[0]!);
}

async function throwIfMissingFile(filePath: string): Promise<void> {
  try {
    await stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }

    let possibleFiles: string[] = [];

    try {
      possibleFiles = await readdir(dirname(filePath));
    } catch {
      throw new Error(`Could not find project file "${filePath}".`);
    }

    const suggestion = didYouMean(basename(filePath), possibleFiles);

    if (suggestion) {
      throw new Error(
        `Could not find project file "${filePath}". Did you mean "${join(dirname(filePath), suggestion)}"?`,
      );
    }

    throw new Error(`Could not find project file "${filePath}".`);
  }
}
