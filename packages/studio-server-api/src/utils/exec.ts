import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StreamingExec extends EventEmitter {
  on(event: 'data', listener: (source: 'stdout' | 'stderr', data: string) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  process: ChildProcess;
}

export interface SpawnInvocation {
  program: string;
  args: string[];
}

const WINDOWS_CMD_PROGRAMS = new Set([
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'corepack',
]);

const PROXY_BOOTSTRAP_NODE_OPTION_PATTERNS = [
  /(?:^|\s)--import=\/opt\/proxy-bootstrap\/bootstrap\.mjs(?=\s|$)/g,
  /(?:^|\s)--import\s+file:\/\/\/opt\/proxy-bootstrap\/bootstrap\.mjs(?=\s|$)/g,
];

function logExecInvocation(invocation: SpawnInvocation, options: ExecOptions): void {
  if (process.env.RIVET_DEBUG_EXEC !== '1') {
    return;
  }

  console.error('[exec]', JSON.stringify({
    program: invocation.program,
    args: invocation.args,
    cwd: options.cwd ?? null,
  }));
}

export function resolveSpawnInvocation(
  program: string,
  args: string[],
  platform = process.platform,
  comSpec = process.env.ComSpec || 'cmd.exe',
): SpawnInvocation {
  if (platform !== 'win32') {
    return { program, args };
  }

  const extension = path.extname(program).toLowerCase();
  const basename = path.basename(program, extension).toLowerCase();
  const isBatchShim = extension === '.cmd' || extension === '.bat' || (!extension && WINDOWS_CMD_PROGRAMS.has(basename));

  if (!isBatchShim) {
    return { program, args };
  }

  return {
    program: comSpec,
    args: ['/d', '/s', '/c', program, ...args],
  };
}

export function stripProxyBootstrapNodeOptions(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  let sanitized = value;
  for (const pattern of PROXY_BOOTSTRAP_NODE_OPTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, ' ');
  }

  sanitized = sanitized.replace(/\s+/g, ' ').trim();
  return sanitized || undefined;
}

export function buildChildProcessEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env = { ...baseEnv };
  const nodeOptions = stripProxyBootstrapNodeOptions(env.NODE_OPTIONS);
  if (nodeOptions) {
    env.NODE_OPTIONS = nodeOptions;
  } else {
    delete env.NODE_OPTIONS;
  }

  return env;
}

export function exec(
  program: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const invocation = resolveSpawnInvocation(program, args);
    logExecInvocation(invocation, options);
    const proc = spawn(invocation.program, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxOutput = options.maxOutputBytes ?? Infinity;

    proc.stdout.on('data', (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes <= maxOutput) stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes <= maxOutput) stderr += data.toString();
    });

    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    proc.on('error', reject);
  });
}

export function execStreaming(
  program: string,
  args: string[],
  options: ExecOptions = {},
): StreamingExec {
  const emitter = new EventEmitter() as StreamingExec;

  const invocation = resolveSpawnInvocation(program, args);
  logExecInvocation(invocation, options);
  const proc = spawn(invocation.program, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  emitter.process = proc;

  proc.stdout.on('data', (data: Buffer) => {
    emitter.emit('data', 'stdout', data.toString());
  });

  proc.stderr.on('data', (data: Buffer) => {
    emitter.emit('data', 'stderr', data.toString());
  });

  proc.on('close', (code) => {
    emitter.emit('exit', code ?? 1);
  });

  proc.on('error', (err) => {
    emitter.emit('error', err);
  });

  return emitter;
}
