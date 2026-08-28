import type { ChildProcess } from 'node:child_process';

import { PROCESS_TERMINATE_GRACE_MS } from './schema.js';

export function createManagedRuntimeLibrariesProcessRegistry(options: {
  appendJobLog(jobId: string, message: string, source?: 'system' | 'stdout' | 'stderr'): Promise<void>;
}) {
  const runningProcesses = new Map<string, ChildProcess>();

  return {
    registerRunningProcess(jobId: string, process: ChildProcess | null): void {
      if (process) {
        runningProcesses.set(jobId, process);
        return;
      }

      runningProcesses.delete(jobId);
    },

    terminateRunningProcess(jobId: string, reason: string): void {
      const process = runningProcesses.get(jobId);
      if (!process || process.killed) {
        runningProcesses.delete(jobId);
        return;
      }

      try {
        process.kill('SIGTERM');
      } catch {
        runningProcesses.delete(jobId);
        return;
      }

      const killTimer = setTimeout(() => {
        const stillRunning = runningProcesses.get(jobId) === process && process.exitCode == null;
        if (!stillRunning) {
          return;
        }

        void options.appendJobLog(jobId, `Process did not exit after SIGTERM (${reason}); forcing shutdown.`, 'system').catch(() => {});
        try {
          process.kill('SIGKILL');
        } catch {
          // ignore late kill failures
        }
      }, PROCESS_TERMINATE_GRACE_MS);
      killTimer.unref?.();

      process.once('exit', () => {
        clearTimeout(killTimer);
        if (runningProcesses.get(jobId) === process) {
          runningProcesses.delete(jobId);
        }
      });
    },

    terminateAll(reason: string): void {
      for (const [jobId] of runningProcesses) {
        this.terminateRunningProcess(jobId, reason);
      }
    },

    clear(): void {
      runningProcesses.clear();
    },
  };
}
