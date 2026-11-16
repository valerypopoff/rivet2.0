import { useCallback, useEffect, useRef, type RefCallback } from 'react';

type SelectHandle = { blur(): void };

/** Close an open popup whose placement was measured before the viewport resized. */
export function useSelectResizeDismissal(open: boolean): RefCallback<SelectHandle> {
  const select = useRef<SelectHandle | null>(null);
  const bindSelect = useCallback((instance: SelectHandle | null) => {
    select.current = instance;
  }, []);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => select.current?.blur();
    window.addEventListener('resize', dismiss);
    return () => window.removeEventListener('resize', dismiss);
  }, [open]);

  return bindSelect;
}
