import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source and tsc output have different nesting. Resolve the owning checkout,
// never the caller's cwd or a fixed number of parent directories.
let candidate = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(candidate, '.yarn/releases/yarn-4.17.1.cjs'))) {
  const parent = path.dirname(candidate);
  if (parent === candidate) throw new Error('Cannot locate the runtime test checkout.');
  candidate = parent;
}
export const runtimeTestRepo = candidate;

export function runtimeTestEntry(
  relativePath: string,
  mode = process.env.RIVET_API_TEST_RUNTIME || 'source',
): string[] {
  if (!['source', 'prebuilt'].includes(mode)) throw new Error(`Invalid API test runtime: ${mode}`);
  const entry = path.join(
    runtimeTestRepo,
    'packages/studio-server-api',
    mode === 'prebuilt' ? 'dist/studio-server-api/src' : 'src',
    mode === 'prebuilt' ? relativePath : relativePath.replace(/\.js$/, '.ts'),
  );
  if (!existsSync(entry)) throw new Error(`Missing ${mode} API test entry: ${entry}. Build Studio Server first.`);
  return mode === 'prebuilt' ? [entry] : ['--import', 'tsx', entry];
}
