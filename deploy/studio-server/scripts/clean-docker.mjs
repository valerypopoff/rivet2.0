import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export const CLEAN_CONFIRMATION_FLAG = '--confirm-host-prune';
export const DRY_RUN_FLAG = '--dry-run';
export const ALLOW_REMOTE_DOCKER_HOST_FLAG = '--allow-remote-docker-host';

const CONFIRMATION_TOKEN = 'PRUNE';
const LOCAL_DOCKER_ENDPOINT_PREFIXES = ['npipe://', 'unix://'];

export const CLEANUP_COMMANDS = [
  { label: 'Removing stopped containers', args: ['container', 'prune', '--force'] },
  { label: 'Removing unused networks', args: ['network', 'prune', '--force'] },
  { label: 'Removing unused images', args: ['image', 'prune', '--all', '--force'] },
  { label: 'Removing unused builder cache', args: ['builder', 'prune', '--all', '--force'] },
];

const PREFLIGHT_COMMANDS = [
  {
    label: 'Docker disk usage before cleanup',
    args: ['system', 'df'],
  },
  {
    label: 'Stopped containers Docker may remove',
    args: [
      'container',
      'ls',
      '--all',
      '--filter',
      'status=created',
      '--filter',
      'status=exited',
      '--filter',
      'status=dead',
      '--format',
      '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}',
    ],
    maxOutputRows: 20,
  },
  {
    label: 'Custom networks Docker will evaluate for pruning',
    args: ['network', 'ls', '--filter', 'type=custom', '--format', '{{.ID}}\t{{.Name}}\t{{.Driver}}\t{{.Scope}}'],
    maxOutputRows: 20,
  },
  {
    label: 'Images Docker will evaluate for pruning',
    args: ['image', 'ls', '--all', '--format', '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}'],
    maxOutputRows: 20,
  },
];

export class CleanDockerError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Run one Docker CLI command without shell interpolation. The cleanup command
 * intentionally accepts Docker's normal environment/context selection, but
 * every Docker argument is a static argv token owned by this module.
 */
export function createDockerRunner({ cwd = process.cwd(), environment = process.env, spawnProcess = spawn } = {}) {
  return (args, { capture = false } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawnProcess('docker', args, {
        cwd,
        env: environment,
        shell: false,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      });

      let stdout = '';
      let stderr = '';
      if (capture) {
        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on('data', (chunk) => {
          stderr += String(chunk);
        });
      }

      child.once('error', (error) => reject(new CleanDockerError(`Could not start Docker: ${error.message}`)));
      child.once('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const detail = stderr.trim() ? `\n${stderr.trim()}` : '';
        reject(
          new CleanDockerError(
            `Docker command failed (${formatDockerCommand(args)}): exit code ${code ?? 1}.${detail}`,
          ),
        );
      });
    });
}

export function parseCleanupArguments(args) {
  const options = {
    allowRemoteDockerHost: false,
    confirmHostPrune: false,
    dryRun: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === ALLOW_REMOTE_DOCKER_HOST_FLAG) {
      options.allowRemoteDockerHost = true;
    } else if (arg === CLEAN_CONFIRMATION_FLAG) {
      options.confirmHostPrune = true;
    } else if (arg === DRY_RUN_FLAG) {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new CleanDockerError(`Unknown option: ${arg}\n\n${usageText()}`, 2);
    }
  }

  if (options.help && args.length > 1) {
    throw new CleanDockerError(`--help cannot be combined with other options.\n\n${usageText()}`, 2);
  }
  if (options.dryRun && (options.confirmHostPrune || options.allowRemoteDockerHost)) {
    throw new CleanDockerError(
      `${DRY_RUN_FLAG} cannot be combined with ${CLEAN_CONFIRMATION_FLAG} or ${ALLOW_REMOTE_DOCKER_HOST_FLAG}.\n\n${usageText()}`,
      2,
    );
  }
  if (options.allowRemoteDockerHost && !options.confirmHostPrune) {
    throw new CleanDockerError(
      `${ALLOW_REMOTE_DOCKER_HOST_FLAG} requires ${CLEAN_CONFIRMATION_FLAG}.\n\n${usageText()}`,
      2,
    );
  }

  return options;
}

export async function resolveDockerTarget({ environment = process.env, runDocker }) {
  const configuredContext = environment.DOCKER_CONTEXT?.trim();
  const configuredHost = environment.DOCKER_HOST?.trim();

  if (configuredContext) {
    return {
      context: configuredContext,
      endpoint: await inspectDockerContext(configuredContext, runDocker),
      source: 'DOCKER_CONTEXT',
    };
  }

  if (configuredHost) {
    return {
      context: '(selected by DOCKER_HOST)',
      endpoint: configuredHost,
      source: 'DOCKER_HOST',
    };
  }

  const currentContext = (await runDocker(['context', 'show'], { capture: true })).stdout.trim();
  if (!currentContext) {
    throw new CleanDockerError('Docker did not report a current context. Refusing to choose a cleanup target.', 2);
  }

  return {
    context: currentContext,
    endpoint: await inspectDockerContext(currentContext, runDocker),
    source: 'current Docker context',
  };
}

export function isLocalDockerEndpoint(endpoint) {
  const normalizedEndpoint = endpoint.trim().toLowerCase();
  return LOCAL_DOCKER_ENDPOINT_PREFIXES.some((prefix) => normalizedEndpoint.startsWith(prefix));
}

export async function runCleanDocker({
  args = process.argv.slice(2),
  environment = process.env,
  io = createDefaultIo(),
  runDocker = createDockerRunner({ environment }),
} = {}) {
  const options = parseCleanupArguments(args);
  if (options.help) {
    io.log(usageText());
    return { status: 'help' };
  }

  const target = await resolveDockerTarget({ environment, runDocker });
  const isLocalTarget = isLocalDockerEndpoint(target.endpoint);
  if (!isLocalTarget && !(options.allowRemoteDockerHost && options.confirmHostPrune)) {
    throw new CleanDockerError(
      [
        `Refusing to prune non-local Docker endpoint ${target.endpoint} (${target.source}: ${target.context}).`,
        `Use ${ALLOW_REMOTE_DOCKER_HOST_FLAG} together with ${CLEAN_CONFIRMATION_FLAG} only when you intentionally mean to clean that remote Docker host.`,
      ].join('\n'),
      2,
    );
  }

  io.log(`[clean] Docker context: ${target.context} (${target.source})`);
  io.log(`[clean] Docker endpoint: ${target.endpoint}`);
  io.log('[clean] This is Docker-host-wide cleanup. It can affect other projects on the selected Docker host.');
  io.log('[clean] Docker volumes and bind-mounted files are not prune targets.');

  const targetRunner = createTargetRunner(runDocker, target);
  await runPreflight(targetRunner, io);

  if (options.dryRun) {
    io.log('[clean] Dry run complete. No Docker resources were removed.');
    return { status: 'dry-run', target };
  }

  const authorized = options.confirmHostPrune || (io.isInteractive && (await io.confirm(CONFIRMATION_TOKEN)));
  if (!authorized) {
    if (io.isInteractive) {
      io.log('[clean] Cleanup cancelled. No Docker resources were removed.');
      return { status: 'cancelled', target };
    }

    throw new CleanDockerError(
      `Refusing to prune from a non-interactive terminal without ${CLEAN_CONFIRMATION_FLAG}. No Docker resources were removed.`,
      2,
    );
  }

  const completedSteps = [];
  try {
    for (const command of CLEANUP_COMMANDS) {
      io.log(`[clean] ${command.label}...`);
      await targetRunner(command.args);
      completedSteps.push(command.label);
    }
  } catch (error) {
    const completed = completedSteps.length > 0 ? completedSteps.join(', ') : 'none';
    throw new CleanDockerError(
      `[clean] Cleanup stopped after completing: ${completed}. Earlier removals cannot be rolled back.\n${error.message}`,
      error.exitCode ?? 1,
    );
  }

  io.log('[clean] Docker disk usage after cleanup:');
  try {
    const result = await targetRunner(['system', 'df'], { capture: true });
    printCapturedOutput(result.stdout, io);
  } catch (error) {
    io.error(`[clean] Cleanup succeeded, but Docker disk usage could not be measured afterward: ${error.message}`);
  }
  io.log('[clean] Done. Docker volumes were not pruned.');
  return { status: 'cleaned', target };
}

function createTargetRunner(runDocker, target) {
  if (target.source !== 'current Docker context') {
    return runDocker;
  }

  // `docker context use` mutates the Docker CLI's default between separate
  // processes. Pin the inspected context so a concurrent change cannot
  // retarget the preflight or a confirmed cleanup.
  const contextFlag = `--context=${target.context}`;
  return (args, options) => runDocker([contextFlag, ...args], options);
}

async function inspectDockerContext(context, runDocker) {
  const result = await runDocker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], {
    capture: true,
  });
  const endpoint = result.stdout.trim();
  if (!endpoint) {
    throw new CleanDockerError(
      `Docker context ${context} did not report an endpoint. Refusing to choose a cleanup target.`,
      2,
    );
  }
  return endpoint;
}

async function runPreflight(runDocker, io) {
  try {
    const version = await runDocker(['version', '--format', '{{.Server.Version}}'], { capture: true });
    io.log(`[clean] Docker daemon version: ${version.stdout.trim() || '(not reported)'}`);

    for (const command of PREFLIGHT_COMMANDS) {
      io.log(`[clean] ${command.label}:`);
      const result = await runDocker(command.args, { capture: true });
      printCapturedOutput(result.stdout, io, command.maxOutputRows);
    }
  } catch (error) {
    throw new CleanDockerError(
      `[clean] Preflight failed. No Docker resources were removed.\n${error.message}`,
      error.exitCode ?? 1,
    );
  }

  io.log(
    '[clean] Docker decides the exact prune candidates at execution time; resources may change after this preflight.',
  );
}

function printCapturedOutput(output, io, maxOutputRows) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    io.log('(none)');
    return;
  }

  if (maxOutputRows === undefined) {
    io.log(lines.join('\n'));
    return;
  }

  if (lines.length <= maxOutputRows) {
    io.log(`${lines.length} rows:`);
    io.log(lines.join('\n'));
    return;
  }

  io.log(`${lines.length} rows; showing the first ${maxOutputRows}:`);
  io.log(lines.slice(0, maxOutputRows).join('\n'));
  io.log(`${lines.length - maxOutputRows} additional rows omitted from the terminal preview.`);
}

function createDefaultIo() {
  return {
    confirm: promptForConfirmation,
    error: (message) => console.error(message),
    isInteractive: process.stdin.isTTY === true,
    log: (message) => console.log(message),
  };
}

async function promptForConfirmation(expectedToken) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const response = await readline.question(`[clean] Type ${expectedToken} to prune this Docker host: `);
    return response.trim() === expectedToken;
  } finally {
    readline.close();
  }
}

function formatDockerCommand(args) {
  return `docker ${args.join(' ')}`;
}

export function usageText() {
  return [
    'Usage: yarn studio-server:clean [options]',
    '',
    `  ${DRY_RUN_FLAG}                      Show the selected host and cleanup impact without removing anything.`,
    `  ${CLEAN_CONFIRMATION_FLAG}           Authorize host-wide cleanup without an interactive prompt.`,
    `  ${ALLOW_REMOTE_DOCKER_HOST_FLAG}    Allow a non-local Docker endpoint; requires ${CLEAN_CONFIRMATION_FLAG}.`,
    '',
    'Without --confirm-host-prune, an interactive terminal must type PRUNE after preflight.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCleanDocker().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
