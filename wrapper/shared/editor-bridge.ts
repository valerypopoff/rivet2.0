import type { WorkflowProjectPathMove } from './workflow-types';

export type EditorShortcutModifier = 'ctrl' | 'meta';

export type DashboardToEditorCommand =
  | { type: 'open-project'; path: string; replaceCurrent: boolean; reloadFromDisk?: boolean }
  | { type: 'open-recording'; recordingId: string; replaceCurrent: boolean }
  | { type: 'open-published-version-preview'; relativePath: string; versionId: string; replaceCurrent: boolean }
  | { type: 'compare-open-project-with'; path: string; referencePath?: string }
  | { type: 'refresh-open-project-from-disk'; path: string }
  | { type: 'save-project' }
  | { type: 'trigger-editor-find-shortcut'; modifier: EditorShortcutModifier }
  | { type: 'trigger-editor-duplicate-shortcut'; modifier: EditorShortcutModifier }
  | { type: 'delete-workflow-project'; path: string; projectId?: string | null }
  | { type: 'workflow-paths-moved'; moves: WorkflowProjectPathMove[] };

export type EditorToDashboardEvent =
  | { type: 'editor-ready' }
  | { type: 'project-opened'; path: string }
  | { type: 'project-open-failed'; path: string; error: string }
  | { type: 'active-project-path-changed'; path: string }
  | { type: 'open-project-count-changed'; count: number }
  | { type: 'project-compare-failed'; path: string; error: string }
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

export function isDashboardToEditorCommand(value: unknown): value is DashboardToEditorCommand {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'open-project':
      return (
        typeof value.path === 'string' &&
        typeof value.replaceCurrent === 'boolean' &&
        (value.reloadFromDisk == null || typeof value.reloadFromDisk === 'boolean')
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
      return typeof value.path === 'string' && (value.referencePath == null || typeof value.referencePath === 'string');
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
      return Array.isArray(value.moves) && value.moves.every(isWorkflowMove);
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
      return true;
    case 'project-opened':
    case 'active-project-path-changed':
    case 'project-saved':
      return typeof value.path === 'string';
    case 'project-compare-failed':
    case 'project-open-failed':
      return typeof value.path === 'string' && typeof value.error === 'string';
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
