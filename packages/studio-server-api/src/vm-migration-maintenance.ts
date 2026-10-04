import { lstatSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertLocalMetadataWritesAllowed } from './local-metadata/write-admission.js';
import type { RequestHandler, Response } from 'express';

import { getAppDataRoot } from './security.js';
import { syncDirectory, writeDurableExclusive } from './routes/workflows/filesystem-transaction-primitives.js';

const markerName = 'vm-migration-maintenance.json';
let activeRequests = 0;
const passiveStreams = new Set<() => void>();

/** Notification-only SSE owners opt in after their asynchronous setup is
 * complete. Do not register executions or mutating requests here. */
export function watchVmMigrationPassiveStream(response: Response): boolean {
  if (isVmMigrationMaintenanceActive()) {
    response.end();
    return false;
  }
  const close = () => response.end();
  const release = () => {
    passiveStreams.delete(close);
    response.off('finish', release);
    response.off('close', release);
  };
  passiveStreams.add(close);
  response.once('finish', release);
  response.once('close', release);
  return true;
}

function closePassiveStreams(): void {
  for (const close of passiveStreams) close();
}

function markerPath(): string {
  return path.join(getAppDataRoot(), markerName);
}

export function isVmMigrationMaintenanceActive(): boolean {
  try {
    const stat = lstatSync(markerPath());
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid VM migration maintenance marker type.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function readVmMigrationMaintenance(): { enteredAt: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(), 'utf8')) as { version?: unknown; enteredAt?: unknown };
    if (parsed.version !== 1 || typeof parsed.enteredAt !== 'string') {
      throw new Error('Invalid VM migration maintenance marker.');
    }
    return { enteredAt: parsed.enteredAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // A damaged marker is still an active maintenance barrier. Never interpret
    // it as permission to resume writes.
    throw error;
  }
}

export async function enterVmMigrationMaintenance(): Promise<void> {
  if (isVmMigrationMaintenanceActive()) {
    readVmMigrationMaintenance();
    closePassiveStreams();
    return;
  }
  await fs.mkdir(getAppDataRoot(), { recursive: true });
  try {
    await writeDurableExclusive(
      markerPath(),
      JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    readVmMigrationMaintenance();
  }
  await syncDirectory(getAppDataRoot());
  closePassiveStreams();
}

export async function leaveVmMigrationMaintenance(): Promise<void> {
  await fs.rm(markerPath());
  await syncDirectory(getAppDataRoot());
}

export function getVmMigrationActiveRequestCount(): number {
  return activeRequests;
}

/** Installed before all data routes, including public GET execution routes. */
export const vmMigrationRequestBarrier: RequestHandler = (req, res, next) => {
  // These POSTs only export existing bytes. Do not exempt all GETs: public
  // workflow GET routes execute graphs and must remain fenced.
  const projectDownload =
    (req.method === 'POST' &&
      ['/api/workflows/projects/download', '/api/workflows/projects/published-versions/download'].includes(req.path)) ||
    (req.method === 'GET' && req.path === '/api/workflows/projects/published-versions');
  if (
    projectDownload ||
    // Permit choosing an export after reload. Before the freeze, tree reads
    // may warm stats caches and must still participate in the write drain.
    (req.method === 'GET' && req.path === '/api/workflows/tree' && isVmMigrationMaintenanceActive()) ||
    req.path.startsWith('/api/app-settings/vm-migration') ||
    req.path.startsWith('/api/app-settings/local-upgrade') ||
    req.path === '/internal/executor-runtime-config' ||
    req.path.startsWith('/ui-auth') ||
    (req.method === 'GET' &&
      (req.path.startsWith('/api/app-settings/') ||
        req.path.startsWith('/api/config') ||
        req.path.startsWith('/api/deployment-status/')))
  ) {
    next();
    return;
  }
  if (isVmMigrationMaintenanceActive()) {
    res.setHeader('Retry-After', '60');
    res.status(503).json({ code: 'vm_migration_maintenance', error: 'Rivet Server is paused for storage migration.' });
    return;
  }
  try {
    assertLocalMetadataWritesAllowed();
  } catch {
    res.setHeader('Retry-After', '60');
    res.status(503).json({
      code: 'local_metadata_paused',
      error: 'Local storage selection requires validation or a backend restart.',
    });
    return;
  }
  activeRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeRequests -= 1;
  };
  res.once('finish', release);
  res.once('close', release);
  next();
};
