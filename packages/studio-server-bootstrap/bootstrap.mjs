import { createHash } from 'node:crypto';
import { isExecutorRuntimeEntryProcess, shouldBootstrapManagedRuntimeLibrariesInCurrentProcess } from './config.mjs';
import {
  applyManagedNodeExecutorProxySettings,
  loadAndApplyNodeExecutorProxySettings,
  setupNodeExecutorProxySettingsPolling,
} from './node-executor-proxy-settings.mjs';
import {
  disposeManagedRuntimeLibrariesSync,
  setupManagedRuntimeLibrariesSync,
  startManagedRuntimeLibrariesFromSettings,
} from './runtime-libraries-sync.mjs';

const replicated = process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated';
const executor = process.env.RIVET_RUNTIME_PROCESS_ROLE === 'executor' && isExecutorRuntimeEntryProcess();
let disposeNodeExecutorProxySettingsPolling = () => {};
let disposeRemoteSettingsPolling = () => {};

if (!replicated) {
  await loadAndApplyNodeExecutorProxySettings({
    clearBeforeLoad: true,
    clearWhenMissing: true,
    quiet: true,
  });
  disposeNodeExecutorProxySettingsPolling = setupNodeExecutorProxySettingsPolling();
  globalThis.__rivetReloadNodeExecutorProxySettings = () => (
    loadAndApplyNodeExecutorProxySettings({ clearBeforeLoad: true, clearWhenMissing: true, quiet: true })
  );
} else {
  globalThis.__rivetApplyNodeExecutorProxySettings = applyManagedNodeExecutorProxySettings;
  globalThis.__rivetStartManagedRuntimeLibraries = startManagedRuntimeLibrariesFromSettings;
}

if (replicated && executor) {
  const url = process.env.RIVET_EXECUTOR_RUNTIME_CONFIG_URL?.trim();
  const sharedKey = process.env.RIVET_KEY?.trim();
  const parsedUrl = url ? new URL(url) : null;
  if (!parsedUrl || parsedUrl.protocol !== 'http:' || parsedUrl.hostname !== '127.0.0.1' ||
    parsedUrl.username || parsedUrl.password || !sharedKey) {
    throw new Error('The managed executor requires an authenticated loopback runtime configuration URL.');
  }
  const { Agent, fetch } = await import('undici');
  const dispatcher = new Agent();
  const headers = {
    'x-rivet-proxy-auth': createHash('sha256').update(`${sharedKey}:proxy-auth`).digest('hex'),
    'x-rivet-executor-auth': createHash('sha256').update(`${sharedKey}:executor-internal`).digest('hex'),
  };
  const fetchSettings = async () => {
    const response = await fetch(url, {
      headers,
      dispatcher,
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Runtime configuration service returned ${response.status}.`);
    const settings = await response.json();
    if (!settings || settings.protocolVersion !== 1 || settings.storage?.storageMode !== 'managed' ||
      typeof settings.storage.databaseConnectionString !== 'string' ||
      typeof settings.storage.objectStorageBucket !== 'string' ||
      typeof settings.storage.storageAccessKeyId !== 'string' ||
      typeof settings.storage.storageAccessKey !== 'string') {
      throw new Error('Runtime configuration service returned invalid storage settings.');
    }
    await applyManagedNodeExecutorProxySettings(settings.proxy);
    return settings;
  };
  let settings;
  const deadline = Date.now() + 120_000;
  while (!settings) {
    try {
      settings = await fetchSettings();
    } catch (error) {
      if (Date.now() >= deadline) throw new Error('Managed executor could not load its startup configuration.', { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  await startManagedRuntimeLibrariesFromSettings(settings.storage);
  let refreshInFlight = false;
  let refreshFailureReported = false;
  const poller = setInterval(() => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    void fetchSettings().then(() => {
      refreshFailureReported = false;
    }).catch((error) => {
      if (!refreshFailureReported) {
        console.error('[node-executor-proxy] Could not refresh managed proxy settings; retaining the last valid settings:', error);
      }
      refreshFailureReported = true;
    }).finally(() => {
      refreshInFlight = false;
    });
  }, 5_000);
  poller.unref?.();
  disposeRemoteSettingsPolling = () => { clearInterval(poller); void dispatcher.close(); };
}

const shouldBootstrapManagedRuntimeLibraries = shouldBootstrapManagedRuntimeLibrariesInCurrentProcess();

if (shouldBootstrapManagedRuntimeLibraries) {
  setupManagedRuntimeLibrariesSync().catch((error) => {
    console.error('[runtime-libraries] Failed to initialize managed runtime-library sync:', error);
  });
}

let runtimeLibrariesSyncDisposed = false;

async function disposeRuntimeLibrariesSyncSafely() {
  if ((!shouldBootstrapManagedRuntimeLibraries && !replicated) || runtimeLibrariesSyncDisposed) {
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
  disposeRemoteSettingsPolling();
  void disposeRuntimeLibrariesSyncSafely();
});

process.once('SIGTERM', () => {
  disposeNodeExecutorProxySettingsPolling();
  disposeRemoteSettingsPolling();
  void disposeRuntimeLibrariesSyncSafely();
});
