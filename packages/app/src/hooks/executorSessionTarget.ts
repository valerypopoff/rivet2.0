import { DEFAULT_REMOTE_DEBUGGER_URL, INTERNAL_EXECUTOR_URL } from '../domain/execution/executorUrls.js';

export { DEFAULT_REMOTE_DEBUGGER_URL, INTERNAL_EXECUTOR_URL } from '../domain/execution/executorUrls.js';

export type ExecutorSessionTarget =
  | { type: 'internal-desktop'; url: string }
  | { type: 'internal-hosted'; url: string }
  | { type: 'external-debugger'; url: string };

export function createExternalDebuggerTarget(url = DEFAULT_REMOTE_DEBUGGER_URL): ExecutorSessionTarget {
  return {
    type: 'external-debugger',
    url: url || DEFAULT_REMOTE_DEBUGGER_URL,
  };
}

export function createInternalDesktopExecutorTarget(): ExecutorSessionTarget {
  return {
    type: 'internal-desktop',
    url: INTERNAL_EXECUTOR_URL,
  };
}

export function createInternalHostedExecutorTarget(url: string): ExecutorSessionTarget {
  return {
    type: 'internal-hosted',
    url,
  };
}

export function executorSessionTargetsEqual(left: ExecutorSessionTarget, right: ExecutorSessionTarget): boolean {
  return left.type === right.type && left.url === right.url;
}

export function isInternalExecutorTarget(target: ExecutorSessionTarget | null | undefined): boolean {
  return target?.type === 'internal-desktop' || target?.type === 'internal-hosted';
}

export function getExecutorSessionTargetLabel(target: ExecutorSessionTarget): string {
  switch (target.type) {
    case 'external-debugger':
      return 'external-debugger';
    case 'internal-desktop':
      return 'internal-desktop-executor';
    case 'internal-hosted':
      return 'internal-hosted-executor';
  }
}
