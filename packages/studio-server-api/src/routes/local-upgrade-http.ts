import type { Router, Request, RequestHandler } from 'express';
import { requireLocalUpgradeOperatorAuth, requireLocalUpgradeSetupOperatorAuth } from '../middleware/auth.js';
import {
  getLocalUpgradeStatus,
  getLocalUpgradeSetupStatus,
  prepareLocalUpgradeFromUi,
  restartLocalUpgradeFromUi,
  getLocalUpgradeReport,
  getLocalUpgradeProjectReference,
  inspectLocalUpgradeSource,
  localUpgradeBackupFingerprint,
  pauseLocalUpgradeSource,
  startLocalUpgradeCopy,
  transitionLocalUpgrade,
  startLocalUpgradeBrowserBackup,
  getLocalUpgradeBrowserBackupDownload,
  startLocalUpgradePreparation,
  getLocalUpgradeRepairDownload,
} from '../local-metadata/operator-service.js';
import { LOCAL_UPGRADE_PREPARATION_KINDS } from '../../../studio-server-shared/local-upgrade-types.js';
import { duplicateRepairChoicesSchema } from '../local-metadata/duplicate-project-repair.js';
import { createHttpError } from '../utils/httpError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { z } from 'zod';

/** Register on the existing App Settings router; setup precedes the prefix guard. */
export function registerLocalUpgradeHttpRoutes(
  router: Router,
  {
    migrationJsonBody,
    localPreparationJsonBody,
  }: {
    migrationJsonBody: RequestHandler;
    localPreparationJsonBody: RequestHandler;
  },
): void {
  router.get(
    '/local-upgrade/setup',
    requireLocalUpgradeSetupOperatorAuth,
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(getLocalUpgradeSetupStatus());
    }),
  );
  router.post(
    '/local-upgrade/prepare',
    requireLocalUpgradeSetupOperatorAuth,
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      z.object({}).strict().parse(req.body);
      await prepareLocalUpgradeFromUi();
      res.set('Cache-Control', 'no-store').status(202).json({ restarting: true });
    }),
  );
  router.use('/local-upgrade', requireLocalUpgradeOperatorAuth);
  router.post(
    '/local-upgrade/restart',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
      await restartLocalUpgradeFromUi(revision);
      res.set('Cache-Control', 'no-store').status(202).json({ restarting: true });
    }),
  );
  router.get(
    '/local-upgrade',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await getLocalUpgradeStatus());
    }),
  );
  router.get(
    '/local-upgrade/project-reference',
    asyncHandler(async (req, res) => {
      const reference = z
        .string()
        .regex(/^[a-f0-9]{16}$/)
        .parse(req.query.reference);
      res.set('Cache-Control', 'no-store').json(await getLocalUpgradeProjectReference(reference));
    }),
  );
  router.get(
    '/local-upgrade/inventory',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await inspectLocalUpgradeSource());
    }),
  );
  router.post(
    '/local-upgrade/preparation',
    localPreparationJsonBody,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          id: z.string().uuid(),
          kind: z.enum(LOCAL_UPGRADE_PREPARATION_KINDS),
          revision: z.number().int().positive(),
          repairChoices: duplicateRepairChoicesSchema.optional(),
        })
        .strict()
        .parse(req.body);
      res
        .set('Cache-Control', 'no-store')
        .status(202)
        .json(await startLocalUpgradePreparation(input));
    }),
  );
  router.get(
    '/local-upgrade/repair/download',
    asyncHandler(async (req, res) => {
      assertBackupDownloadRequest(req);
      const id = z.string().uuid().parse(req.query.id);
      const archive = await getLocalUpgradeRepairDownload(id);
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      await new Promise<void>((resolve, reject) =>
        res.download(archive, `rivet-project-id-repair-${id}.tar.gz`, (error) => {
          if (error && res.headersSent) {
            res.destroy();
            resolve();
          } else if (error) reject(error);
          else resolve();
        }),
      );
    }),
  );
  router.get(
    '/local-upgrade/fingerprint',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json({ sourceFingerprint: await localUpgradeBackupFingerprint() });
    }),
  );
  router.get(
    '/local-upgrade/report',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await getLocalUpgradeReport());
    }),
  );
  router.post(
    '/local-upgrade/pause',
    migrationJsonBody,
    asyncHandler(async (_req, res) => {
      await pauseLocalUpgradeSource();
      res.sendStatus(204);
    }),
  );
  router.post(
    '/local-upgrade/backup',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
      await startLocalUpgradeBrowserBackup(revision);
      res.set('Cache-Control', 'no-store').status(202).json({ started: true });
    }),
  );
  router.get(
    '/local-upgrade/backup/key',
    asyncHandler(async (req, res) => {
      assertBackupDownloadRequest(req);
      const id = z.string().uuid().parse(req.query.id);
      await getLocalUpgradeBrowserBackupDownload(id);
      const key = process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY || '';
      if (key.length < 32) throw createHttpError(409, 'The encryption key is not configured.');
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.attachment('rivet-local-metadata-encryption-key.txt').type('text/plain').send(key);
    }),
  );
  router.get(
    '/local-upgrade/backup/download',
    asyncHandler(async (req, res) => {
      assertBackupDownloadRequest(req);
      const id = z.string().uuid().parse(req.query.id);
      const { archive, backup } = await getLocalUpgradeBrowserBackupDownload(id);
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('X-Rivet-Backup-SHA256', backup.archiveHash!);
      // Native browser download streams large recordings without a JS Blob.
      await new Promise<void>((resolve, reject) =>
        res.download(archive, `rivet-backup-${backup.id}.tar.gz`, (error) => {
          if (error && res.headersSent) {
            // A cancelled/failed stream cannot be replaced by a JSON error body.
            res.destroy();
            resolve();
          } else if (error) reject(error);
          else resolve();
        }),
      );
    }),
  );
  router.post(
    '/local-upgrade/copy',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          revision: z.number().int().positive(),
          backupReference: z.string().trim().min(1).max(512),
          backupSourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          backupRestored: z.literal(true),
          // Accepted for older clients, not required for plaintext local storage.
          encryptionKeyBackedUp: z.boolean().optional(),
          retryJobId: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      await startLocalUpgradeCopy(input);
      res.status(202).json({ started: true });
    }),
  );
  router.post(
    '/local-upgrade/action',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          action: z.enum(['activate', 'validate', 'return-to-legacy', 'resume', 'cancel']),
          revision: z.number().int().positive(),
        })
        .strict()
        .parse(req.body);
      await transitionLocalUpgrade(input.action, input.revision);
      res.sendStatus(204);
    }),
  );
}

function assertBackupDownloadRequest(req: Request): void {
  const site = req.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none')
    throw createHttpError(403, 'Use the signed-in server UI to download a backup or key.');
  const origin = req.get('Origin');
  if (origin) {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw createHttpError(403, 'Backup download origin is invalid.');
    }
    if (host !== req.get('Host')) throw createHttpError(403, 'Backup download origin does not match this server.');
  }
}
