import { useCallback, useState } from 'react';

export function useRunRecordingsModalState() {
  const [open, setOpen] = useState(false);
  const [retained, setRetained] = useState(false);
  const [foundCount, setFoundCount] = useState(0);
  const [resetToken, setResetToken] = useState(0);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    setOpen(false);
    setRetained(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setRetained(false);
    setFoundCount(0);
    setResetToken((current) => current + 1);
  }, []);

  return {
    close,
    foundCount,
    hide,
    open,
    resetToken,
    retained,
    setFoundCount,
    show,
  };
}
