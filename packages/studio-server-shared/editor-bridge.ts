import type { WorkflowProjectPathMove } from './workflow-types';

export type EditorShortcutModifier = 'ctrl' | 'meta';

export type ProjectCompareSideLabels = {
  referenceLabel?: string;
  currentLabel?: string;
};

export type DashboardToEditorCommand =
  | {
      type: 'open-project';
      path: string;
      replaceCurrent: boolean;
      title?: string;
      preview?: boolean;
      reloadFromDisk?: boolean;
      requestId?: string;
    }
  | { type: 'open-recording'; recordingId: string; replaceCurrent: boolean }
  | { type: 'open-published-version-preview'; relativePath: string; versionId: string; replaceCurrent: boolean }
  | {
      type: 'compare-open-project-with';
      path: string;
      referencePath?: string;
      labels?: ProjectCompareSideLabels;
    }
  | { type: 'refresh-open-project-from-disk'; path: string }
  | { type: 'save-project' }
  | { type: 'trigger-editor-find-shortcut'; modifier: EditorShortcutModifier }
  | { type: 'trigger-editor-duplicate-shortcut'; modifier: EditorShortcutModifier }
  | { type: 'delete-workflow-project'; path: string; projectId?: string | null }
  | { type: 'workflow-paths-moved'; moves: WorkflowProjectPathMove[]; requestId?: string };

export type EditorToDashboardEvent =
  | { type: 'editor-ready' }
  | { type: 'request-active-workflow-project-rename' }
  | { type: 'project-opened'; path: string; requestId?: string }
  | { type: 'project-open-failed'; path: string; error: string }
  | { type: 'active-project-path-changed'; path: string }
  | { type: 'active-project-unsaved-changes-changed'; path: string; hasUnsavedChanges: boolean }
  | { type: 'open-project-count-changed'; count: number }
  | { type: 'project-compare-failed'; path: string; error: string }
  | { type: 'workflow-paths-moved-applied'; requestId?: string }
  | { type: 'project-saved'; path: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object';

const getBridgeOrigin = (): string => {
  if (typeof window === 'undefined') {
    return '*';
  }

  const origin = window.location.origin;
  return origin && origin !== 'null' ? origin : '*';
};

const isWorkflowMove = (value: unknown): value is WorkflowProjectPathMove =>
  isRecord(value) &&
  typeof value.fromAbsolutePath === 'string' &&
  typeof value.toAbsolutePath === 'string';

const isEditorShortcutModifier = (value: unknown): value is EditorShortcutModifier =>
  value === 'ctrl' || value === 'meta';

const isProjectCompareSideLabels = (value: unknown): value is ProjectCompareSideLabels =>
  isRecord(value) &&
  (value.referenceLabel == null || typeof value.referenceLabel === 'string') &&
  (value.currentLabel == null || typeof value.currentLabel === 'string');

export function isDashboardToEditorCommand(value: unknown): value is DashboardToEditorCommand {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'open-project':
      return (
        typeof value.path === 'string' &&
        typeof value.replaceCurrent === 'boolean' &&
        (value.title == null || typeof value.title === 'string') &&
        (value.preview == null || typeof value.preview === 'boolean') &&
        (value.reloadFromDisk == null || typeof value.reloadFromDisk === 'boolean') &&
        (value.requestId == null || typeof value.requestId === 'string')
      );
    case 'open-recording':
      return typeof value.recordingId === 'string' && typeof value.replaceCurrent === 'boolean';
    case 'open-published-version-preview':
      return (
        typeof value.relativePath === 'string' &&
        typeof value.versionId === 'string' &&
        typeof value.replaceCurrent === 'boolean'
      );
    case 'compare-open-project-with':
      return (
        typeof value.path === 'string' &&
        (value.referencePath == null || typeof value.referencePath === 'string') &&
        (value.labels == null || isProjectCompareSideLabels(value.labels))
      );
    case 'refresh-open-project-from-disk':
      return typeof value.path === 'string';
    case 'save-project':
      return true;
    case 'trigger-editor-find-shortcut':
      return isEditorShortcutModifier(value.modifier);
    case 'trigger-editor-duplicate-shortcut':
      return isEditorShortcutModifier(value.modifier);
    case 'delete-workflow-project':
      return typeof value.path === 'string' && (value.projectId == null || typeof value.projectId === 'string');
    case 'workflow-paths-moved':
      return (
        Array.isArray(value.moves) &&
        value.moves.every(isWorkflowMove) &&
        (value.requestId == null || typeof value.requestId === 'string')
      );
    default:
      return false;
  }
}

export function isEditorToDashboardEvent(value: unknown): value is EditorToDashboardEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'editor-ready':
    case 'request-active-workflow-project-rename':
      return true;
    case 'project-opened':
      return typeof value.path === 'string' && (value.requestId == null || typeof value.requestId === 'string');
    case 'active-project-path-changed':
    case 'project-saved':
      return typeof value.path === 'string';
    case 'active-project-unsaved-changes-changed':
      return typeof value.path === 'string' && typeof value.hasUnsavedChanges === 'boolean';
    case 'project-compare-failed':
    case 'project-open-failed':
      return typeof value.path === 'string' && typeof value.error === 'string';
    case 'workflow-paths-moved-applied':
      return value.requestId == null || typeof value.requestId === 'string';
    case 'open-project-count-changed':
      return typeof value.count === 'number';
    default:
      return false;
  }
}

export function isValidBridgeOrigin(event: MessageEvent, expectedSource: MessageEventSource | null): boolean {
  if (event.source !== expectedSource) {
    return false;
  }

  const expectedOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  return !expectedOrigin || expectedOrigin === 'null' || event.origin === expectedOrigin;
}

export function postMessageToEditor(targetWindow: Window, command: DashboardToEditorCommand): void {
  targetWindow.postMessage(command, getBridgeOrigin());
}

export function postMessageToDashboard(event: EditorToDashboardEvent): void {
  window.parent.postMessage(event, getBridgeOrigin());
}
