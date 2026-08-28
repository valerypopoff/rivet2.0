export type ManagedReleaseGateMode = 'smoke' | 'release';

export type ManagedReleaseGateImage = {
  repository: string;
  digest: string;
};

export type ManagedReleaseGateConfig = {
  mode: ManagedReleaseGateMode;
  context: string;
  allowedContext: string;
  namespace: string;
  release: string;
  images: Record<'proxy' | 'web' | 'api' | 'executor', ManagedReleaseGateImage>;
  imagePullPolicy: 'Always' | 'IfNotPresent';
  registry: {
    server: string;
    username: string;
    password: string;
    secretName: string;
  };
  artifactsDir: string;
  deploymentTimeoutSeconds: number;
  keepNamespace: boolean;
};

export type ManagedReleaseGateValues = {
  fullnameOverride: string;
  imagePullSecrets: Array<{ name: string }>;
  images: Record<'proxy' | 'web' | 'api' | 'executor', ManagedReleaseGateImage & { pullPolicy: 'Always' | 'IfNotPresent' }>;
  postgres: { host: string; port: number; database: string; username: string; passwordSecretName: string; passwordSecretKey: string };
  objectStorage: { endpoint: string; bucket: string; accessKeySecretName: string; accessKeySecretKey: string; secretKeySecretName: string; secretKeySecretKey: string };
  appSettings: { encryptionKeySecretName: string; encryptionKeySecretKey: string };
  auth: { keySecretName: string; keySecretKey: string };
};

export function buildManagedReleaseGateConfig(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  mode?: ManagedReleaseGateMode;
}): ManagedReleaseGateConfig;

export function renderManagedReleaseGateValues(config: ManagedReleaseGateConfig): ManagedReleaseGateValues;

export function imageReference(image: ManagedReleaseGateImage): string;
