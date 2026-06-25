import { useCallback, useEffect, useRef, useState, type FC, type MouseEvent as ReactMouseEvent } from 'react';

import CloseIcon from 'majesticons/line/multiply-line.svg?react';

import { type NativeWindowHandle, type NativeWindowListener } from '../../utils/platform/core.js';
import { getAppWindowHandle } from '../../utils/platform/window.js';

type GetAppWindow = () => Promise<NativeWindowHandle | null>;
type WindowAction = (appWindow: NativeWindowHandle) => Promise<void> | void;

const useWindowsAppWindow = () => {
  const appWindowRef = useRef<NativeWindowHandle | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getAppWindowHandle()
      .then((handle) => {
        if (!cancelled) {
          appWindowRef.current = handle;
        }
      })
      .catch((err) => {
        console.warn(`Error getting app window handle: ${err}`);
      });

    return () => {
      cancelled = true;
      appWindowRef.current = null;
    };
  }, []);

  return useCallback(async () => {
    if (appWindowRef.current) {
      return appWindowRef.current;
    }

    appWindowRef.current = await getAppWindowHandle();
    return appWindowRef.current;
  }, []);
};

const runWindowAction = (getAppWindow: GetAppWindow, action: WindowAction, errorMessage: string) => {
  void getAppWindow()
    .then((appWindow) => {
      if (appWindow) {
        return action(appWindow);
      }
    })
    .catch((err) => {
      console.warn(`${errorMessage}: ${err}`);
    });
};

export const WindowsWindowDragRegion: FC = () => {
  const getAppWindow = useWindowsAppWindow();

  const startDragging = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.detail > 1) {
      return;
    }

    runWindowAction(getAppWindow, (appWindow) => appWindow.startDragging?.(), 'Error starting app window drag');
  };

  const toggleMaximize = () => {
    runWindowAction(getAppWindow, (appWindow) => appWindow.toggleMaximize?.(), 'Error toggling app window maximize state');
  };

  return (
    <div className="window-drag-region" aria-hidden="true" onDoubleClick={toggleMaximize} onMouseDown={startDragging} />
  );
};

export const WindowsWindowControls: FC = () => {
  const getAppWindow = useWindowsAppWindow();
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlistenResize: NativeWindowListener | undefined;

    const refreshMaximizedState = async (appWindow?: NativeWindowHandle | null) => {
      try {
        const windowHandle = appWindow ?? (await getAppWindow());
        const maximized = await windowHandle?.isMaximized?.();

        if (!cancelled && maximized != null) {
          setIsWindowMaximized(maximized);
        }
      } catch (err) {
        console.warn(`Error tracking app window maximize state: ${err}`);
      }
    };

    void getAppWindow()
      .then(async (appWindow) => {
        await refreshMaximizedState(appWindow);

        const removeResizeListener = await appWindow?.listen?.('tauri://resize', () => {
          void refreshMaximizedState(appWindow);
        });

        if (cancelled) {
          void removeResizeListener?.();
        } else {
          unlistenResize = removeResizeListener;
        }
      })
      .catch((err) => {
        console.warn(`Error loading app window controls: ${err}`);
      });

    return () => {
      cancelled = true;
      void unlistenResize?.();
    };
  }, [getAppWindow]);

  const toggleMaximize = () => {
    runWindowAction(getAppWindow, async (appWindow) => {
      await appWindow.toggleMaximize?.();
      const maximized = await appWindow.isMaximized?.();

      if (maximized != null) {
        setIsWindowMaximized(maximized);
      }
    }, 'Error toggling app window maximize state');
  };

  return (
    <div className="windows-window-controls" aria-label="Window controls">
      <button
        type="button"
        className="windows-window-control"
        aria-label="Minimize window"
        onClick={() => runWindowAction(getAppWindow, (appWindow) => appWindow.minimize?.(), 'Error minimizing window')}
      >
        <MinimizeWindowIcon />
      </button>
      <button
        type="button"
        className="windows-window-control"
        aria-label={isWindowMaximized ? 'Restore window' : 'Maximize window'}
        onClick={toggleMaximize}
      >
        {isWindowMaximized ? <RestoreWindowIcon /> : <MaximizeWindowIcon />}
      </button>
      <button
        type="button"
        className="windows-window-control close-window"
        aria-label="Close window"
        onClick={() => runWindowAction(getAppWindow, (appWindow) => appWindow.close(), 'Error closing window')}
      >
        <CloseIcon />
      </button>
    </div>
  );
};

const MinimizeWindowIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <path d="M3 8.5h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
  </svg>
);

const MaximizeWindowIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const RestoreWindowIcon: FC = () => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
    <path
      d="M5.25 3.25h7.5v7.5M3.25 5.25h8.5v8.5h-8.5z"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.5"
    />
  </svg>
);
