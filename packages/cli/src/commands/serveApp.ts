import { createRivetWebAppHandler } from '@valerypopoff/rivet2-node';
import chalk from 'chalk';
import { configDotenv } from 'dotenv';
import { Hono } from 'hono';
import type * as yargs from 'yargs';
import {
  addDatasetOptions,
  addProviderOptions,
  loadProjectRuntime,
  resolveUiGraph,
  warnIfServerSavesDatasets,
  withCliProcessorOptions,
  type DatasetCliOptions,
  type LoadedProjectRuntime,
  type ProviderCliOptions,
} from '../cliRuntime.js';
import {
  addHttpOptions,
  createHttpMiddleware,
  formatListenUrl,
  jsonErrorResponse,
  startHttpServer,
  type HttpCliOptions,
} from '../http.js';

export type ServeAppArgs = {
  basePath: string;
  dev: boolean;
  host: string;
  port: number;
  projectFile: string;
  revisionKey: string | undefined;
  uiGraph: string | undefined;
} & DatasetCliOptions &
  ProviderCliOptions &
  HttpCliOptions;

export type WebAppServeInfo = {
  app: Hono;
  projectFilePath: string;
  uiGraphName: string;
};

export function makeCommand<T>(y: yargs.Argv<T>) {
  const command = addHttpOptions(
    addProviderOptions(y)
      .positional('projectFile', {
        describe: 'The project file containing the Rivet web app',
        type: 'string',
        demandOption: true,
      })
      .positional('uiGraph', {
        describe: 'The web app name or ID to serve. If omitted, the only web app in the project is used.',
        type: 'string',
      })
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
      .option('base-path', {
        describe: 'The URL base path where the web app is mounted',
        type: 'string',
        default: '/',
      })
      .option('dev', {
        describe: 'Run in development mode: rereads the project file on each request',
        type: 'boolean',
        default: false,
      })
      .option('revision-key', {
        describe: 'Opaque revision key embedded in HTML and checked on action requests',
        type: 'string',
      }),
  );

  return addDatasetOptions(command);
}

export async function serveApp(args: ServeAppArgs) {
  configDotenv();

  const { app, projectFilePath, uiGraphName } = await createWebAppServeApp(args);
  startHttpServer(app, args.host, args.port);

  console.log(
    chalk.green(
      `Serving Rivet web app "${chalk.bold.white(uiGraphName)}" from ${chalk.bold.white(
        projectFilePath,
      )} at ${chalk.bold.white(formatListenUrl(args.host, args.port))}.`,
    ),
  );
}

export async function createWebAppServeApp(args: ServeAppArgs): Promise<WebAppServeInfo> {
  throwIfReservedBasePath(args.basePath);

  const runtime = await loadProjectRuntime(args.projectFile, args);
  const uiGraph = resolveUiGraph(runtime.project, args.uiGraph);
  const staticHandler = args.dev ? undefined : createHandler(runtime, args, uiGraph.id);

  warnIfWebAppBearerTokenIsConfigured(args);
  warnIfServerSavesDatasets(args.saveDatasets, 'CLI web-app server');

  const app = new Hono();
  app.use('*', createHttpMiddleware(args));
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      projectPath: runtime.projectPath,
      uiGraphId: uiGraph.id,
    }),
  );
  app.all('*', async (c) => {
    const startedAt = Date.now();

    try {
      const handler = staticHandler ?? createHandler(await loadProjectRuntime(args.projectFile, args), args, uiGraph.id);
      return handler.handleRequest(c.req.raw);
    } catch (error) {
      return jsonErrorResponse(c, error, startedAt, 500);
    }
  });

  return {
    app,
    projectFilePath: runtime.projectPath,
    uiGraphName: uiGraph.name,
  };
}

function createHandler(
  runtime: LoadedProjectRuntime,
  args: ServeAppArgs,
  uiGraphId = resolveUiGraph(runtime.project, args.uiGraph).id,
) {
  return createRivetWebAppHandler(runtime.project, {
    basePath: args.basePath,
    createProcessorOptions: () => withCliProcessorOptions(runtime, args, {}),
    revisionKey: args.revisionKey,
    uiGraphId,
  });
}

function throwIfReservedBasePath(basePath: string): void {
  const normalizedBasePath = `/${basePath}`.replace(/\/+/g, '/').replace(/\/$/, '');

  if (normalizedBasePath === '/healthz') {
    throw new Error('--base-path /healthz is reserved for the CLI health endpoint.');
  }
}

function warnIfWebAppBearerTokenIsConfigured(args: ServeAppArgs): void {
  if (!args.bearerToken && !process.env.RIVET_CLI_BEARER_TOKEN) {
    return;
  }

  console.warn(
    chalk.yellow(
      'serve-app bearer-token auth expects clients to send Authorization headers. Browser navigation to the app HTML cannot add that header by itself; use a reverse proxy or cookie auth for browser-facing deployments.',
    ),
  );
}
