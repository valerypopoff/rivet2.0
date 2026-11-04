import { useCallback, useState } from 'react';
import type { WorkflowProjectItem } from './types';

export function useRunRecordingsModalState() {
  const [open, setOpen] = useState(false);
  const [retained, setRetained] = useState(false);
  const [foundCount, setFoundCount] = useState(0);
  const [resetToken, setResetToken] = useState(0);
  const [initialProject, setInitialProject] = useState<WorkflowProjectItem | null>(null);

  const show = useCallback(() => setOpen(true), []);
  const showForProject = useCallback((project: WorkflowProjectItem) => {
    setInitialProject(project);
    setRetained(false);
    setFoundCount(0);
    setResetToken((current) => current + 1);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setOpen(false);
    setRetained(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setRetained(false);
    setFoundCount(0);
    setInitialProject(null);
    setResetToken((current) => current + 1);
  }, []);

  return {
    close,
    foundCount,
    initialProject,
    hide,
    open,
    resetToken,
    retained,
    setFoundCount,
    show,
    showForProject,
  };
}
