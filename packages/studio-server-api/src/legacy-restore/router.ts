import { Router } from 'express';
import { z } from 'zod';
import { requireVmMigrationOperatorAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createJsonBodyParser } from '../middleware/body-parsers.js';
import { getLegacyRestoreService } from './service.js';

export const legacyRestoreRouter = Router();
legacyRestoreRouter.use(requireVmMigrationOperatorAuth);
legacyRestoreRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(await getLegacyRestoreService().status());
    } catch {
      res.json({ available: false, reason: 'Legacy restore requires the managed deployment restore capability.' });
    }
  }),
);
legacyRestoreRouter.post(
  '/upload',
  asyncHandler(async (req, res) => {
    if (req.get('Content-Type') !== 'application/gzip') {
      res.status(415).json({ error: 'Upload the original gzip tar backup.' });
      return;
    }
    req.setTimeout(0);
    res.status(202).json({ operation: await getLegacyRestoreService().upload(req) });
  }),
);
const input = z
  .object({
    id: z.string().uuid(),
    archiveDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    confirmation: z.string().optional(),
  })
  .strict();
for (const action of ['start', 'cancel', 'retry', 'proceed-anyway'] as const) {
  legacyRestoreRouter.post(
    `/${action}`,
    createJsonBodyParser(() => 32 * 1024),
    asyncHandler(async (req, res) => {
      const parsed = input.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid restore request.' });
        return;
      }
      const body = parsed.data;
      const service = getLegacyRestoreService();
      if (action === 'start') await service.start(body.id, body.archiveDigest ?? '', body.confirmation ?? '');
      else if (action === 'proceed-anyway') await service.proceedAnyway(body.id, body.archiveDigest ?? '');
      else await service[action](body.id);
      res.status(202).json(await service.status());
    }),
  );
}
