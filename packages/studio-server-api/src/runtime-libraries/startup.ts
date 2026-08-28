import fs from 'node:fs';
import path from 'node:path';

import { ensureDirectories, getRootPath, currentDir, currentNodeModulesPath, readManifest, writeManifest } from './manifest.js';
import { getRuntimeLibrariesBackendMode } from './config.js';
import { initializeRuntimeLibrariesBackend } from './backend.js';

export async function reconcileRuntimeLibraries(): Promise<void> {
  if (!process.env.RIVET_RUNTIME_LIBRARIES_ROOT) {
    console.log('[runtime-libraries] No RIVET_RUNTIME_LIBRARIES_ROOT configured, skipping reconciliation');
    return;
  }

  if (getRuntimeLibrariesBackendMode() === 'managed') {
    await initializeRuntimeLibrariesBackend();
    return;
  }

  try {
    ensureDirectories();
  } catch (err) {
    console.error('[runtime-libraries] Failed to create directories:', err);
    return;
  }

  migrateLegacyReleaseLayoutIfNeeded();

  const manifest = readManifest();

  if (!currentNodeModulesPath()) {
    if (Object.keys(manifest.packages).length > 0) {
      console.warn('[runtime-libraries] Current runtime library set is missing or corrupt; clearing manifest state');
      manifest.packages = {};
      writeManifest(manifest);
    }

    console.log('[runtime-libraries] No active release, starting clean');
    return;
  }

  console.log(`[runtime-libraries] Active runtime libraries: current (${Object.keys(manifest.packages).length} packages)`);
}

function migrateLegacyReleaseLayoutIfNeeded(): void {
  const root = getRootPath();
  const currentPath = currentDir();
  const currentNodeModulesPath = path.join(currentPath, 'node_modules');
  if (fs.existsSync(currentNodeModulesPath)) {
    return;
  }

  const legacyActiveRelease = path.join(root, 'active-release');
  const legacyReleasesDir = path.join(root, 'releases');

  if (!fs.existsSync(legacyActiveRelease) || !fs.existsSync(legacyReleasesDir)) {
    return;
  }

  try {
    const releaseId = fs.readFileSync(legacyActiveRelease, 'utf8').trim();
    if (!releaseId) {
      return;
    }

    const legacyReleasePath = path.join(legacyReleasesDir, releaseId);
    if (!fs.existsSync(path.join(legacyReleasePath, 'node_modules'))) {
      return;
    }

    fs.renameSync(legacyReleasePath, currentPath);
    try {
      fs.rmSync(legacyActiveRelease, { force: true });
      fs.rmSync(legacyReleasesDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors after successful migration
    }

    console.warn(`[runtime-libraries] Migrated legacy release ${releaseId} to current/ layout`);
  } catch (err) {
    console.error('[runtime-libraries] Failed to migrate legacy runtime-library layout:', err);
  }
}
