import { Router } from 'express';
import { z } from 'zod';
import type {
  ProjectId,
  RivetLLMProfileHealthBeginRequest,
  RivetLLMProfileHealthFinishRequest,
  RivetLLMProfileHealthRenewRequest,
} from '@valerypopoff/rivet2-node';

import { asyncHandler } from '../../utils/asyncHandler.js';
import { validateBody } from '../../middleware/validate.js';
import { badRequest } from '../../utils/httpError.js';
import { getLLMProfileHealthStore } from './storage-backend.js';

export const llmProfileHealthRouter = Router();

const identitySchema = z.object({
  key: z.string().min(1),
  // Studio Server health is shared durable state. Every runtime operation
  // must carry the owning project so one hosted project cannot mutate another.
  projectId: z.string().min(1),
  profileNodeId: z.string().min(1).optional(),
  // Display-only source-node title. It is never used to authorize or key health state.
  profileName: z.string().trim().min(1).optional(),
  provider: z.string().min(1),
  model: z.string(),
  customProviderApi: z.enum(['completions', 'responses']).optional(),
  configurationFingerprint: z.string().min(1),
}).strict();

const policySchema = z.object({
  failureThreshold: z.number().int().positive(),
  failureWindowMs: z.number().int().positive(),
  openDurationMs: z.number().int().positive(),
  halfOpenLeaseMs: z.number().int().positive(),
}).strict();

const beginSchema = z.object({
  identity: identitySchema,
  policy: policySchema,
}).strict();

const finishSchema = z.object({
  identity: identitySchema,
  policy: policySchema,
  permitId: z.string().min(1),
  outcome: z.enum(['healthy', 'unhealthy', 'ignored']),
  executionCorrelationId: z.string().min(1).max(200).optional(),
}).strict();

const renewSchema = z.object({
  identity: identitySchema,
  permitId: z.string().min(1),
  leaseDurationMs: z.number().int().positive(),
}).strict();

const listQuerySchema = z.object({ projectId: z.string().min(1) }).strict();

const resetSchema = z.union([
  z.object({ projectId: z.string().min(1) }).strict(),
  z.object({ projectId: z.string().min(1), key: z.string().min(1) }).strict(),
]);

llmProfileHealthRouter.get('/admin', asyncHandler(async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest('projectId query parameter is required.');
  const store = await getLLMProfileHealthStore();
  res.json(await store.listAdmin({ projectId: parsed.data.projectId as ProjectId }));
}));
llmProfileHealthRouter.get('/', asyncHandler(async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) throw badRequest('projectId query parameter is required.');
  const { projectId } = parsed.data;
  const store = await getLLMProfileHealthStore();
  res.json(await store.list({ projectId: projectId as ProjectId }));
}));

llmProfileHealthRouter.post('/begin', validateBody(beginSchema), asyncHandler(async (req, res) => {
  const store = await getLLMProfileHealthStore();
  res.json(await store.begin(req.body as RivetLLMProfileHealthBeginRequest));
}));

llmProfileHealthRouter.post('/finish', validateBody(finishSchema), asyncHandler(async (req, res) => {
  const store = await getLLMProfileHealthStore();
  res.json(await store.finish(req.body as RivetLLMProfileHealthFinishRequest));
}));

llmProfileHealthRouter.post('/renew', validateBody(renewSchema), asyncHandler(async (req, res) => {
  const store = await getLLMProfileHealthStore();
  res.json(await store.renew(req.body as RivetLLMProfileHealthRenewRequest));
}));

llmProfileHealthRouter.post('/reset', validateBody(resetSchema), asyncHandler(async (req, res) => {
  const store = await getLLMProfileHealthStore();
  const input = req.body as { key?: string; projectId: string };
  if (input.key == null) {
    await store.reset({ projectId: input.projectId as ProjectId });
  } else {
    const deleted = await store.resetProjectKey(input.projectId as ProjectId, input.key);
    if (!deleted) {
      res.status(404).json({ error: 'No LLM Profile health entry exists for this project and key.' });
      return;
    }
  }
  res.status(204).end();
}));
