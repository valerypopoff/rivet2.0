import { badRequest } from './utils/httpError.js';

/**
 * `evaluation` is an internal batch worker. It never owns HTTP control or
 * published-execution routes; it only starts the durable hosted-Evaluation
 * coordinator against managed storage.
 */
export type ApiRuntimeProfile = 'combined' | 'control' | 'evaluation' | 'execution';

const API_RUNTIME_PROFILE_ENV_NAME = 'RIVET_API_PROFILE';

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getApiRuntimeProfile(): ApiRuntimeProfile {
  const rawValue = readEnv(API_RUNTIME_PROFILE_ENV_NAME)?.toLowerCase();
  if (!rawValue) {
    return 'combined';
  }

  if (rawValue === 'combined' || rawValue === 'control' || rawValue === 'execution' || rawValue === 'evaluation') {
    return rawValue;
  }

  throw badRequest(
    `Invalid configuration value "${rawValue}" for ${API_RUNTIME_PROFILE_ENV_NAME}. ` +
      'Expected "combined", "control", "execution", or "evaluation".',
  );
}

export function isExecutionOnlyApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'execution' || profile === 'evaluation';
}

export function isControlPlaneApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'control' || profile === 'combined';
}

/** The public execution profile is the capacity reserved for product traffic. */
export function isPublishedExecutionApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'combined' || profile === 'execution';
}

/**
 * Combined remains a supported local-development topology. Kubernetes batch
 * workers must use `evaluation`, keeping `execution` capacity public-only.
 */
export function isHostedEvaluationWorkerApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'combined' || profile === 'evaluation';
}
