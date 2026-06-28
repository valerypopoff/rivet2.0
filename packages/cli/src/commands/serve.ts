import { serve as serveHono } from '@hono/node-server';
import { createProcessor, getSingleNodeStream, loadProjectFromFile } from '@valerypopoff/rivet2-node';
import type {
  LooseDataValue,
  NodeCreateProcessorOptions,
  Project,
  RivetEventStreamFilterSpec,
} from '@valerypopoff/rivet2-node';
import chalk from 'chalk';
import { configDotenv } from 'dotenv';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type * as yargs from 'yargs';
import { parseJsonInputRecord } from '../commandInputs.js';
import {
  loadProjectRuntime,
  resolveServedGraphName,
  throwIfInvalidGraph,
  throwIfNoMainGraph,
  withRuntimeProcessorOptions,
  type DatasetCliOptions,
  type LoadedProjectRuntime,
} from '../cliRuntime.js';
import {
  CliHttpError,
  createHttpMiddleware,
  formatListenUrl,
  jsonErrorResponse,
  jsonTimedResponse,
  type HttpCliOptions,
} from '../http.js';
import { shapeOutputs } from '../output.js';

export type ServeArgs = {
  allowSpecifyingGraphId: boolean;
  dev: boolean;
  endpoint: string[];
  exposeCost: boolean;
  graph: string | undefined;
  host: string;
  openaiApiKey: string | undefined;
  openaiEndpoint: string | undefined;
  openaiOrganization: string | undefined;
  port: number;
  projectFile: string | undefined;
  stream: string | undefined;
  streamNode: string | undefined;
  unwrapOutput: string | undefined;
} & DatasetCliOptions &
  HttpCliOptions;

type GraphRunArgs = {
  exposeCost: boolean;
  graph: string | undefined;
  inputs: Record<string, LooseDataValue>;
  openaiApiKey: string | undefined;
  openaiEndpoint: string | undefined;
  openaiOrganization: string | undefined;
  project: Project;
  runtime: Pick<LoadedProjectRuntime, 'datasetProvider' | 'projectPath'>;
  unwrapOutput: string | undefined;
};

type GraphProcessorArgs = Omit<GraphRunArgs, 'exposeCost' | 'project' | 'runtime' | 'unwrapOutput'>;

export type ServeAppInfo = {
  app: Hono;
  projectFilePath: string;
  servedGraphName: string;
};

export function makeCommand<T>(y: yargs.Argv<T>) {
  return y
    .option('port', {
      describe: 'The port to serve on',
      type: 'number',
      default: 3000,
    })
    .option('host', {
      describe: 'The host interface to bind to',
      type: 'string',
      default: '0.0.0.0',
    })
    .option('dev', {
      describe: 'Run in development mode: rereads the project file on each request',
      type: 'boolean',
      default: false,
    })
    .option('graph', {
      describe: 'The ID or name of the graph to run. If omitted, the main graph is used.',
      type: 'string',
      demandOption: false,
    })
    .option('allow-specifying-graph-id', {
      describe: 'Allow specifying the graph ID in the URL path',
      type: 'boolean',
      default: false,
    })
    .option('endpoint', {
      describe: 'Expose a named endpoint alias using endpointName=graphNameOrId',
      type: 'string',
      array: true,
      default: [],
    })
    .option('bearer-token', {
      describe: 'Require Authorization: Bearer <token>. Defaults to RIVET_CLI_BEARER_TOKEN.',
      type: 'string',
    })
    .option('cors-origin', {
      describe: 'Allow a CORS origin. Can be repeated, or set to *.',
      type: 'string',
      array: true,
      default: [],
    })
    .option('dataset-file', {
      describe: 'Use a specific .rivet-data file instead of the project-adjacent default',
      type: 'string',
    })
    .option('save-datasets', {
      describe: 'Persist dataset mutations back to the dataset file',
      type: 'boolean',
      default: false,
    })
    .option('require-dataset-file', {
      describe: 'Fail if the dataset file does not exist',
      type: 'boolean',
      default: false,
    })
    .option('openai-api-key', {
      describe:
        'The OpenAI API key to use for the project. If omitted, the environment variable OPENAI_API_KEY is used.',
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
    })
    .option('expose-cost', {
      describe: 'Expose the cost of the graph run in the response',
      type: 'boolean',
      default: false,
    })
    .option('unwrap-output', {
      describe: 'Respond with only the .value field from one named output',
      type: 'string',
    })
    .option('stream', {
      describe:
        'Turns on streaming mode. Rivet events will be sent to the client using SSE (Server-Sent Events). If this is set to a Node ID or node title, only events for that node will be sent.',
      type: 'string',
      demandOption: false,
    })
    .option('stream-node', {
      describe: 'Streams the partial outputs of a specific node. Requires --stream to be set.',
      type: 'string',
      demandOption: false,
    })
    .positional('projectFile', {
      describe:
        'The project file to serve. If omitted, the project file in the current directory is used. There cannot be multiple project files in the current directory.',
      type: 'string',
      demandOption: false,
    });
}

export async function serve(args: ServeArgs) {
  try {
    configDotenv();

    const { app, projectFilePath, servedGraphName } = await createServeApp(args);
    const server = serveHono({
      hostname: args.host,
      port: args.port,
      fetch: app.fetch,
    });

    console.log(
      chalk.green(
        `Serving project file ${chalk.bold.white(projectFilePath)} at ${chalk.bold.white(
          formatListenUrl(args.host, args.port),
        )}.\nServing graph "${chalk.bold.white(servedGraphName)}".`,
      ),
    );

    function shutdown() {
      console.log('Shutting down...');

      server.close((err) => {
        if (err) {
          console.error(err);
          process.exit(1);
        }

        process.exit(0);
      });
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(chalk.red(err));
    process.exit(1);
  }
}

export async function createServeApp(args: ServeArgs): Promise<ServeAppInfo> {
  const runtime = await loadProjectRuntime(args.projectFile, args);
  const endpointAliases = parseEndpointAliases(args.endpoint, runtime.project);

  throwIfNoMainGraph(runtime.project, args.graph, runtime.projectPath);
  throwIfInvalidGraph(runtime.project, args.graph);

  if (args.stream != null) {
    console.log('Streaming is enabled');
  }

  if (args.streamNode != null) {
    if (args.stream == null) {
      throw new Error('--stream-node requires --stream.');
    }

    console.log(`Streaming node ${chalk.bold(args.streamNode)}`);
  }

  const app = new Hono();
  app.use('*', createHttpMiddleware(args));
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      projectPath: runtime.projectPath,
    }),
  );

  app.post('/', async (c) => handleGraphRequest(c, args, runtime, args.graph));

  app.post('/endpoints/:endpointName', async (c) => {
    const endpointName = c.req.param('endpointName');
    const graph = endpointAliases.get(endpointName);

    if (!graph) {
      return jsonErrorResponse(c, new CliHttpError(`Endpoint "${endpointName}" not found.`, 404), Date.now(), 404);
    }

    return handleGraphRequest(c, args, runtime, graph);
  });

  if (args.allowSpecifyingGraphId) {
    app.post('/:graphId', async (c) => handleGraphRequest(c, args, runtime, c.req.param('graphId')));
  }

  return {
    app,
    projectFilePath: runtime.projectPath,
    servedGraphName: resolveServedGraphName(runtime.project, args.graph),
  };
}

async function handleGraphRequest(
  c: Context,
  args: ServeArgs,
  runtime: LoadedProjectRuntime,
  graph: string | undefined,
): Promise<Response> {
  const startedAt = Date.now();
  let graphRunArgs: GraphRunArgs;

  try {
    const project = args.dev ? await loadProjectFromFile(runtime.projectPath) : runtime.project;
    throwIfInvalidGraph(project, graph);

    const inputs = parseJsonInputRecord(await c.req.text(), 'Request body');
    graphRunArgs = buildGraphRunArgs(args, runtime, project, inputs, graph);
  } catch (error) {
    return jsonErrorResponse(c, toBadRequestError(error), startedAt, 400);
  }

  try {
    if (args.stream != null) {
      const stream = await streamGraph({
        ...graphRunArgs,
        stream: args.stream,
        streamNode: args.streamNode,
      });

      return new Response(stream, {
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream',
        },
      });
    }

    return jsonTimedResponse(c, await runGraph(graphRunArgs), startedAt);
  } catch (error) {
    return jsonErrorResponse(c, error, startedAt, 500);
  }
}

function buildGraphRunArgs(
  args: ServeArgs,
  runtime: Pick<LoadedProjectRuntime, 'datasetProvider' | 'projectPath'>,
  project: Project,
  inputs: Record<string, LooseDataValue>,
  graph: string | undefined,
): GraphRunArgs {
  return {
    exposeCost: args.exposeCost,
    graph,
    inputs,
    openaiApiKey: args.openaiApiKey,
    openaiEndpoint: args.openaiEndpoint,
    openaiOrganization: args.openaiOrganization,
    project,
    runtime,
    unwrapOutput: args.unwrapOutput,
  };
}

async function streamGraph({
  project,
  inputs,
  graph,
  openaiApiKey,
  openaiEndpoint,
  openaiOrganization,
  runtime,
  stream,
  streamNode,
}: GraphRunArgs & { stream: string | undefined; streamNode: string | undefined }): Promise<ReadableStream> {
  const { run, processor, getSSEStream } = createProcessor(
    project,
    withRuntimeProcessorOptions(
      runtime,
      buildStreamingGraphProcessorOptions({
        graph,
        inputs,
        openaiApiKey,
        openaiEndpoint,
        openaiOrganization,
      }),
    ),
  );

  const responseStream = streamNode
    ? getSingleNodeStream(processor, streamNode)
    : getSSEStream(buildStreamEventFilter(stream));

  run().catch((err) => {
    console.error(err);
  });

  return responseStream;
}

export function buildGraphProcessorOptions({
  inputs,
  graph,
  openaiApiKey,
  openaiEndpoint,
  openaiOrganization,
}: GraphProcessorArgs): NodeCreateProcessorOptions {
  return {
    graph,
    inputs,
    openAiEndpoint: openaiEndpoint,
    openAiKey: openaiApiKey,
    openAiOrganization: openaiOrganization,
  };
}

export function buildStreamingGraphProcessorOptions(args: GraphProcessorArgs): NodeCreateProcessorOptions {
  return {
    ...buildGraphProcessorOptions(args),
    runtimeProfile: 'compatible',
  };
}

export function buildStreamEventFilter(stream: string | undefined): RivetEventStreamFilterSpec {
  const streamTarget = stream?.trim();

  if (!streamTarget) {
    return {
      nodeFinish: true,
      nodeStart: true,
      partialOutputs: true,
    };
  }

  return {
    nodeFinish: [streamTarget],
    nodeStart: [streamTarget],
    partialOutputs: [streamTarget],
  };
}

async function runGraph({
  project,
  inputs,
  graph,
  openaiApiKey,
  openaiEndpoint,
  openaiOrganization,
  exposeCost,
  runtime,
  unwrapOutput,
}: GraphRunArgs): Promise<unknown> {
  const { run } = createProcessor(
    project,
    withRuntimeProcessorOptions(
      runtime,
      buildGraphProcessorOptions({
        graph,
        inputs,
        openaiApiKey,
        openaiEndpoint,
        openaiOrganization,
      }),
    ),
  );

  return shapeOutputs(await run(), {
    includeCost: exposeCost,
    unwrapOutput,
  });
}

export function parseEndpointAliases(endpointSpecs: string[], project: Project): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const spec of endpointSpecs) {
    const separatorIndex = spec.indexOf('=');

    if (separatorIndex <= 0) {
      throw new Error(`Invalid endpoint "${spec}". Expected endpointName=graphNameOrId.`);
    }

    const endpointName = spec.slice(0, separatorIndex).trim();
    const graph = spec.slice(separatorIndex + 1).trim();

    if (!endpointName || endpointName.includes('/')) {
      throw new Error(`Invalid endpoint name "${endpointName}". Endpoint names cannot be empty or contain "/".`);
    }

    if (!graph) {
      throw new Error(`Invalid endpoint "${spec}". Expected a graph name or ID after "=".`);
    }

    if (aliases.has(endpointName)) {
      throw new Error(`Duplicate endpoint "${endpointName}".`);
    }

    throwIfInvalidGraph(project, graph);
    aliases.set(endpointName, graph);
  }

  return aliases;
}

function toBadRequestError(error: unknown): CliHttpError {
  if (error instanceof CliHttpError) {
    return error;
  }

  return new CliHttpError(error instanceof Error ? error.message : String(error), 400);
}
