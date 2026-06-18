import { DEFAULT_REMOTE_DEBUGGER_URL } from '../domain/execution/executorUrls.js';

export type ProjectExecutorLocalExecutor = 'browser' | 'nodejs';
export type ProjectExecutorMode =
  | {
      type: 'local';
      executor: ProjectExecutorLocalExecutor;
    }
  | {
      type: 'remote-debugger';
      url: string;
    };

export function createLocalProjectExecutorMode(executor: ProjectExecutorLocalExecutor): ProjectExecutorMode {
  return {
    type: 'local',
    executor,
  };
}

export function resolveCurrentProjectExecutorMode(options: {
  selectedExecutor: ProjectExecutorLocalExecutor;
  target:
    | {
        type: 'external-debugger' | 'internal-desktop' | 'internal-hosted';
        url: string;
      }
    | null
    | undefined;
}): ProjectExecutorMode {
  if (options.target?.type === 'external-debugger') {
    return {
      type: 'remote-debugger',
      url: options.target.url.trim() || DEFAULT_REMOTE_DEBUGGER_URL,
    };
  }

  return createLocalProjectExecutorMode(options.selectedExecutor);
}

export function sanitizeProjectExecutorMode(value: unknown): ProjectExecutorMode | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }

  const mode = value as Partial<ProjectExecutorMode>;

  if (mode.type === 'local' && (mode.executor === 'browser' || mode.executor === 'nodejs')) {
    return createLocalProjectExecutorMode(mode.executor);
  }

  if (mode.type === 'remote-debugger') {
    const url = typeof mode.url === 'string' ? mode.url.trim() : '';

    return {
      type: 'remote-debugger',
      url: url || DEFAULT_REMOTE_DEBUGGER_URL,
    };
  }

  return undefined;
}

export function projectExecutorModesEqual(
  left: ProjectExecutorMode | undefined,
  right: ProjectExecutorMode | undefined,
): boolean {
  if (left?.type !== right?.type) {
    return false;
  }

  if (!left || !right) {
    return true;
  }

  if (left.type === 'local') {
    return right.type === 'local' && left.executor === right.executor;
  }

  return right.type === 'remote-debugger' && left.url === right.url;
}
