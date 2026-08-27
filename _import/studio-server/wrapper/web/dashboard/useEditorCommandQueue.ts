import { useCallback, useEffect, useRef } from 'react';
import { postMessageToEditor, type DashboardToEditorCommand } from '../../shared/editor-bridge';

export function useEditorCommandQueue(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  editorReady: boolean,
) {
  const pendingCommandsRef = useRef<DashboardToEditorCommand[]>([]);

  const postCommand = useCallback(
    (command: DashboardToEditorCommand) => {
      if (!editorReady || !iframeRef.current?.contentWindow) {
        pendingCommandsRef.current.push(command);
        return;
      }

      postMessageToEditor(iframeRef.current.contentWindow, command);
    },
    [editorReady, iframeRef],
  );

  useEffect(() => {
    if (!editorReady || pendingCommandsRef.current.length === 0 || !iframeRef.current?.contentWindow) {
      return;
    }

    for (const command of pendingCommandsRef.current) {
      postMessageToEditor(iframeRef.current.contentWindow, command);
    }

    pendingCommandsRef.current = [];
  }, [editorReady, iframeRef]);

  return postCommand;
}
