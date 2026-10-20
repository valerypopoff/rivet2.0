import type { DeploymentStatus, DeploymentTopology } from '../../studio-server-shared/deployment-status-types.js';
import type {
  RuntimeLibraryReplicaCleanupResult,
  RuntimeLibraryReplicaReadinessState,
} from '../../studio-server-shared/runtime-library-types.js';
import { getApiRuntimeProfile } from './runtime-profile.js';
import { getRuntimeLibrariesBackend } from './runtime-libraries/backend.js';
import { badRequest } from './utils/httpError.js';
import { getHaControlPlaneMode } from './ha-control-plane.js';

const DEPLOYMENT_TOPOLOGY_ENV_NAME = 'RIVET_DEPLOYMENT_TOPOLOGY';

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function getDeploymentTopology(env: NodeJS.ProcessEnv = process.env): DeploymentTopology {
  const rawValue = readEnv(env, DEPLOYMENT_TOPOLOGY_ENV_NAME)?.toLowerCase();
  if (!rawValue) {
    return 'single-host';
  }

  if (rawValue === 'single-host' || rawValue === 'replicated') {
    return rawValue;
  }

  throw badRequest(
    `Invalid configuration value "${rawValue}" for ${DEPLOYMENT_TOPOLOGY_ENV_NAME}. ` +
      'Expected "single-host" or "replicated".',
  );
}

export function buildDeploymentStatus(options: {
  topology: DeploymentTopology;
  apiProfile: DeploymentStatus['apiProfile'];
  replicaReadiness?: RuntimeLibraryReplicaReadinessState | null;
  controlPlaneMode?: 'replicated' | 'singleton';
}): DeploymentStatus {
  return {
    topology: options.topology,
    apiProfile: options.apiProfile,
    ...(options.controlPlaneMode
      ? {
          controlPlaneAvailability: {
            mode: options.controlPlaneMode,
            maintenance: options.controlPlaneMode === 'singleton' ? ('embedded' as const) : ('dedicated' as const),
            developerInterruptionAllowed: options.controlPlaneMode === 'singleton',
          },
        }
      : {}),
    // A single-host deployment has no shared process registry. Do not expose
    // stale data merely because its storage backend was changed in preparation
    // for a future scale-out deployment.
    replicaReadiness: options.topology === 'replicated' ? options.replicaReadiness ?? null : null,
  };
}

export async function getDeploymentStatus(
  apiProfile: DeploymentStatus['apiProfile'] = getApiRuntimeProfile(),
): Promise<DeploymentStatus> {
  const topology = getDeploymentTopology();
  const replicaReadiness =
    topology === 'replicated' ? (await getRuntimeLibrariesBackend().getState()).replicaReadiness : null;

  return buildDeploymentStatus({
    topology,
    apiProfile,
    replicaReadiness,
    ...(process.env.RIVET_HA_CONTROL_PLANE_MODE ? { controlPlaneMode: getHaControlPlaneMode() } : {}),
  });
}

export async function clearStaleDeploymentReplicaStatuses(): Promise<RuntimeLibraryReplicaCleanupResult> {
  if (getDeploymentTopology() !== 'replicated') {
    throw badRequest('Replica status is available only for a replicated deployment.');
  }

  return getRuntimeLibrariesBackend().clearStaleReplicaStatuses();
}
