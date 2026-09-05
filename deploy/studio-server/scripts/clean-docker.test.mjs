import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  ALLOW_REMOTE_DOCKER_HOST_FLAG,
  CLEAN_CONFIRMATION_FLAG,
  CLEANUP_COMMANDS,
  CleanDockerError,
  DRY_RUN_FLAG,
  createDockerRunner,
  isLocalDockerEndpoint,
  parseCleanupArguments,
  resolveDockerTarget,
  runCleanDocker,
} from './clean-docker.mjs';

const LOCAL_ENVIRONMENT = { DOCKER_HOST: 'npipe:////./pipe/docker_engine' };

function createFakeRunner({ failCommand, responses = {} } = {}) {
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    const command = args.join(' ');
    if (command === failCommand) {
      throw new CleanDockerError(`simulated failure: ${command}`);
    }
    return { stderr: '', stdout: responses[command] ?? `${command}\n` };
  };
  return { calls, runDocker };
}

function createIo({ confirm = async () => false, isInteractive = false } = {}) {
  const errors = [];
  const logs = [];
  return {
    confirm,
    errors,
    error: (message) => errors.push(message),
    isInteractive,
    log: (message) => logs.push(message),
    logs,
  };
}

function cleanupCalls(calls) {
  return calls.filter((args) => CLEANUP_COMMANDS.some((command) => sameArguments(args, command.args)));
}

function sameArguments(left, right) {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function expectedPreflightCalls() {
  return [
    ['version', '--format', '{{.Server.Version}}'],
    ['system', 'df'],
    [
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
    ['network', 'ls', '--filter', 'type=custom', '--format', '{{.ID}}\t{{.Name}}\t{{.Driver}}\t{{.Scope}}'],
    ['image', 'ls', '--all', '--format', '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}'],
  ];
}

test('cleanup flags reject accidental or contradictory authorization', () => {
  assert.deepEqual(parseCleanupArguments([]), {
    allowRemoteDockerHost: false,
    confirmHostPrune: false,
    dryRun: false,
    help: false,
  });
  assert.throws(() => parseCleanupArguments(['--unexpected']), /Unknown option/);
  assert.throws(() => parseCleanupArguments([DRY_RUN_FLAG, CLEAN_CONFIRMATION_FLAG]), /cannot be combined/);
  assert.throws(() => parseCleanupArguments([ALLOW_REMOTE_DOCKER_HOST_FLAG]), /requires --confirm-host-prune/);
});

test('cleanup only treats local Docker socket endpoints as local', () => {
  assert.equal(isLocalDockerEndpoint('npipe:////./pipe/docker_engine'), true);
  assert.equal(isLocalDockerEndpoint('unix:///var/run/docker.sock'), true);
  assert.equal(isLocalDockerEndpoint('ssh://builder.example.test'), false);
  assert.equal(isLocalDockerEndpoint('tcp://127.0.0.1:2376'), false);
});

test('Docker context selection honors Docker CLI environment precedence without shell interpolation', async () => {
  const explicitContext = createFakeRunner({
    responses: { 'context inspect staging --format {{.Endpoints.docker.Host}}': 'ssh://staging.example.test\n' },
  });
  assert.deepEqual(
    await resolveDockerTarget({
      environment: { DOCKER_CONTEXT: 'staging', DOCKER_HOST: 'tcp://ignored.example.test:2376' },
      runDocker: explicitContext.runDocker,
    }),
    { context: 'staging', endpoint: 'ssh://staging.example.test', source: 'DOCKER_CONTEXT' },
  );
  assert.deepEqual(explicitContext.calls, [
    ['context', 'inspect', 'staging', '--format', '{{.Endpoints.docker.Host}}'],
  ]);

  const hostOverride = createFakeRunner();
  assert.deepEqual(
    await resolveDockerTarget({
      environment: { DOCKER_HOST: 'unix:///tmp/docker.sock' },
      runDocker: hostOverride.runDocker,
    }),
    { context: '(selected by DOCKER_HOST)', endpoint: 'unix:///tmp/docker.sock', source: 'DOCKER_HOST' },
  );
  assert.deepEqual(hostOverride.calls, []);
});

test('dry-run performs a host-wide preflight but never runs a prune command', async () => {
  const docker = createFakeRunner();
  const io = createIo();

  const result = await runCleanDocker({
    args: [DRY_RUN_FLAG],
    environment: LOCAL_ENVIRONMENT,
    io,
    runDocker: docker.runDocker,
  });

  assert.equal(result.status, 'dry-run');
  assert.deepEqual(cleanupCalls(docker.calls), []);
  assert.match(io.logs.join('\n'), /Docker-host-wide cleanup/);
  assert.match(io.logs.join('\n'), /No Docker resources were removed/);
});

test('the current Docker context is pinned after target inspection', async () => {
  const docker = createFakeRunner({
    responses: {
      'context show': 'desktop-linux\n',
      'context inspect desktop-linux --format {{.Endpoints.docker.Host}}': 'npipe:////./pipe/docker_engine\n',
    },
  });

  await runCleanDocker({
    args: [CLEAN_CONFIRMATION_FLAG],
    environment: {},
    io: createIo(),
    runDocker: docker.runDocker,
  });

  assert.deepEqual(docker.calls, [
    ['context', 'show'],
    ['context', 'inspect', 'desktop-linux', '--format', '{{.Endpoints.docker.Host}}'],
    ...expectedPreflightCalls().map((args) => ['--context=desktop-linux', ...args]),
    ...CLEANUP_COMMANDS.map((command) => ['--context=desktop-linux', ...command.args]),
    ['--context=desktop-linux', 'system', 'df'],
  ]);
});

test('preflight caps large inventories without hiding their total count', async () => {
  const imageRows = Array.from({ length: 21 }, (_, index) => `image-${index}`).join('\n');
  const docker = createFakeRunner({
    responses: { 'image ls --all --format {{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}': imageRows },
  });
  const io = createIo();

  await runCleanDocker({
    args: [DRY_RUN_FLAG],
    environment: LOCAL_ENVIRONMENT,
    io,
    runDocker: docker.runDocker,
  });

  const output = io.logs.join('\n');
  assert.match(output, /21 rows; showing the first 20/);
  assert.match(output, /image-19/);
  assert.doesNotMatch(output, /image-20/);
  assert.match(output, /1 additional rows omitted/);
});

test('a failed preflight prevents authorization and every prune command', async () => {
  const docker = createFakeRunner({ failCommand: 'system df' });

  await assert.rejects(
    () =>
      runCleanDocker({
        args: [CLEAN_CONFIRMATION_FLAG],
        environment: LOCAL_ENVIRONMENT,
        io: createIo(),
        runDocker: docker.runDocker,
      }),
    /Preflight failed\. No Docker resources were removed/,
  );
  assert.deepEqual(cleanupCalls(docker.calls), []);
});

test('non-interactive cleanup requires the explicit host-prune authorization flag', async () => {
  const docker = createFakeRunner();
  await assert.rejects(
    () =>
      runCleanDocker({
        environment: LOCAL_ENVIRONMENT,
        io: createIo(),
        runDocker: docker.runDocker,
      }),
    /non-interactive terminal without --confirm-host-prune/,
  );
  assert.deepEqual(cleanupCalls(docker.calls), []);
});

test('interactive cleanup only prunes after the exact confirmation token is accepted', async () => {
  const docker = createFakeRunner();
  const rejectedIo = createIo({ isInteractive: true });
  assert.equal(
    (
      await runCleanDocker({
        environment: LOCAL_ENVIRONMENT,
        io: rejectedIo,
        runDocker: docker.runDocker,
      })
    ).status,
    'cancelled',
  );
  assert.deepEqual(cleanupCalls(docker.calls), []);

  const confirmedDocker = createFakeRunner();
  const confirmationTokens = [];
  const confirmedIo = createIo({
    confirm: async (token) => {
      confirmationTokens.push(token);
      return token === 'PRUNE';
    },
    isInteractive: true,
  });
  assert.equal(
    (
      await runCleanDocker({
        environment: LOCAL_ENVIRONMENT,
        io: confirmedIo,
        runDocker: confirmedDocker.runDocker,
      })
    ).status,
    'cleaned',
  );
  assert.deepEqual(confirmationTokens, ['PRUNE']);
  assert.deepEqual(confirmedDocker.calls, [
    ...expectedPreflightCalls(),
    ...CLEANUP_COMMANDS.map((command) => command.args),
    ['system', 'df'],
  ]);
});

test('remote Docker hosts require both explicit remote and prune authorization flags', async () => {
  const rejectedDocker = createFakeRunner();
  await assert.rejects(
    () =>
      runCleanDocker({
        args: [CLEAN_CONFIRMATION_FLAG],
        environment: { DOCKER_HOST: 'ssh://builder.example.test' },
        io: createIo(),
        runDocker: rejectedDocker.runDocker,
      }),
    /Refusing to prune non-local Docker endpoint/,
  );
  assert.deepEqual(rejectedDocker.calls, []);

  const allowedDocker = createFakeRunner();
  await runCleanDocker({
    args: [ALLOW_REMOTE_DOCKER_HOST_FLAG, CLEAN_CONFIRMATION_FLAG],
    environment: { DOCKER_HOST: 'ssh://builder.example.test' },
    io: createIo(),
    runDocker: allowedDocker.runDocker,
  });
  assert.deepEqual(
    cleanupCalls(allowedDocker.calls),
    CLEANUP_COMMANDS.map((command) => command.args),
  );
});

test('a failed prune reports partial completion and skips every later destructive command', async () => {
  const docker = createFakeRunner({ failCommand: 'network prune --force' });
  const io = createIo();

  await assert.rejects(
    () =>
      runCleanDocker({
        args: [CLEAN_CONFIRMATION_FLAG],
        environment: LOCAL_ENVIRONMENT,
        io,
        runDocker: docker.runDocker,
      }),
    /Cleanup stopped after completing: Removing stopped containers/,
  );
  assert.deepEqual(
    cleanupCalls(docker.calls),
    CLEANUP_COMMANDS.slice(0, 2).map((command) => command.args),
  );
});

test('the real Docker runner uses static argv without a shell', async () => {
  const spawned = [];
  const spawnProcess = (command, args, options) => {
    spawned.push({ args, command, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };

  await createDockerRunner({ spawnProcess })(['system', 'df']);

  assert.deepEqual(spawned, [
    {
      args: ['system', 'df'],
      command: 'docker',
      options: {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: 'inherit',
      },
    },
  ]);
});

test('the cleanup command set cannot remove Docker volumes or invoke system prune', () => {
  const cleanupArguments = CLEANUP_COMMANDS.flatMap((command) => command.args).join(' ');
  assert.doesNotMatch(cleanupArguments, /\bvolume\b/);
  assert.doesNotMatch(cleanupArguments, /\bsystem\s+prune\b/);
  assert.deepEqual(
    CLEANUP_COMMANDS.map((command) => command.args),
    [
      ['container', 'prune', '--force'],
      ['network', 'prune', '--force'],
      ['image', 'prune', '--all', '--force'],
      ['builder', 'prune', '--all', '--force'],
    ],
  );
});
