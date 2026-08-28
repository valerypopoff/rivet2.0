import { badRequest } from './utils/httpError.js';

export type ApiRuntimeProfile = 'combined' | 'control' | 'execution';

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

  if (rawValue === 'combined' || rawValue === 'control' || rawValue === 'execution') {
    return rawValue;
  }

  throw badRequest(
    `Invalid configuration value "${rawValue}" for ${API_RUNTIME_PROFILE_ENV_NAME}. ` +
    'Expected "combined", "control", or "execution".',
  );
}

export function isExecutionOnlyApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'execution';
}

export function isControlPlaneApiProfile(profile = getApiRuntimeProfile()): boolean {
  return profile === 'control' || profile === 'combined';
}

