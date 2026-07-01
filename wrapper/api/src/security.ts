import path from 'node:path';

import { badRequest } from './utils/httpError.js';

const repoRoot = path.resolve(process.cwd(), '..', '..');

const ENV_ALLOWLIST = new Set([
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_ENDPOINT',
  ...(process.env.RIVET_ENV_ALLOWLIST?.split(',').map((v) => v.trim()) ?? []),
]);

const SHELL_ALLOWLIST = new Set([
  'git',
  'pnpm',
  ...(process.env.RIVET_SHELL_ALLOWLIST?.split(',').map((v) => v.trim()) ?? []),
]);

const COMMAND_TIMEOUT_MS = parseInt(process.env.RIVET_COMMAND_TIMEOUT ?? '30000', 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.RIVET_MAX_OUTPUT ?? String(10 * 1024 * 1024), 10);

function configuredRoot(envName: string, fallback: string): string {
  return path.resolve(process.env[envName]?.trim() || fallback);
}

function getAllowedRoots(): string[] {
  const workspaceRoot = getWorkspaceRoot();
  const appDataRoot = getAppDataRoot();
  const workflowsRoot = getWorkflowsRoot();
  const workflowRecordingsRoot = getWorkflowRecordingsRoot();

  return [
    workspaceRoot,
    appDataRoot,
    workflowsRoot,
    workflowRecordingsRoot,
    ...(process.env.RIVET_EXTRA_ROOTS?.split(',')
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root)) ?? []),
  ];
}

export function validatePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);

  const cmp = process.platform === 'win32'
    ? (a: string, b: string) => a.toLowerCase().startsWith(b.toLowerCase())
    : (a: string, b: string) => a.startsWith(b);

  const isAllowed = getAllowedRoots().some(
    (root) => cmp(resolved, root + path.sep) || resolved.length === root.length && cmp(resolved, root),
  );

  if (!isAllowed) {
    console.error('Rejected path outside allowed roots:', { inputPath, resolved });
    throw badRequest('Path not allowed');
  }

  return resolved;
}

export function isEnvAllowed(name: string): boolean {
  return ENV_ALLOWLIST.has(name);
}

export function isShellAllowed(program: string): boolean {
  const base = path.basename(program);
  return SHELL_ALLOWLIST.has(base);
}

export function getWorkspaceRoot(): string {
  return configuredRoot('RIVET_WORKSPACE_ROOT', repoRoot);
}

export function getAppDataRoot(): string {
  return configuredRoot('RIVET_APP_DATA_ROOT', path.join(repoRoot, '.data', 'rivet-app'));
}

export function getWorkflowsRoot(): string {
  return configuredRoot('RIVET_WORKFLOWS_ROOT', path.join(repoRoot, 'workflows'));
}

export function getWorkflowRecordingsRoot(): string {
  return configuredRoot('RIVET_WORKFLOW_RECORDINGS_ROOT', path.join(getWorkflowsRoot(), '.recordings'));
}

export function getCommandTimeout(): number {
  return COMMAND_TIMEOUT_MS;
}

export function getMaxOutputBytes(): number {
  return MAX_OUTPUT_BYTES;
}
