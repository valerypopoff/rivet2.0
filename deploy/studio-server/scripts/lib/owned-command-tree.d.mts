import type { ChildProcess, SpawnOptions } from 'node:child_process';
export function spawnOwnedWindowsCommand(
  program: string,
  args: string[],
  options: SpawnOptions & { retainOnFailure?: boolean; stopOnInputClose?: boolean },
): ChildProcess;
export function tryKill(child: ChildProcess): boolean;
export function settleOwnedCommandTree(child: ChildProcess, timeoutMs?: number): Promise<boolean>;
export function stopOwnedCommandTree(
  child: ChildProcess,
  options: {
    spawnProcess: typeof import('node:child_process').spawn;
    platform: string;
    onHelper: (child: ChildProcess) => void;
    signalProcess: typeof process.kill;
    isSettled: () => boolean;
  },
): Promise<boolean>;
