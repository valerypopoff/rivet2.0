import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { postMessageToEditor, type DashboardToEditorCommand } from '../../studio-server-shared/editor-bridge';
import { EditorBridgeSession } from './editorBridgeSession';

export function useEditorBridgeSession(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  requestReconciliation: () => void,
) {
  const reconciliationRef = useRef(requestReconciliation);
  reconciliationRef.current = requestReconciliation;
  const sessionRef = useRef<EditorBridgeSession>();
  if (!sessionRef.current)
    sessionRef.current = new EditorBridgeSession({
      onUndelivered: () => toast.error('The editor did not receive this action. Please try again.'),
      onReconciliationRequired: () => reconciliationRef.current(),
    });
  const session = sessionRef.current;
  useEffect(() => {
    session.activate();
    return () => session.dispose();
  }, [session]);
  const postCommand = useCallback(
    (command: DashboardToEditorCommand) => {
      if (!session.post(command)) toast.error('The editor has too many pending actions. Please wait and try again.');
    },
    [session],
  );
  const ready = useCallback(
    (instance: string) => {
      const target = iframeRef.current?.contentWindow;
      if (target) session.ready(instance, (command) => postMessageToEditor(target, command));
    },
    [iframeRef, session],
  );
  return { session, postCommand, ready };
}
