type TauriCleanup = () => void | Promise<void>;

const pageUnloadCleanups = new Set<TauriCleanup>();
let pageUnloadHandlersInstalled = false;
let runningPageUnloadCleanups = false;
let pageUnloadStarted = false;

function runCleanup(cleanup: TauriCleanup) {
  try {
    const cleanupResult = cleanup();
    if (cleanupResult) {
      void cleanupResult.catch(() => {
        // The page is unloading; cleanup must stay best-effort and non-blocking.
      });
    }
  } catch {
    // The page is unloading; cleanup must stay best-effort and non-blocking.
  }
}

function installPageUnloadHandlers() {
  if (pageUnloadHandlersInstalled || typeof window === 'undefined') {
    return;
  }

  pageUnloadHandlersInstalled = true;
  window.addEventListener('pagehide', runTauriPageUnloadCleanups);
  window.addEventListener('beforeunload', runTauriPageUnloadCleanups);
}

export function registerTauriPageUnloadCleanup(cleanup: TauriCleanup): () => void {
  installPageUnloadHandlers();

  if (pageUnloadStarted) {
    runCleanup(cleanup);
    return () => {};
  }

  pageUnloadCleanups.add(cleanup);

  return () => {
    pageUnloadCleanups.delete(cleanup);
  };
}

export function runTauriPageUnloadCleanups() {
  pageUnloadStarted = true;

  if (runningPageUnloadCleanups) {
    return;
  }

  runningPageUnloadCleanups = true;

  try {
    for (const cleanup of [...pageUnloadCleanups]) {
      runCleanup(cleanup);
    }
  } finally {
    runningPageUnloadCleanups = false;
  }
}
