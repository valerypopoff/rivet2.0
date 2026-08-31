import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import type { DeploymentStatus } from '../../studio-server-shared/deployment-status-types';
import type { RuntimeLibraryReplicaCleanupResult } from '../../studio-server-shared/runtime-library-types';

import { parseJsonResponse } from './apiRequest';

const API = `${RIVET_API_BASE_URL}/deployment-status`;

export type { DeploymentStatus } from '../../studio-server-shared/deployment-status-types';

export async function fetchDeploymentStatus(): Promise<DeploymentStatus> {
  return parseJsonResponse<DeploymentStatus>(await fetch(API));
}

export async function clearStaleDeploymentReplicaStatuses(): Promise<RuntimeLibraryReplicaCleanupResult> {
  return parseJsonResponse<RuntimeLibraryReplicaCleanupResult>(await fetch(`${API}/replicas/cleanup`, {
    method: 'POST',
  }));
}
