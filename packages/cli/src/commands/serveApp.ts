import { serve as serveHono } from '@hono/node-server';
import { createRivetWebAppHandler } from '@valerypopoff/rivet2-node';
import chalk from 'chalk';
import { configDotenv } from 'dotenv';
import { Hono } from 'hono';
import type * as yargs from 'yargs';
import {
  loadProjectRuntime,
  resolveUiGraph,
  withRuntimeProcessorOptions,
  type DatasetCliOptions,
} from '../cliRuntime.js';
import { createHttpMiddleware, formatListenUrl, type HttpCliOptions } from '../http.js';

export type ServeAppArgs = {
  basePath: string;
  host: string;
  port: number;
  projectFile: string;
  revisionKey: string | undefined;
  uiGraph: string | undefined;
} & DatasetCliOptions &
  HttpCliOptions;

export type WebAppServeInfo = {
  app: Hono;
  projectFilePath: string;
  uiGraphName: string;
};

export function makeCommand<T>(y: yargs.Argv<T>) {
  return y
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
    .option('revision-key', {
      describe: 'Opaque revision key embedded in HTML and checked on action requests',
      type: 'string',
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
    });
}

export async function serveApp(args: ServeAppArgs) {
  try {
    configDotenv();

    const { app, projectFilePath, uiGraphName } = await createWebAppServeApp(args);
    const server = serveHono({
      hostname: args.host,
      port: args.port,
      fetch: app.fetch,
    });

    console.log(
      chalk.green(
        `Serving Rivet web app "${chalk.bold.white(uiGraphName)}" from ${chalk.bold.white(
          projectFilePath,
        )} at ${chalk.bold.white(formatListenUrl(args.host, args.port))}.`,
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

export async function createWebAppServeApp(args: ServeAppArgs): Promise<WebAppServeInfo> {
  throwIfReservedBasePath(args.basePath);

  const runtime = await loadProjectRuntime(args.projectFile, args);
  const uiGraph = resolveUiGraph(runtime.project, args.uiGraph);
  const handler = createRivetWebAppHandler(runtime.project, {
    basePath: args.basePath,
    createProcessorOptions: () => withRuntimeProcessorOptions(runtime, {}),
    revisionKey: args.revisionKey,
    uiGraphId: uiGraph.id,
  });

  const app = new Hono();
  app.use('*', createHttpMiddleware(args));
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      projectPath: runtime.projectPath,
      uiGraphId: uiGraph.id,
    }),
  );
  app.all('*', (c) => handler.handleRequest(c.req.raw));

  return {
    app,
    projectFilePath: runtime.projectPath,
    uiGraphName: uiGraph.name,
  };
}

function throwIfReservedBasePath(basePath: string): void {
  const normalizedBasePath = `/${basePath}`.replace(/\/+/g, '/').replace(/\/$/, '');

  if (normalizedBasePath === '/healthz') {
    throw new Error('--base-path /healthz is reserved for the CLI health endpoint.');
  }
}
