import { createRequire } from 'node:module';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import * as process from 'node:process';

const DEFAULT_CODE_RUNNER_REQUIRE_ANCHOR = '__rivet_node_code_runner__.cjs';
let activeRuntimeSnapshot: { root: string; identity: string } | undefined;

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
  const runtimeRequire = createRequire(anchor);
  // Hosted releases atomically replace current/. Node's process-wide CommonJS
  // cache otherwise survives that replacement in Rivet-capable Code nodes,
  // unlike ordinary Code workers, which are fresh for each invocation.
  if (hosted) {
    const root = resolve(dirname(anchor));
    const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
    let identity: string;
    try {
      const stat = statSync(root, { bigint: true });
      identity = `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
    } catch {
      identity = 'missing';
    }
    if (activeRuntimeSnapshot?.root !== root || activeRuntimeSnapshot.identity !== identity) {
      // The hosted supervisor anchors directly inside current/node_modules;
      // desktop/custom launchers may instead anchor at its parent directory.
      const moduleRoots = [root, ...(activeRuntimeSnapshot ? [activeRuntimeSnapshot.root] : [])].map(
        (directory) =>
          normalize(basename(directory) === 'node_modules' ? directory : join(directory, 'node_modules')) + sep,
      );
      for (const file of Object.keys(runtimeRequire.cache)) {
        if (moduleRoots.some((modules) => normalize(resolve(file)).startsWith(modules)))
          delete runtimeRequire.cache[file];
      }
      activeRuntimeSnapshot = { root, identity };
    }
  }
  return runtimeRequire;
}
