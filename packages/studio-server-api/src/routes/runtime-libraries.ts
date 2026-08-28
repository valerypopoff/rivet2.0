import { Router } from 'express';
import { z } from 'zod';

import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getRuntimeLibrariesBackend } from '../runtime-libraries/backend.js';

export const runtimeLibrariesRouter = Router();

const packageNamePattern = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const installSchema = z.object({
  packages: z.array(z.object({
    name: z.string().regex(packageNamePattern, 'Invalid package name'),
    version: z.string().min(1, 'Each package must have a version string'),
  })).min(1, 'packages array is required and must not be empty'),
});

const removeSchema = z.object({
  packages: z.array(z.string().min(1, 'Each package must be a name string')).min(1, 'packages array is required and must not be empty'),
});

runtimeLibrariesRouter.get('/', asyncHandler(async (_req, res) => {
  res.json(await getRuntimeLibrariesBackend().getState());
}));

runtimeLibrariesRouter.post('/install', validateBody(installSchema), asyncHandler(async (req, res) => {
  const { packages } = req.body as z.infer<typeof installSchema>;
  const job = await getRuntimeLibrariesBackend().enqueueInstall(packages);
  res.status(202).json(job);
}));

runtimeLibrariesRouter.post('/remove', validateBody(removeSchema), asyncHandler(async (req, res) => {
  const { packages } = req.body as z.infer<typeof removeSchema>;
  const job = await getRuntimeLibrariesBackend().enqueueRemove(packages);
  res.status(202).json(job);
}));

runtimeLibrariesRouter.post('/replicas/cleanup', asyncHandler(async (_req, res) => {
  res.json(await getRuntimeLibrariesBackend().clearStaleReplicaStatuses());
}));

runtimeLibrariesRouter.get('/jobs/:jobId', asyncHandler(async (req, res) => {
  const job = await getRuntimeLibrariesBackend().getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.json(job);
}));

runtimeLibrariesRouter.post('/jobs/:jobId/cancel', asyncHandler(async (req, res) => {
  const job = await getRuntimeLibrariesBackend().cancelJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.status(202).json(job);
}));

runtimeLibrariesRouter.get('/jobs/:jobId/stream', asyncHandler(async (req, res) => {
  await getRuntimeLibrariesBackend().streamJob(req, res);
}));
