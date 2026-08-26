export type ManagedProviderGateImage = {
  repository: string;
  digest: string;
};

export type ManagedProviderGateProbe = {
  path: string;
  method: "GET" | "POST";
  body: unknown;
  expectedStatus: number;
  contains: string | undefined;
};

export type ManagedProviderGateConfig = {
  context: string;
  allowedContext: string;
  namespace: string;
  release: string;
  baseUrl: string;
  configFile: string;
  configDirectory: string;
  valuesFile: string;
  images: Record<
    "proxy" | "web" | "api" | "executor",
    ManagedProviderGateImage
  >;
  registry: {
    server: string;
    username: string;
    password: string;
    secretName: string;
  };
  requestHeaders: Record<string, string>;
  workflowProbe: ManagedProviderGateProbe;
  webAppProbe: ManagedProviderGateProbe;
  legacyImport?: { probe: ManagedProviderGateProbe };
  keyRotation?: {
    currentSecretName: string;
    nextSecretName: string;
    secretKey: string;
  };
  interruptionManifests: Array<{
    name: string;
    applyFile: string;
    restoreFile: string;
    restoreAction: "apply" | "delete";
  }>;
  artifactsDir: string;
  deploymentTimeoutSeconds: number;
};

export function buildManagedProviderGateConfig(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): ManagedProviderGateConfig;

export function imageReference(image: ManagedProviderGateImage): string;
