import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as process from 'node:process';

const DEFAULT_CODE_RUNNER_REQUIRE_ANCHOR = '__rivet_node_code_runner__.cjs';

type CodeRunnerRequireEnv = Record<string, string | undefined>;

export function getCodeRunnerRequireRoot(
  env: CodeRunnerRequireEnv = process.env as CodeRunnerRequireEnv,
  cwd = process.cwd(),
) {
  const configuredRoot = env.RIVET_CODE_RUNNER_REQUIRE_ROOT?.trim();
  return configuredRoot || cwd;
}

export function getCodeRunnerRequireAnchorPath(
  env: CodeRunnerRequireEnv = process.env as CodeRunnerRequireEnv,
  cwd = process.cwd(),
) {
  const configuredAnchor = env.RIVET_CODE_RUNNER_REQUIRE_ANCHOR?.trim();
  if (configuredAnchor) {
    return configuredAnchor;
  }

  return join(getCodeRunnerRequireRoot(env, cwd), DEFAULT_CODE_RUNNER_REQUIRE_ANCHOR);
}

export function createCodeRunnerRequire(
  env: CodeRunnerRequireEnv = process.env as CodeRunnerRequireEnv,
  cwd = process.cwd(),
) {
  return createRequire(resolveCodeRunnerRequireAnchor(env, cwd));
}

export function resolveCodeRunnerRequireAnchor(
  env: CodeRunnerRequireEnv = process.env as CodeRunnerRequireEnv,
  cwd = process.cwd(),
) {
  let anchor = getCodeRunnerRequireAnchorPath(env, cwd);
  const hosted = env.RIVET_CODE_RUNNER_REQUIRE_ROOT?.trim() || env.RIVET_CODE_RUNNER_REQUIRE_ANCHOR?.trim();
  if (hosted) {
    try {
      // Resolve a versioned cache link without Node's process-wide realpath
      // cache so package.json main/exports changes get a fresh physical scope.
      anchor = join(realpathSync.native(dirname(anchor)), basename(anchor));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // A resolver lookup must never clear modules still owned by another run.
  return anchor;
}
