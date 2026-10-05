import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  requireVmMigrationOperatorAuth,
  requireLocalUpgradeOperatorAuth,
  requireLocalUpgradeSetupOperatorAuth,
} from '../middleware/auth.js';
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
} from '../local-metadata/operator-service.js';
import type { RuntimeLimitSettingsDraft } from '../../../studio-server-shared/app-settings-types.js';
import {
  deploymentStorageSettingsRepository,
  readDeploymentStorageSettings,
  writeDeploymentStorageSettings,
} from '../deployment-storage-settings.js';
import {
  environmentVariableSettingsRepository,
  readEnvironmentVariableSettings,
  readEnvironmentVariableValue,
  writeEnvironmentVariableSettings,
} from '../environment-variable-settings.js';
import {
  executorUrlOverrideSettingsRepository,
  readExecutorUrlOverrideSettings,
  writeExecutorUrlOverrideSettings,
} from '../executor-url-override-settings.js';
import {
  nodeExecutorProxySettingsRepository,
  readNodeExecutorProxySettings,
  writeNodeExecutorProxySettings,
} from '../node-executor-proxy-settings.js';
import {
  publicRouteSettingsRepository,
  readPublicRouteSettings,
  readWebAppRouteSettings,
  writePublicRouteSettings,
  writeWebAppRouteSettings,
} from '../public-route-settings.js';
import {
  runtimeLimitSettingsRepository,
  readRuntimeLimitSettings,
  writeRuntimeLimitSettings,
} from '../runtime-limit-settings.js';
import {
  trustedClientSettingsRepository,
  readTrustedClientSettings,
  writeTrustedClientSettings,
} from '../trusted-client-settings.js';
import {
  webAppAuthSettingsRepository,
  readWebAppAuthSettings,
  writeWebAppAuthSettings,
} from '../web-app-auth-settings.js';
import {
  workflowEndpointAuthSettingsRepository,
  readWorkflowEndpointAuthSettings,
  writeWorkflowEndpointAuthSettings,
} from '../workflow-endpoint-auth-settings.js';
import { createHttpError } from '../utils/httpError.js';
import { getVerifiedClientAddress, isTrustedClientRequest } from '../auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { createControlPlaneJsonBodyParser } from '../middleware/body-parsers.js';
import { createJsonBodyParser } from '../middleware/body-parsers.js';
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
import {
  runRecordingsSettingsRepository,
  readRunRecordingsSettings,
  writeRunRecordingsSettings,
} from './workflows/recordings-config.js';

export { readNodeExecutorProxySettings, writeNodeExecutorProxySettings } from '../node-executor-proxy-settings.js';
export { readRunRecordingsSettings, writeRunRecordingsSettings } from './workflows/recordings-config.js';

export const appSettingsRouter = Router();
const migrationJsonBody = createJsonBodyParser(() => 16 * 1024);
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

appSettingsRouter.use('/vm-migration', requireVmMigrationOperatorAuth);
appSettingsRouter.get(
  '/local-upgrade/setup',
  requireLocalUpgradeSetupOperatorAuth,
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(getLocalUpgradeSetupStatus());
  }),
);
appSettingsRouter.post(
  '/local-upgrade/prepare',
  requireLocalUpgradeSetupOperatorAuth,
  migrationJsonBody,
  asyncHandler(async (req, res) => {
    z.object({}).strict().parse(req.body);
    await prepareLocalUpgradeFromUi();
    res.set('Cache-Control', 'no-store').status(202).json({ restarting: true });
  }),
);
appSettingsRouter.use('/local-upgrade', requireLocalUpgradeOperatorAuth);
appSettingsRouter.post(
  '/local-upgrade/restart',
  migrationJsonBody,
  asyncHandler(async (req, res) => {
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
    await restartLocalUpgradeFromUi(revision);
    res.set('Cache-Control', 'no-store').status(202).json({ restarting: true });
  }),
);
appSettingsRouter.get(
  '/local-upgrade',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await getLocalUpgradeStatus());
  }),
);
appSettingsRouter.get(
  '/local-upgrade/project-reference',
  asyncHandler(async (req, res) => {
    const reference = z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .parse(req.query.reference);
    res.set('Cache-Control', 'no-store').json(await getLocalUpgradeProjectReference(reference));
  }),
);
appSettingsRouter.get(
  '/local-upgrade/inventory',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await inspectLocalUpgradeSource());
  }),
);
appSettingsRouter.get(
  '/local-upgrade/fingerprint',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ sourceFingerprint: await localUpgradeBackupFingerprint() });
  }),
);
appSettingsRouter.get(
  '/local-upgrade/report',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await getLocalUpgradeReport());
  }),
);
appSettingsRouter.post(
  '/local-upgrade/pause',
  migrationJsonBody,
  asyncHandler(async (_req, res) => {
    await pauseLocalUpgradeSource();
    res.sendStatus(204);
  }),
);
appSettingsRouter.post(
  '/local-upgrade/backup',
  migrationJsonBody,
  asyncHandler(async (req, res) => {
    const { revision } = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
    await startLocalUpgradeBrowserBackup(revision);
    res.set('Cache-Control', 'no-store').status(202).json({ started: true });
  }),
);
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
appSettingsRouter.get(
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
appSettingsRouter.get(
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
appSettingsRouter.post(
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
appSettingsRouter.post(
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
appSettingsRouter.get(
  '/vm-migration',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await getVmMigrationStatus());
  }),
);
appSettingsRouter.get(
  '/vm-migration/inventory',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await getVmMigrationSourceInventory());
  }),
);
appSettingsRouter.post(
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
appSettingsRouter.post(
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
appSettingsRouter.post(
  '/vm-migration/maintenance',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await enterVmMigrationMode());
  }),
);
appSettingsRouter.delete(
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
appSettingsRouter.post(
  '/vm-migration/recover',
  migrationJsonBody,
  asyncHandler(async (req, res) => {
    await acknowledgeInterruptedVmMigration(req.body?.importerStopped === true);
    res.set('Cache-Control', 'no-store').json(await getVmMigrationStatus());
  }),
);
appSettingsRouter.post(
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
appSettingsRouter.post(
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
appSettingsRouter.post(
  '/vm-migration/deployment-review',
  migrationJsonBody,
  asyncHandler(async (req, res) => {
    const { target, checks } = migrationDeploymentReviewSchema.parse(req.body);
    res.set('Cache-Control', 'no-store').json(await reviewVmMigrationDeployment(target, checks));
  }),
);
appSettingsRouter.get('/trusted-clients/current-request', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    clientAddress: getVerifiedClientAddress(req),
    trusted: isTrustedClientRequest(req),
  });
});
const jsonBody = createControlPlaneJsonBodyParser();

type NodeExecutorProxySettingsReloader = () => Promise<unknown> | unknown;

type NodeExecutorProxySettingsGlobal = typeof globalThis & {
  __rivetReloadNodeExecutorProxySettings?: NodeExecutorProxySettingsReloader;
};

type SettingsRepositoryHandle = {
  readSync(): { revision: string };
};

type SettingsReader = () => Promise<unknown>;
type SettingsWriter = (draft: unknown, expectedRevision?: string) => Promise<unknown>;

function getExpectedRevision(req: Request): string | undefined {
  const ifMatch = req.get('if-match')?.trim();
  if (!ifMatch || ifMatch === '*') {
    return undefined;
  }
  return ifMatch.replace(/^W\//, '').replace(/^"|"$/g, '');
}

function sendSettingsResponse(res: Response, repository: SettingsRepositoryHandle, settings: unknown): void {
  res.set('ETag', `"${repository.readSync().revision}"`);
  res.json(settings);
}

function registerSettingsResource(options: {
  path: string;
  repository: SettingsRepositoryHandle;
  read: SettingsReader;
  write: SettingsWriter;
  normalizeDraft?: (draft: unknown) => unknown;
  afterWrite?: () => Promise<void>;
}): void {
  appSettingsRouter.get(options.path, async (_req, res, next) => {
    try {
      sendSettingsResponse(res, options.repository, await options.read());
    } catch (error) {
      next(error);
    }
  });

  const writeHandler = asyncHandler(async (req, res) => {
    const draft = options.normalizeDraft?.(req.body) ?? req.body;
    const settings = await options.write(draft, getExpectedRevision(req));
    await options.afterWrite?.();
    sendSettingsResponse(res, options.repository, settings);
  });

  appSettingsRouter.put(options.path, jsonBody, writeHandler);
  appSettingsRouter.patch(options.path, jsonBody, writeHandler);
}

function normalizeRuntimeLimitSettingsDraft(value: unknown): RuntimeLimitSettingsDraft {
  const raw = value && typeof value === 'object' ? (value as RuntimeLimitSettingsDraft) : {};
  const draft: RuntimeLimitSettingsDraft = {};

  for (const key of [
    'commandTimeoutSeconds',
    'maxOutputBytes',
    'proxyReadTimeoutSeconds',
    'webAppActionRequestLimitBytes',
    'dockerWaitTimeoutSeconds',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      draft[key] = raw[key];
    }
  }

  return draft;
}

async function reloadNodeExecutorProxySettingsInCurrentProcess(): Promise<void> {
  const reloader = (globalThis as NodeExecutorProxySettingsGlobal).__rivetReloadNodeExecutorProxySettings;
  if (!reloader) {
    return;
  }

  try {
    await reloader();
  } catch (error) {
    console.error('[app-settings] Failed to apply Node executor proxy settings in the current process:', error);
  }
}

registerSettingsResource({
  path: '/environment-variables',
  repository: environmentVariableSettingsRepository,
  read: readEnvironmentVariableSettings,
  write: writeEnvironmentVariableSettings,
});
appSettingsRouter.get('/environment-variables/:id/value', async (req, res, next) => {
  try {
    const value = await readEnvironmentVariableValue(req.params.id);
    if (value === undefined) {
      throw createHttpError(404, 'Environment variable not found');
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ id: req.params.id, value });
  } catch (error) {
    next(error);
  }
});
registerSettingsResource({
  path: '/node-executor-proxy',
  repository: nodeExecutorProxySettingsRepository,
  read: readNodeExecutorProxySettings,
  write: writeNodeExecutorProxySettings,
  afterWrite: reloadNodeExecutorProxySettingsInCurrentProcess,
});
registerSettingsResource({
  path: '/executor-url-overrides',
  repository: executorUrlOverrideSettingsRepository,
  read: readExecutorUrlOverrideSettings,
  write: writeExecutorUrlOverrideSettings,
});
registerSettingsResource({
  path: '/run-recordings',
  repository: runRecordingsSettingsRepository,
  read: readRunRecordingsSettings,
  write: writeRunRecordingsSettings,
});
registerSettingsResource({
  path: '/runtime-limits',
  repository: runtimeLimitSettingsRepository,
  read: readRuntimeLimitSettings,
  write: writeRuntimeLimitSettings,
  normalizeDraft: normalizeRuntimeLimitSettingsDraft,
});
registerSettingsResource({
  path: '/trusted-clients',
  repository: trustedClientSettingsRepository,
  read: readTrustedClientSettings,
  write: writeTrustedClientSettings,
});
registerSettingsResource({
  path: '/deployment-storage',
  repository: deploymentStorageSettingsRepository,
  read: readDeploymentStorageSettings,
  write: writeDeploymentStorageSettings,
});
registerSettingsResource({
  path: '/web-app-routes',
  repository: publicRouteSettingsRepository,
  read: readWebAppRouteSettings,
  write: writeWebAppRouteSettings,
});
registerSettingsResource({
  path: '/public-routes',
  repository: publicRouteSettingsRepository,
  read: readPublicRouteSettings,
  write: writePublicRouteSettings,
});
registerSettingsResource({
  path: '/workflow-endpoint-auth',
  repository: workflowEndpointAuthSettingsRepository,
  read: readWorkflowEndpointAuthSettings,
  write: writeWorkflowEndpointAuthSettings,
});
registerSettingsResource({
  path: '/web-app-auth',
  repository: webAppAuthSettingsRepository,
  read: readWebAppAuthSettings,
  write: writeWebAppAuthSettings,
});
