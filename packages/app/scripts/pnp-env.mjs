import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PNP_CJS_PRELOAD_PATTERN =
  /(?:^|\s)(?:--require(?:=|\s+)|-r\s+)(?:"[^"]*\.pnp\.cjs"|'[^']*\.pnp\.cjs'|\S*\.pnp\.cjs)/g;
const PNP_ESM_LOADER_PATTERN =
  /(?:^|\s)(?:--import(?:=|\s+)|--experimental-loader(?:=|\s+)|--loader(?:=|\s+))(?:"[^"]*\.pnp\.loader\.mjs"|'[^']*\.pnp\.loader\.mjs'|\S*\.pnp\.loader\.mjs)/g;

export function getChildProcessEnvWithoutMissingPnpPreload(repoRoot) {
  const env = { ...process.env };
  const nodeOptions = env.NODE_OPTIONS;
  if (!nodeOptions?.includes('.pnp.')) {
    return env;
  }

  const hasPnpCjs = existsSync(resolve(repoRoot, '.pnp.cjs'));
  const hasPnpEsmLoader = existsSync(resolve(repoRoot, '.pnp.loader.mjs'));
  let cleanedNodeOptions = nodeOptions;

  if (!hasPnpCjs) {
    cleanedNodeOptions = cleanedNodeOptions
      .replace(PNP_CJS_PRELOAD_PATTERN, '')
      .replace(PNP_ESM_LOADER_PATTERN, '');
  } else if (!hasPnpEsmLoader) {
    cleanedNodeOptions = cleanedNodeOptions.replace(PNP_ESM_LOADER_PATTERN, '');
  }

  env.NODE_OPTIONS = cleanedNodeOptions.trim();

  if (env.NODE_OPTIONS.length === 0) {
    delete env.NODE_OPTIONS;
  }

  return env;
}
