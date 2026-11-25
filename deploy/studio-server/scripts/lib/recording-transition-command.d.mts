export type TransitionIdentity = { context: string; namespace: string; release: string; namespaceUid?: string };
type Secret = { value: string } | { environment: string } | { kubernetesSecret: { name: string; key: string } };
export type RecordingProxy = {
  executable?: string;
  source?: string;
  sha256: string;
  instance: string;
  port: number;
  databaseHost: string;
  databasePort: number;
  sslMode: 'disable' | 'require' | 'verify-full';
};
export type RecordingTransitionConfiguration = {
  protocol: 1;
  identity: Required<TransitionIdentity>;
  storageIdentity: string;
  settings: {
    databaseUrl: Secret;
    encryptionKey: Secret;
    previousEncryptionKey?: Secret;
    sslMode: 'disable' | 'require' | 'verify-full';
  };
  proxy?: RecordingProxy;
  installationReference?: string;
};
export type TransitionRun = (
  program: string,
  args: string[],
  options?: {
    cwd?: string;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    settleTree?: boolean;
    retainOnFailure?: boolean;
  },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export function validateRecordingTransitionConfiguration(
  value: unknown,
  identity?: TransitionIdentity,
): RecordingTransitionConfiguration;
export function readRecordingTransitionConfiguration(
  file: string,
  identity?: TransitionIdentity,
  expectedDigest?: string,
): Promise<RecordingTransitionConfiguration>;
export function parseRecordingTransitionDatabaseUrl(databaseUrl: string): URL;
export function resolveRecordingTransitionBootstrap(
  configuration: RecordingTransitionConfiguration,
  options?: {
    run?: TransitionRun;
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    identity?: TransitionIdentity;
  },
): Promise<{
  identity: Required<TransitionIdentity>;
  storageIdentity: string;
  proxy?: RecordingProxy;
  environment: NodeJS.ProcessEnv;
}>;
export function runRecordingTransitionCommand(input: {
  root: string;
  program: string;
  args: string[];
  options?: Parameters<TransitionRun>[2];
  identity: TransitionIdentity;
  required?: boolean;
  configurationFile?: string;
  run: TransitionRun;
  load?: (root: string) => Promise<unknown>;
}): ReturnType<TransitionRun>;
