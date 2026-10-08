const WORKFLOW_SELECTION_KEY = 'rivet-studio-workflow-selection-v1';

/** Sidebar selection is document-local UI state, not an editor save or open command. */
export function readWorkflowLibrarySelection(): string {
  try {
    return window.sessionStorage.getItem(WORKFLOW_SELECTION_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeWorkflowLibrarySelection(path: string): void {
  try {
    if (path) window.sessionStorage.setItem(WORKFLOW_SELECTION_KEY, path);
    else window.sessionStorage.removeItem(WORKFLOW_SELECTION_KEY);
  } catch {
    // Blocked browser storage must not prevent selecting or opening a project.
  }
}
