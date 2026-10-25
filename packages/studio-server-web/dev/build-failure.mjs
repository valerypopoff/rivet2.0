import path from 'node:path';

const sourceDirectories = [
  'app/src',
  'app/public',
  'app/scripts',
  'app/graphs',
  'core/src',
  'node/src',
  'evaluations/src',
  'studio-server-shared',
  'studio-server-web',
];
const sourceReadDelays = [1_000, 3_000];
const previousBundle = 'The last successful bundle, if any, remains available.';

/** Only a positively identified source read failure may trigger an IO retry. */
export function describeBuildFailure(error, workspace) {
  const file = typeof error?.path === 'string' ? path.relative(path.resolve(workspace, 'packages'), error.path) : '';
  // Vite's CSS wrapper replaces pluginCode with the CSS source, but preserves
  // the original Linux EIO errno. Accept only its known read-only transform.
  const cssRead =
    error?.code === 'PLUGIN_ERROR' &&
    error?.errno === -5 &&
    error?.plugin === 'vite:css' &&
    error?.hook === 'transform' &&
    error?.syscall === 'open';
  const sourceRead =
    (cssRead ||
      ((error?.code === 'EIO' || (error?.code === 'PLUGIN_ERROR' && error?.pluginCode === 'EIO')) &&
        (['read', 'stat'].includes(error?.syscall) || (error?.syscall === 'open' && error?.hook === 'load')))) &&
    sourceDirectories.some((directory) => file.startsWith(directory.split('/').join(path.sep) + path.sep)) &&
    !file
      .split(path.sep)
      .some((part) => ['node_modules', 'dist', '.cache', 'build', 'tests', 'playwright-observe'].includes(part));
  if (sourceRead)
    return {
      phase: 'failed',
      failureKind: 'source-read',
      error: `Frontend source read failed (EIO). ${previousBundle}`,
    };
  return {
    phase: 'failed',
    retryAfterMs: error?.code === 'RIVET_DEV_CACHE_BUSY' ? 5 * 60_000 : undefined,
    error:
      typeof error?.message === 'string' && error.message.startsWith('Tunnel bundle cache')
        ? error.message
        : `Frontend build failed. Check the web container logs; ${previousBundle.toLowerCase()}`,
  };
}

/** Retry fresh compiler processes, never Vite writes/publication in the failed child. */
export function createBuildFailurePolicy() {
  let sourceReadFailures = 0;
  return {
    reset() {
      sourceReadFailures = 0;
    },
    failed(message) {
      if (message.failureKind !== 'source-read') return message;
      const retryAfterMs = sourceReadDelays[sourceReadFailures++];
      return {
        ...message,
        retryAfterMs,
        error:
          retryAfterMs === undefined
            ? `Frontend source read failed (EIO); automatic retries are exhausted. Check Docker Desktop file sharing and restart local development. ${previousBundle}`
            : `Frontend source read failed (EIO). Retrying in ${retryAfterMs / 1_000}s. ${previousBundle}`,
      };
    },
  };
}
