import fs from 'node:fs';
import path from 'node:path';

import { ensureDirectories, getRootPath, readManifest } from './manifest.js';
import { publishRuntimeLibraryCandidate } from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import { getRuntimeLibrariesBackendMode } from './config.js';
import { initializeRuntimeLibrariesBackend } from './backend.js';
import { getLocalMetadataServingSelection } from '../local-metadata/serving-selection.js';

export async function reconcileRuntimeLibraries(): Promise<void> {
  if (getLocalMetadataServingSelection()) {
    await initializeRuntimeLibrariesBackend();
    return;
  }
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

  await migrateLegacyReleaseLayoutIfNeeded();

  // Copy a legacy release into an immutable cache before accepting new runs.
  // The legacy directory stays available to any older co-located reader.
  await initializeRuntimeLibrariesBackend();

  const manifest = readManifest();

  console.log(`[runtime-libraries] Active runtime libraries: ${Object.keys(manifest.packages).length} packages`);
}

async function migrateLegacyReleaseLayoutIfNeeded(): Promise<void> {
  const root = getRootPath();
  const manifest = readManifest();
  if (manifest.runtimeCache || fs.existsSync(path.join(root, 'current', 'node_modules'))) {
    return;
  }

  const legacyActiveRelease = path.join(root, 'active-release');
  const legacyReleasesDir = path.join(root, 'releases');

  if (!fs.existsSync(legacyActiveRelease) || !fs.existsSync(legacyReleasesDir)) {
    return;
  }

  try {
    const releaseId = fs.readFileSync(legacyActiveRelease, 'utf8').trim();
    if (!releaseId || path.basename(releaseId) !== releaseId || releaseId === '.' || releaseId === '..')
      throw new Error('Invalid legacy runtime-library release identity.');

    const legacyReleasePath = path.join(legacyReleasesDir, releaseId);
    if (!fs.existsSync(path.join(legacyReleasePath, 'node_modules'))) {
      return;
    }

    const staging = fs.mkdtempSync(path.join(root, 'legacy-'));
    try {
      const candidate = path.join(staging, 'candidate');
      fs.cpSync(legacyReleasePath, candidate, { recursive: true, verbatimSymlinks: true });
      await publishRuntimeLibraryCandidate(root, candidate, manifest);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }

    console.log('[runtime-libraries] Adopted legacy runtime libraries without removing their source.');
  } catch (err) {
    throw new Error('Failed to migrate legacy runtime-library layout.', { cause: err });
  }
}
