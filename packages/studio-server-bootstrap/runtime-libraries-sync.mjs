import { isManagedRuntimeLibrariesEnabled } from './config.mjs';
import { createManagedRuntimeLibrariesSyncController } from './sync.mjs';
import { prepareFilesystemRuntimeSnapshot, readRuntimeSnapshotLink } from './runtime-release-cache.mjs';
import { getRuntimeLibrariesRoot } from './state.mjs';

const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);
const SETUP_RETRY_DELAY_MS = 5_000;

let setupPromise = null;
let pollerHandle = null;
let controller = null;
let retryHandle = null;
let managedRuntimeSettings = null;
let disposed = false;
let disposePromise = null;

function managedRuntimeEnabled() {
  return isManagedRuntimeLibrariesEnabled(managedRuntimeSettings);
}

function clearSetupRetry() {
  if (retryHandle) {
    clearTimeout(retryHandle);
    retryHandle = null;
  }
}

function scheduleSetupRetry() {
  if (disposed || retryHandle || !managedRuntimeEnabled()) {
    return;
  }

  retryHandle = setTimeout(() => {
    retryHandle = null;
    void setupManagedRuntimeLibrariesSync().catch((error) => {
      console.error('[runtime-libraries] Retrying managed runtime-library sync setup failed:', error);
    });
  }, SETUP_RETRY_DELAY_MS);
  retryHandle.unref?.();
}

async function prepareManagedRuntimeLibraries(force = true) {
  if (disposed) throw new Error('Runtime-library preparation is shutting down.');
  if (!managedRuntimeEnabled()) {
    if (process.env.RIVET_LOCAL_METADATA_BOOT_GENERATION) {
      return readRuntimeSnapshotLink(getRuntimeLibrariesRoot());
    }
    return process.env.RIVET_RUNTIME_LIBRARIES_ROOT
      ? prepareFilesystemRuntimeSnapshot(getRuntimeLibrariesRoot())
      : null;
  }

  try {
    await setupManagedRuntimeLibrariesSync();
  } catch (error) {
    scheduleSetupRetry();
    throw error;
  }

  if (!controller) {
    throw new Error('Runtime-library preparation is unavailable.');
  }

  try {
    return await controller.syncCurrentRelease(force);
  } catch (error) {
    const code = typeof error === 'object' && error != null && 'code' in error ? String(error.code ?? '') : '';
    if (RETRYABLE_CODES.has(code)) {
      return await controller.syncCurrentRelease(force);
    }

    throw error;
  }
}

globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = prepareManagedRuntimeLibraries;

async function setupManagedRuntimeLibrariesSync() {
  if (disposed) throw new Error('Runtime-library preparation is shutting down.');
  if (setupPromise) {
    return setupPromise;
  }

  if (!managedRuntimeEnabled()) {
    return;
  }

  setupPromise = (async () => {
    controller = createManagedRuntimeLibrariesSyncController(managedRuntimeSettings);
    await controller.initialize();
    if (disposed) return;
    clearSetupRetry();

    if (!pollerHandle) {
      pollerHandle = setInterval(() => {
        void controller.syncCurrentRelease(false).catch((error) => {
          console.error('[runtime-libraries] managed sync poll failed:', error);
        });
      }, controller.config.syncPollIntervalMs);
      pollerHandle.unref?.();
    }
  })().catch(async (error) => {
    setupPromise = null;
    const failed = controller;
    controller = null;
    await failed?.dispose().catch(() => {});
    scheduleSetupRetry();
    throw error;
  });

  return setupPromise;
}

function disposeManagedRuntimeLibrariesSync() {
  if (disposePromise) return disposePromise;
  disposed = true;
  const pending = setupPromise;
  setupPromise = null;
  clearSetupRetry();

  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  disposePromise = (async () => {
    await pending?.catch(() => {});
    const currentController = controller;
    controller = null;
    if (currentController) await currentController.dispose();
  })().finally(() => {
    disposePromise = null;
  });
  return disposePromise;
}

export { setupManagedRuntimeLibrariesSync, disposeManagedRuntimeLibrariesSync };

export async function startManagedRuntimeLibrariesFromSettings(settings) {
  if (!settings || settings.storageMode !== 'managed') {
    throw new Error('Managed runtime-library startup requires managed deployment storage settings.');
  }
  while (disposePromise) await disposePromise;
  managedRuntimeSettings = settings;
  disposed = false;
  await setupManagedRuntimeLibrariesSync();
}
