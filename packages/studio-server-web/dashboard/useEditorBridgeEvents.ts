import { useEffect, type RefObject } from 'react';
import { toast } from 'react-toastify';
import {
  isEditorToDashboardEvent,
  isValidBridgeOrigin,
  postMessageToEditor,
} from '../../studio-server-shared/editor-bridge';
import {
  isEditorDuplicateShortcutEvent,
  isEditorFindShortcutEvent,
  isEditableElement,
  isSaveShortcutEvent,
} from './editorBridgeFocus';

type UseEditorBridgeEventsOptions = {
  activeWorkflowProjectPath: string;
  editorReady: boolean;
  focusEditorFrame: () => void;
  handleSaveProject: () => void;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  onActiveWorkflowProjectPathChange: (path: string) => void;
  onActiveProjectUnsavedChangesChange: (path: string, hasUnsavedChanges: boolean) => void;
  onEditorReady: () => void;
  onOpenProjectCountChange: (count: number) => void;
  onProjectOpenFailed: (error: string) => void;
  onProjectOpened: (path: string, requestId?: string) => void;
  onRequestActiveWorkflowProjectRename: () => void;
  onProjectSaved: (path: string, hasNewerUnsavedChanges?: boolean) => void;
  onWorkflowPathsMovedApplied: (requestId?: string) => void;
};

export function useEditorBridgeEvents(options: UseEditorBridgeEventsOptions) {
  const {
    activeWorkflowProjectPath,
    editorReady,
    focusEditorFrame,
    handleSaveProject,
    iframeRef,
    onActiveWorkflowProjectPathChange,
    onActiveProjectUnsavedChangesChange,
    onEditorReady,
    onOpenProjectCountChange,
    onProjectOpenFailed,
    onProjectOpened,
    onRequestActiveWorkflowProjectRename,
    onProjectSaved,
    onWorkflowPathsMovedApplied,
  } = options;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !editorReady) {
        return;
      }

      if (isEditorFindShortcutEvent(event)) {
        const eventTarget = event.target instanceof Element ? event.target : null;
        if (
          document.activeElement === iframeRef.current ||
          isEditableElement(document.activeElement) ||
          isEditableElement(eventTarget)
        ) {
          return;
        }

        const editorWindow = iframeRef.current?.contentWindow;
        if (!editorWindow) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        focusEditorFrame();
        postMessageToEditor(editorWindow, {
          type: 'trigger-editor-find-shortcut',
          modifier: event.metaKey ? 'meta' : 'ctrl',
        });
        return;
      }

      if (activeWorkflowProjectPath && isEditorDuplicateShortcutEvent(event)) {
        const eventTarget = event.target instanceof Element ? event.target : null;
        if (
          document.activeElement === iframeRef.current ||
          isEditableElement(document.activeElement) ||
          isEditableElement(eventTarget)
        ) {
          return;
        }

        const editorWindow = iframeRef.current?.contentWindow;
        if (!editorWindow) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        focusEditorFrame();
        postMessageToEditor(editorWindow, {
          type: 'trigger-editor-duplicate-shortcut',
          modifier: event.metaKey ? 'meta' : 'ctrl',
        });
        return;
      }

      if (!isSaveShortcutEvent(event)) {
        return;
      }

      if (document.activeElement === iframeRef.current) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!activeWorkflowProjectPath) {
        return;
      }

      if (!event.repeat) {
        handleSaveProject();
      }
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }, [activeWorkflowProjectPath, editorReady, focusEditorFrame, handleSaveProject, iframeRef]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        !isValidBridgeOrigin(event, iframeRef.current?.contentWindow ?? null) ||
        !isEditorToDashboardEvent(event.data)
      ) {
        return;
      }

      switch (event.data.type) {
        case 'editor-ready':
          onEditorReady();
          break;
        case 'request-active-workflow-project-rename':
          onRequestActiveWorkflowProjectRename();
          break;
        case 'project-opened':
          onProjectOpened(event.data.path, event.data.requestId);
          if (!isEditableElement(document.activeElement)) {
            focusEditorFrame();
          }
          break;
        case 'active-project-path-changed':
          onActiveWorkflowProjectPathChange(event.data.path);
          break;
        case 'active-project-unsaved-changes-changed':
          onActiveProjectUnsavedChangesChange(event.data.path, event.data.hasUnsavedChanges);
          break;
        case 'open-project-count-changed':
          onOpenProjectCountChange(event.data.count);
          break;
        case 'project-saved':
          onProjectSaved(event.data.path, event.data.hasNewerUnsavedChanges);
          break;
        case 'workflow-paths-moved-applied':
          onWorkflowPathsMovedApplied(event.data.requestId);
          break;
        case 'project-open-failed':
          onProjectOpenFailed(event.data.error);
          toast.error(`Failed to open project: ${event.data.error}`);
          break;
        case 'project-compare-failed':
          toast.error(`Failed to compare project: ${event.data.error}`);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [
    focusEditorFrame,
    iframeRef,
    onActiveProjectUnsavedChangesChange,
    onActiveWorkflowProjectPathChange,
    onEditorReady,
    onOpenProjectCountChange,
    onProjectOpenFailed,
    onProjectOpened,
    onRequestActiveWorkflowProjectRename,
    onProjectSaved,
    onWorkflowPathsMovedApplied,
  ]);
}
