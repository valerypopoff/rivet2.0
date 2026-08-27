import { shouldBootstrapManagedRuntimeLibrariesInCurrentProcess } from './config.mjs';
import {
  loadAndApplyNodeExecutorProxySettings,
  setupNodeExecutorProxySettingsPolling,
} from './node-executor-proxy-settings.mjs';
import {
  disposeManagedRuntimeLibrariesSync,
  setupManagedRuntimeLibrariesSync,
} from './runtime-libraries-sync.mjs';

await loadAndApplyNodeExecutorProxySettings({
  clearBeforeLoad: true,
  clearWhenMissing: true,
  quiet: true,
});
const disposeNodeExecutorProxySettingsPolling = setupNodeExecutorProxySettingsPolling();
globalThis.__rivetReloadNodeExecutorProxySettings = () => (
  loadAndApplyNodeExecutorProxySettings({
    clearBeforeLoad: true,
    clearWhenMissing: true,
    quiet: true,
  })
);

const shouldBootstrapManagedRuntimeLibraries = shouldBootstrapManagedRuntimeLibrariesInCurrentProcess();

if (shouldBootstrapManagedRuntimeLibraries) {
  setupManagedRuntimeLibrariesSync().catch((error) => {
    console.error('[runtime-libraries] Failed to initialize managed runtime-library sync:', error);
  });
}

let runtimeLibrariesSyncDisposed = false;

async function disposeRuntimeLibrariesSyncSafely() {
  if (!shouldBootstrapManagedRuntimeLibraries || runtimeLibrariesSyncDisposed) {
    return;
  }

  runtimeLibrariesSyncDisposed = true;
  try {
    await disposeManagedRuntimeLibrariesSync();
  } catch (error) {
    console.error('[runtime-libraries] Failed to dispose managed runtime-library sync:', error);
  }
}

process.once('SIGINT', () => {
  disposeNodeExecutorProxySettingsPolling();
  void disposeRuntimeLibrariesSyncSafely();
});

process.once('SIGTERM', () => {
  disposeNodeExecutorProxySettingsPolling();
  void disposeRuntimeLibrariesSyncSafely();
});
