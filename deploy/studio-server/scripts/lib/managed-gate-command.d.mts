export function runManagedGateCommand(
  program: string,
  args: string[],
  options?: {
    cwd?: string;
    input?: string;
    capture?: boolean;
    allowFailure?: boolean;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    killAfterMs?: number;
    settleTree?: boolean;
    retainOnFailure?: boolean;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }>;
export function withManagedGateSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T>;
export function assertManagedGateActive(): void;
export function waitForManagedGateCommands(): Promise<void>;
