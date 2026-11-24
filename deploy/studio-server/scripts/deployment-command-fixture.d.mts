export function createDeploymentCommandTools(): Promise<{ file: string; close(): Promise<void> }>;
export function createDeploymentCommandEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function createFixtureDirectory(workspaceRoot: string): Promise<string>;
export function hash(value: string | Uint8Array): string;
export function createDeploymentCommandFixture(
  lifecycle: { after(action: () => unknown): unknown },
  mode: string,
  fault?: string | null,
  schemaChange?: boolean,
  recordingCoordination?: boolean,
  options?: { commandTool: string; guard?: boolean },
): Promise<{
  directory: string;
  invocation(extra?: string[]): {
    program: string;
    args: string[];
    options: { cwd: string; env: NodeJS.ProcessEnv; capture: boolean };
  };
  invoke(extra?: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
  qualified(input: {
    configurationFile: string;
    privateStore?: string;
    preflightOnly?: boolean;
    run: typeof import('./lib/managed-gate-command.mjs').runManagedGateCommand;
    loadTransition: (root: string) => Promise<unknown>;
  }): Promise<{ status: string }>;
  state(): Promise<Record<string, any>>;
  calls(): Promise<any[]>;
  stages(): Promise<any[]>;
  digest: string;
}>;
