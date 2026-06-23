import type { NativeWindowHandle, NativeWindowListener } from './core.js';
import { isInTauri } from './core.js';
import { registerTauriPageUnloadCleanup } from './tauriCleanup.js';

function trackNativeWindowListener(unlistenPromise: Promise<NativeWindowListener>): Promise<NativeWindowListener> {
  return unlistenPromise.then((unlisten) => {
    let active = true;
    const unregisterPageUnloadCleanup = registerTauriPageUnloadCleanup(() => {
      if (!active) {
        return;
      }

      active = false;
      return unlisten();
    });

    return () => {
      if (!active) {
        return;
      }

      active = false;
      unregisterPageUnloadCleanup();
      return unlisten();
    };
  });
}

function wrapNativeWindowHandle(handle: NativeWindowHandle): NativeWindowHandle {
  return {
    close: () => handle.close(),
    isMaximized: handle.isMaximized ? () => handle.isMaximized!() : undefined,
    listen: handle.listen
      ? (event, handler) => trackNativeWindowListener(handle.listen!(event, handler))
      : undefined,
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
  options: { alwaysOnTop?: boolean; center?: boolean; url: string },
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
  return wrapNativeWindowHandle(new WebviewWindow(label, options));
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
