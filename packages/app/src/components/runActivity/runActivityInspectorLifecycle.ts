import type { RootRunId } from '@valerypopoff/rivet2-core';

/**
 * Response inspectors belong to one rendered Run Activity root. Keeping one
 * open after the drawer closes or another root is selected would show stale
 * trace data without its owning activity row.
 */
export function shouldCloseRunActivityInspector(options: {
  drawerOpen: boolean;
  inspectedRootRunId: RootRunId | undefined;
  selectedRootRunId: RootRunId | undefined;
}): boolean {
  if (options.inspectedRootRunId == null) {
    return false;
  }

  return (
    !options.drawerOpen ||
    options.inspectedRootRunId !== options.selectedRootRunId
  );
}
