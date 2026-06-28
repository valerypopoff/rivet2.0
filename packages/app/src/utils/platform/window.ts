import type { NativeWindowHandle, NativeWindowListener } from './core.js';
import { isInTauri } from './core.js';
import { registerTauriPageUnloadCleanup } from './tauriCleanup.js';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  return '';
}

function isClosedWebviewError(error: unknown): boolean {
  return /webview not found|invalid label|it was closed/i.test(getErrorMessage(error));
}

function ignoreClosedWebviewError(error: unknown): void {
  if (!isClosedWebviewError(error)) {
    throw error;
  }
}

function runNativeWindowListener(unlisten: NativeWindowListener): void | Promise<void> {
  try {
    const result = unlisten();
    const maybePromise = result as Promise<void> | undefined;
    if (maybePromise && typeof maybePromise.catch === 'function') {
      return maybePromise.catch(ignoreClosedWebviewError);
    }
    return result;
  } catch (error) {
    ignoreClosedWebviewError(error);
  }
}

function runNativeWindowOperation(operation: () => Promise<void>): Promise<void> {
  return operation().catch(ignoreClosedWebviewError);
}

function trackNativeWindowListener(unlistenPromise: Promise<NativeWindowListener>): Promise<NativeWindowListener> {
  return unlistenPromise.then((unlisten) => {
    let active = true;
    const unregisterPageUnloadCleanup = registerTauriPageUnloadCleanup(() => {
      if (!active) {
        return;
      }

      active = false;
      return runNativeWindowListener(unlisten);
    });

    return () => {
      if (!active) {
        return;
      }

      active = false;
      unregisterPageUnloadCleanup();
      return runNativeWindowListener(unlisten);
    };
  });
}

function wrapNativeWindowHandle(handle: NativeWindowHandle): NativeWindowHandle {
  return {
    close: () => runNativeWindowOperation(() => handle.close()),
    isMaximized: handle.isMaximized ? () => handle.isMaximized!() : undefined,
    listen: handle.listen ? (event, handler) => trackNativeWindowListener(handle.listen!(event, handler)) : undefined,
    minimize: handle.minimize ? () => handle.minimize!() : undefined,
    onCloseRequested: handle.onCloseRequested
      ? (handler) => trackNativeWindowListener(handle.onCloseRequested!(handler))
      : undefined,
    onMenuClicked: handle.onMenuClicked
      ? (handler) => trackNativeWindowListener(handle.onMenuClicked!(handler))
      : undefined,
    once: handle.once ? (event, handler) => trackNativeWindowListener(handle.once!(event, handler)) : undefined,
    setTitle: handle.setTitle ? (title) => handle.setTitle!(title) : undefined,
    startDragging: handle.startDragging ? () => handle.startDragging!() : undefined,
    toggleMaximize: handle.toggleMaximize ? () => handle.toggleMaximize!() : undefined,
  };
}

async function waitForWebviewWindowCreated(handle: NativeWindowHandle): Promise<void> {
  const once = handle.once;
  if (!once) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unlistenCreated: NativeWindowListener | undefined;
    let unlistenError: NativeWindowListener | undefined;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      if (unlistenCreated) {
        void runNativeWindowListener(unlistenCreated);
      }
      if (unlistenError) {
        void runNativeWindowListener(unlistenError);
      }
      callback();
    };

    void once('tauri://created', () => settle(resolve)).then((unlisten) => {
      if (settled) {
        void runNativeWindowListener(unlisten);
      } else {
        unlistenCreated = unlisten;
      }
    }, reject);

    void once('tauri://error', (event) => {
      const payload = event && typeof event === 'object' && 'payload' in event ? event.payload : undefined;
      const message =
        payload && typeof payload === 'object'
          ? `${'error' in payload ? payload.error : 'message' in payload ? payload.message : 'Failed to create webview window.'}`
          : 'Failed to create webview window.';
      settle(() => reject(new Error(message)));
    }).then((unlisten) => {
      if (settled) {
        void runNativeWindowListener(unlisten);
      } else {
        unlistenError = unlisten;
      }
    }, reject);
  });
}

export async function getCurrentWindowHandle(): Promise<NativeWindowHandle | null> {
  if (!isInTauri()) {
    return null;
  }

  const { window } = await import('@tauri-apps/api');
  return wrapNativeWindowHandle(window.getCurrent());
}

export async function getAppWindowHandle(): Promise<NativeWindowHandle | null> {
  if (!isInTauri()) {
    return null;
  }

  const { appWindow } = await import('@tauri-apps/api/window');
  return wrapNativeWindowHandle(appWindow);
}

export async function createWebviewWindowHandle(
  label: string,
  options: { alwaysOnTop?: boolean; center?: boolean; title?: string; url: string },
): Promise<NativeWindowHandle> {
  if (!isInTauri()) {
    const popup = window.open(options.url, '_blank');
    const closeIntervals = new Set<ReturnType<typeof globalThis.setInterval>>();
    const closeHandlers = new Set<() => void>();
    let closeNotified = false;

    const notifyClosed = () => {
      if (closeNotified) {
        return;
      }

      closeNotified = true;

      for (const intervalId of closeIntervals) {
        globalThis.clearInterval(intervalId);
      }
      closeIntervals.clear();

      for (const handler of closeHandlers) {
        void handler();
      }
    };

    return {
      close: async () => {
        popup?.close();
        notifyClosed();
      },
      onCloseRequested: async (handler) => {
        closeHandlers.add(handler);

        const intervalId = globalThis.setInterval(() => {
          if (popup == null || popup.closed) {
            notifyClosed();
          }
        }, 250);

        closeIntervals.add(intervalId);

        return async () => {
          globalThis.clearInterval(intervalId);
          closeIntervals.delete(intervalId);
          closeHandlers.delete(handler);
        };
      },
      once: async () => () => {},
    };
  }

  const { WebviewWindow } = await import('@tauri-apps/api/window');
  const webviewWindow = wrapNativeWindowHandle(new WebviewWindow(label, options));
  await waitForWebviewWindowCreated(webviewWindow);
  return webviewWindow;
}

export async function registerGlobalShortcut(shortcut: string, handler: () => void): Promise<NativeWindowListener> {
  if (!isInTauri()) {
    return () => {};
  }

  const { register, unregister } = await import('@tauri-apps/api/globalShortcut');
  await register(shortcut, handler);

  let active = true;
  let unregisterPageUnloadCleanup = () => {};
  const unregisterShortcut = async () => {
    if (!active) {
      return;
    }

    active = false;
    unregisterPageUnloadCleanup();
    await unregister(shortcut);
  };

  unregisterPageUnloadCleanup = registerTauriPageUnloadCleanup(() => {
    return unregisterShortcut();
  });

  return unregisterShortcut;
}
