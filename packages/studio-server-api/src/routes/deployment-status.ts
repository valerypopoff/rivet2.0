import { Router } from 'express';

import {
  clearStaleDeploymentReplicaStatuses,
  getDeploymentStatus,
} from '../deployment-status.js';
import type { DeploymentStatus } from '../../../studio-server-shared/deployment-status-types.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Read-only operational topology for the Settings UI. The replica source is
 * deliberately separate from runtime-library package management even though
 * managed deployments use the library-sync registry as its durable signal.
 */
export function createDeploymentStatusRouter(
  apiProfile: DeploymentStatus['apiProfile'],
): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    res.json(await getDeploymentStatus(apiProfile));
  }));

  router.post('/replicas/cleanup', asyncHandler(async (_req, res) => {
    res.json(await clearStaleDeploymentReplicaStatuses());
  }));

  return router;
}
