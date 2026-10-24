import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import { css } from '@emotion/react';
import { type ChangeEvent, type FC, useEffect, useRef, useState } from 'react';
import { Field } from '@atlaskit/form';
import { useRemoteDebugger } from '../hooks/useRemoteDebugger';
import { debuggerPanelAnchorState, type DebuggerPanelAnchor, debuggerPanelOpenState } from '../state/ui';
import { selectedExecutorState } from '../state/settings';
import { useDebuggerConnectionSettings } from '../hooks/useDebuggerConnectionSettings.js';
import { useSetAtom, useAtom, useAtomValue } from 'jotai';
import { getExecutorProductState, isExternalDebuggerProductState } from '../state/selectors/executionSelectors.js';
import {
  DEBUGGER_PANEL_WIDTH,
  DEBUGGER_PANEL_Z_INDEX,
  resolveDebuggerPanelPosition,
} from '../utils/debuggerPanelPosition.js';
import { popupMenuSurfaceStyles } from './PopupMenu.js';

export function useToggleRemoteDebugger() {
  const setDebuggerPanelOpen = useSetAtom(debuggerPanelOpenState);
  const setDebuggerPanelAnchor = useSetAtom(debuggerPanelAnchorState);
  const { sessionState: remoteDebugger, disconnect } = useRemoteDebugger();
  const selectedExecutor = useAtomValue(selectedExecutorState);
  const executorProductState = getExecutorProductState({ selectedExecutor, session: remoteDebugger });
  const isActuallyRemoteDebugging = isExternalDebuggerProductState(executorProductState);

  return () => {
    if (isActuallyRemoteDebugging) {
      disconnect();
    } else {
      setDebuggerPanelAnchor(undefined);
      setDebuggerPanelOpen(true);
    }
  };
}

export const DebuggerPanelRenderer: FC = () => {
  const [debuggerPanelOpen, setDebuggerPanelOpen] = useAtom(debuggerPanelOpenState);
  const debuggerPanelAnchor = useAtomValue(debuggerPanelAnchorState);
  const setDebuggerPanelAnchor = useSetAtom(debuggerPanelAnchorState);

  const { connect } = useRemoteDebugger();

  function closeDebuggerPanel() {
    setDebuggerPanelOpen(false);
    setDebuggerPanelAnchor(undefined);
  }

  function handleConnectRemoteDebugger(url: string) {
    closeDebuggerPanel();
    connect(url);
  }

  if (!debuggerPanelOpen) {
    return null;
  }

  return (
    <DebuggerConnectPanel
      anchor={debuggerPanelAnchor}
      onConnect={handleConnectRemoteDebugger}
      onCancel={closeDebuggerPanel}
    />
  );
};

const styles = css`
  ${popupMenuSurfaceStyles};
  display: flex;
  flex-direction: column;
  gap: 16px;
  position: fixed;
  padding: 4px 16px 16px 16px; // atlaskit padding on top
  width: ${DEBUGGER_PANEL_WIDTH}px;
  z-index: ${DEBUGGER_PANEL_Z_INDEX};

  .inputs {
  }

  .buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    align-items: center;

    .connect {
      background-color: var(--primary);
      color: var(--foreground-on-primary) !important;
    }
  }
`;

export type DebuggerConnectPanelProps = {
  anchor?: DebuggerPanelAnchor;
  onConnect?: (url: string) => void;
  onCancel?: () => void;
};

export const DebuggerConnectPanel: FC<DebuggerConnectPanelProps> = ({ anchor, onConnect, onCancel }) => {
  const {
    defaultUrl: defaultConnectUrl,
    setDefaultUrl: setDefaultConnectUrl,
    resolveConnectionUrl,
  } = useDebuggerConnectionSettings();
  // Follow preference hydration/runtime defaults until the user starts typing.
  const [draftConnectUrl, setConnectUrl] = useState<string>();
  const connectUrl = draftConnectUrl ?? defaultConnectUrl;

  const textField = useRef<HTMLInputElement>(null);

  function doConnect() {
    onConnect?.(resolveConnectionUrl(connectUrl));
    setDefaultConnectUrl(connectUrl);
  }

  useEffect(() => {
    textField.current?.focus();
  }, []);

  useEffect(() => {
    const input = textField.current;
    // Preferences may hydrate after mount. Preserve drafts and never steal focus.
    if (draftConnectUrl === undefined && input && input.ownerDocument.activeElement === input) {
      input.setSelectionRange(0, input.value.length);
    }
  }, [defaultConnectUrl, draftConnectUrl]);

  return (
    <div
      css={styles}
      style={resolveDebuggerPanelPosition({
        anchor,
        viewportWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
      })}
    >
      <div className="inputs">
        <Field label="Connection URL (leave blank for default)" name="url">
          {() => (
            <TextField
              ref={textField}
              value={connectUrl}
              placeholder="(Default)"
              onChange={(e: ChangeEvent<HTMLInputElement>) => setConnectUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  doConnect();
                }
              }}
            />
          )}
        </Field>
      </div>

      <div className="buttons">
        <Button className="cancel" onClick={() => onCancel?.()}>
          Cancel
        </Button>
        <Button className="connect" onClick={doConnect}>
          Connect
        </Button>
      </div>
    </div>
  );
};
