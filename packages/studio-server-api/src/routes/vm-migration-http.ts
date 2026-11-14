import type { Router, RequestHandler } from 'express';
import { createHttpError } from '../utils/httpError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { z } from 'zod';
import {
  acknowledgeInterruptedVmMigration,
  enterVmMigrationMode,
  getVmMigrationStatus,
  getVmMigrationSourceInventory,
  leaveVmMigrationMode,
  reviewVmMigrationDeployment,
  startVmMigration,
  startVmMigrationPrecopy,
  testVmMigrationDatabase,
  testVmMigrationObjectStorage,
} from '../vm-migration-service.js';

const migrationTargetSchema = z
  .object({
    databaseUrl: z.string().min(1),
    databaseSslMode: z.enum(['disable', 'require', 'verify-full']),
    bucket: z.string().min(1),
    endpoint: z.string(),
    region: z.string().min(1),
    prefix: z.string().min(1),
    forcePathStyle: z.boolean(),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    settingsEncryptionKey: z.string().min(1),
    targetOffline: z.boolean(),
    runtimePlatformCompatible: z.boolean(),
  })
  .strict();
const migrationDatabaseSchema = migrationTargetSchema.pick({ databaseUrl: true, databaseSslMode: true });
const migrationObjectStorageSchema = migrationTargetSchema.pick({
  bucket: true,
  endpoint: true,
  region: true,
  prefix: true,
  forcePathStyle: true,
  accessKeyId: true,
  secretAccessKey: true,
});
const migrationDeploymentReviewSchema = z
  .object({
    target: migrationTargetSchema,
    checks: z
      .object({
        backupCompleted: z.literal(true),
        deploymentSettingsMatch: z.literal(true),
        functionalRehearsalPassed: z.literal(true),
        externalDependenciesReviewed: z.literal(true),
        rollbackWindowUnderstood: z.literal(true),
      })
      .strict(),
  })
  .strict();

/** The parent must install requireVmMigrationOperatorAuth before registration. */
export function registerVmMigrationHttpRoutes(router: Router, migrationJsonBody: RequestHandler): void {
  router.get(
    '/vm-migration',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await getVmMigrationStatus());
    }),
  );
  router.get(
    '/vm-migration/inventory',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await getVmMigrationSourceInventory());
    }),
  );
  router.post(
    '/vm-migration/test-database',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      try {
        await testVmMigrationDatabase(migrationDatabaseSchema.parse(req.body));
      } catch {
        throw createHttpError(
          400,
          'Could not read and write destination PostgreSQL. Check its connection and DDL permissions.',
        );
      }
      res.set('Cache-Control', 'no-store').json({ ok: true });
    }),
  );
  router.post(
    '/vm-migration/test-object-storage',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      try {
        await testVmMigrationObjectStorage(migrationObjectStorageSchema.parse(req.body));
      } catch {
        throw createHttpError(400, 'Could not read and write destination S3. Check its location and permissions.');
      }
      res.set('Cache-Control', 'no-store').json({ ok: true });
    }),
  );
  router.post(
    '/vm-migration/maintenance',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').json(await enterVmMigrationMode());
    }),
  );
  router.delete(
    '/vm-migration/maintenance',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const target = req.is('application/json') ? migrationTargetSchema.parse(req.body) : undefined;
      try {
        await leaveVmMigrationMode(target);
      } catch {
        throw createHttpError(
          409,
          'The VM remains paused. Stop the destination pods and check its credentials before closing the startup gate.',
        );
      }
      res.set('Cache-Control', 'no-store').json({ restartRequired: true });
    }),
  );
  router.post(
    '/vm-migration/recover',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      await acknowledgeInterruptedVmMigration(req.body?.importerStopped === true);
      res.set('Cache-Control', 'no-store').json(await getVmMigrationStatus());
    }),
  );
  router.post(
    '/vm-migration/precopy',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const target = migrationTargetSchema.parse(req.body);
      res
        .set('Cache-Control', 'no-store')
        .status(202)
        .json(await startVmMigrationPrecopy(target));
    }),
  );
  router.post(
    '/vm-migration/run',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const target = migrationTargetSchema.parse(req.body);
      res
        .set('Cache-Control', 'no-store')
        .status(202)
        .json(await startVmMigration(target));
    }),
  );
  router.post(
    '/vm-migration/deployment-review',
    migrationJsonBody,
    asyncHandler(async (req, res) => {
      const { target, checks } = migrationDeploymentReviewSchema.parse(req.body);
      res
        .status(202)
        .set('Cache-Control', 'no-store')
        .json(await reviewVmMigrationDeployment(target, checks));
    }),
  );
}
