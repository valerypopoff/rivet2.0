import type { ApiRuntimeProfile } from './runtime-profile.js';

export type HaControlPlaneMode = 'replicated' | 'singleton';

/** Deployment-owned. Never infer reduced availability from a replica count. */
export function getHaControlPlaneMode(env: NodeJS.ProcessEnv = process.env): HaControlPlaneMode {
  const mode = env.RIVET_HA_CONTROL_PLANE_MODE ?? 'replicated';
  if (mode !== 'replicated' && mode !== 'singleton') throw new Error('Invalid HA control-plane mode.');
  if (mode === 'singleton' && env.RIVET_DEPLOYMENT_TOPOLOGY !== 'replicated')
    throw new Error('Singleton HA control requires replicated managed deployment storage.');
  return mode;
}

export function ownsMaintenance(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.RIVET_HA_DEPLOYMENT !== '1' || env.RIVET_HA_MAINTENANCE === '1' || getHaControlPlaneMode(env) === 'singleton'
  );
}

/** The absent variable preserves predecessor/local all-in-control behavior. */
export function getScheduledRunScope(
  profile: ApiRuntimeProfile,
  env: NodeJS.ProcessEnv = process.env,
): 'all' | 'latest' | 'published' | undefined {
  if (env.RIVET_HA_MAINTENANCE === '1' || profile === 'evaluation') return undefined;
  if (env.RIVET_HA_CONTROL_PLANE_MODE !== undefined) {
    getHaControlPlaneMode(env);
    return profile === 'execution' ? 'published' : profile === 'control' ? 'latest' : 'all';
  }
  return profile === 'control' || profile === 'combined' ? 'all' : undefined;
}

export function getHaRuntimeContract(profile: ApiRuntimeProfile, env: NodeJS.ProcessEnv = process.env) {
  return {
    protocol: 1,
    controlPlaneMode: getHaControlPlaneMode(env),
    profile,
    scheduledRunScope: getScheduledRunScope(profile, env) ?? null,
    maintenanceOwner: (profile === 'control' || profile === 'combined') && ownsMaintenance(env),
    executionOwnedProxySettings: profile === 'execution' || profile === 'combined',
  };
}
