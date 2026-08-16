#!/usr/bin/env node
import chalk from 'chalk';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  inspect,
  list,
  makeInspectCommand,
  makeListCommand,
  type ProjectListArgs,
} from './commands/list.js';
import { doctor, makeDoctorCommand, type DoctorArgs } from './commands/doctor.js';
import { makeCommand as makeRunCommand, run } from './commands/run.js';
import { makeCommand as makeServeCommand, serve } from './commands/serve.js';
import { makeCommand as makeServeAppCommand, serveApp } from './commands/serveApp.js';
import { EvaluationCliError, makeEvaluationCommand, runEvaluation } from './commands/evaluations.js';

await yargs(hideBin(process.argv))
  .command(
    'evaluations run',
    'Run a named Evaluation suite.',
    (y) => makeEvaluationCommand(y),
    (args) => runCli(() => runEvaluation(args as never)),
  )
  .command(
    'list <projectFile>',
    'List graphs, web apps, library nodes, and plugins in a project file.',
    (y) => makeListCommand(y),
    (args) => runCli(() => list(args as ProjectListArgs)),
  )
  .command(
    'inspect <projectFile>',
    'Print a machine-readable project summary.',
    (y) => makeInspectCommand(y),
    (args) => runCli(() => inspect(args.projectFile as string)),
  )
  .command(
    'doctor <projectFile>',
    'Check a project file for common CLI/runtime problems.',
    (y) => makeDoctorCommand(y),
    (args) => runCli(() => doctor(args as DoctorArgs)),
  )
  .command(
    'run <projectFile> [graphName]',
    'Run a graph in a project file, or the main graph if graphName is not specified.',
    (y) => makeRunCommand(y),
    (args) => runCli(() => run(args)),
  )
  .command(
    'serve [projectFile]',
    'Serve a project file as a REST API.',
    (y) => makeServeCommand(y),
    (args) => runCli(() => serve(args)),
  )
  .command(
    'serve-app <projectFile> [uiGraph]',
    'Serve a project-contained Rivet web app.',
    (y) => makeServeAppCommand(y),
    (args) => runCli(() => serveApp(args)),
  )
  .completion('completion', 'Generate a shell completion script.')
  .demandCommand()
  .parseAsync();

async function runCli(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(chalk.red(formatCliError(err)));
    process.exit(err instanceof EvaluationCliError ? err.exitCode : 1);
  }
}

function formatCliError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  if (!process.env.RIVET_CLI_DEBUG || !stack) {
    return `Error: ${message}`;
  }

  return `Error: ${message}\n\n${stack}`;
}
