import { isManagedRuntimeLibrariesEnabled } from './config.mjs';
import { createManagedRuntimeLibrariesSyncController } from './sync.mjs';

const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const SETUP_RETRY_DELAY_MS = 5_000;

let setupPromise = null;
let pollerStarted = false;
let pollerHandle = null;
let controller = null;
let retryHandle = null;
let managedRuntimeSettings = null;

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
  if (retryHandle || !managedRuntimeEnabled()) {
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
  if (!managedRuntimeEnabled()) {
    return;
  }

  try {
    await setupManagedRuntimeLibrariesSync();
  } catch (error) {
    scheduleSetupRetry();
    throw error;
  }

  if (!controller) {
    return;
  }

  try {
    await controller.syncCurrentRelease(force);
  } catch (error) {
    const code = typeof error === 'object' && error != null && 'code' in error ? String(error.code ?? '') : '';
    if (RETRYABLE_CODES.has(code)) {
      await controller.syncCurrentRelease(force);
      return;
    }

    throw error;
  }
}

globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = prepareManagedRuntimeLibraries;

async function setupManagedRuntimeLibrariesSync() {
  if (setupPromise) {
    return setupPromise;
  }

  if (!managedRuntimeEnabled()) {
    globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => {};
    return;
  }

  setupPromise = (async () => {
    controller = createManagedRuntimeLibrariesSyncController(managedRuntimeSettings);
    await controller.initialize();
    clearSetupRetry();

    if (!pollerStarted) {
      pollerStarted = true;
      pollerHandle = setInterval(() => {
        void controller.syncCurrentRelease(false).catch((error) => {
          console.error('[runtime-libraries] managed sync poll failed:', error);
        });
      }, controller.config.syncPollIntervalMs);
      pollerHandle.unref?.();
    }
  })().catch((error) => {
    setupPromise = null;
    controller = null;
    scheduleSetupRetry();
    throw error;
  });

  return setupPromise;
}

async function disposeManagedRuntimeLibrariesSync() {
  setupPromise = null;
  globalThis.__RIVET_PREPARE_RUNTIME_LIBRARIES__ = async () => {};
  clearSetupRetry();

  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
  pollerStarted = false;

  const currentController = controller;
  controller = null;
  if (currentController) {
    await currentController.dispose();
  }
}

export { setupManagedRuntimeLibrariesSync, disposeManagedRuntimeLibrariesSync };

export async function startManagedRuntimeLibrariesFromSettings(settings) {
  if (!settings || settings.storageMode !== 'managed') {
    throw new Error('Managed runtime-library startup requires managed deployment storage settings.');
  }
  managedRuntimeSettings = settings;
  await setupManagedRuntimeLibrariesSync();
}
