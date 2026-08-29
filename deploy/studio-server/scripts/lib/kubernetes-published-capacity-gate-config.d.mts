import type { ManagedProviderGateConfig } from './kubernetes-managed-provider-gate-config.mjs';

export type PublishedCapacityGateMode = 'observe' | 'certify';

export type PublishedCapacityGateStage = {
  name: string;
  scenario: 'fast' | 'long';
  expect: 'success' | 'overload';
  concurrency: number;
  requests: number;
};

export type PublishedCapacityGateConfig = ManagedProviderGateConfig & {
  mode: PublishedCapacityGateMode;
  artifactsDir: string;
  capacity: {
    serviceNamePrefix?: string;
    stages: PublishedCapacityGateStage[];
    requestTimeoutMs: number;
    controlCanaryEveryRequests: number;
    controlCanaryTimeoutMs: number;
    sampleIntervalMs: number;
    jobTimeoutSeconds: number;
    requireExecutionMetrics: boolean;
    thresholds: {
      maximumP95Ms: Record<string, number>;
      maximumUnexpectedRate: number;
      maximumControlCanaryFailureRate: number;
      maximumRecordingDrops: number;
    };
  };
};

export function buildPublishedCapacityGateConfig(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): PublishedCapacityGateConfig;

export function redactPublishedCapacityGateConfig(config: PublishedCapacityGateConfig): Record<string, unknown>;
