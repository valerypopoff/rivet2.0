#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { makeCommand as makeRunCommand, run } from './commands/run.js';
import { makeCommand as makeServeCommand, serve } from './commands/serve.js';
import { makeCommand as makeServeAppCommand, serveApp } from './commands/serveApp.js';

await yargs(hideBin(process.argv))
  .command(
    'run <projectFile> [graphName]',
    'Run a graph in a project file, or the main graph if graphName is not specified.',
    (y) => makeRunCommand(y),
    (args) => run(args),
  )
  .command(
    'serve [projectFile]',
    'Serve a project file as a REST API.',
    (y) => makeServeCommand(y),
    (args) => serve(args),
  )
  .command(
    'serve-app <projectFile> [uiGraph]',
    'Serve a project-contained Rivet web app.',
    (y) => makeServeAppCommand(y),
    (args) => serveApp(args),
  )
  .demandCommand()
  .parseAsync();
