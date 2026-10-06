import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { createJsonBodyParser } from '../middleware/body-parsers.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { badRequest } from '../utils/httpError.js';
import { validateScheduledRun, nextOccurrence } from './calendar.js';
import { assertScheduleWritesAllowed, getScheduledRunService } from './runtime.js';
import { createExecutionSubgraphProjectLoader } from '../routes/workflows/storage-backend.js';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { requestId } from './requests.js';
import type { ScheduledRun } from '../../../studio-server-shared/scheduled-run-types.js';
import { beginScheduledActivity } from './activity.js';

export const scheduledRunsRouter = Router();
scheduledRunsRouter.use(
  requireAuth,
  createJsonBodyParser(() => 2 * 1024 * 1024),
);
scheduledRunsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const revision = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw badRequest('Expected schedule revision is required.');
  return Number(value);
};
// Response close is not completion: durable mutations may still be committing
// after a disconnected client. Keep them in the migration drain until settled.
const mutationHandler: typeof asyncHandler = (handler) =>
  asyncHandler(async (req, res, next) => {
    const release = beginScheduledActivity();
    try {
      assertScheduleWritesAllowed();
      await handler(req, res, next);
    } finally {
      release();
    }
  });
scheduledRunsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getScheduledRunService().store.list());
  }),
);
scheduledRunsRouter.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const now = Date.now(),
      draft = validateScheduledRun(req.body, now),
      times: number[] = [];
    let after = now;
    for (let i = 0; i < 5; i++) {
      const next = nextOccurrence(draft.schedule, draft.timeZone, after);
      if (next === null) break;
      times.push(next);
      after = next;
    }
    res.json({ times });
  }),
);
scheduledRunsRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    res.json({ enabledCount: await getScheduledRunService().store.enabledCount() });
  }),
);
const save = async (body: any, id?: string) => {
  const key = id ? undefined : requestId(body?.requestId);
  const draft = validateScheduledRun(body?.draft, id ? Date.now() : 0);
  const store = getScheduledRunService().store;
  if (key) {
    const previous = await store.acknowledged<ScheduledRun>(key, { kind: 'create', draft });
    if (previous) return previous;
  }
  if (draft.enabled) {
    const resolved = await createExecutionSubgraphProjectLoader().loadTarget({
      projectId: draft.projectId as ProjectId,
      version: draft.version,
    });
    if (!resolved.project.metadata.mainGraphId || !resolved.project.graphs[resolved.project.metadata.mainGraphId])
      throw badRequest('This saved project has no valid main graph.');
  }
  assertScheduleWritesAllowed();
  return store.save(draft, id, id ? revision(body.revision) : 0, key);
};
scheduledRunsRouter.post(
  '/',
  mutationHandler(async (req, res) => {
    res.status(201).json(await save(req.body));
  }),
);
scheduledRunsRouter.put(
  '/:id',
  mutationHandler(async (req, res) => {
    res.json(await save(req.body, String(req.params.id)));
  }),
);
scheduledRunsRouter.delete(
  '/:id',
  mutationHandler(async (req, res) => {
    await getScheduledRunService().store.delete(String(req.params.id), revision(req.body?.revision));
    res.sendStatus(204);
  }),
);
scheduledRunsRouter.post(
  '/:id/run',
  mutationHandler(async (req, res) => {
    res
      .status(202)
      .json(
        await getScheduledRunService().store.runNow(
          String(req.params.id),
          revision(req.body?.revision),
          requestId(req.body?.requestId),
        ),
      );
  }),
);
scheduledRunsRouter.post(
  '/runs/:id/retry',
  mutationHandler(async (req, res) => {
    if (req.body?.confirmSideEffects !== true) throw badRequest('Confirm that retry may repeat external side effects.');
    res
      .status(202)
      .json(await getScheduledRunService().store.retry(String(req.params.id), requestId(req.body?.requestId)));
  }),
);
scheduledRunsRouter.post(
  '/runs/:id/cancel',
  mutationHandler(async (req, res) => {
    await getScheduledRunService().store.cancel(String(req.params.id));
    res.sendStatus(204);
  }),
);
