import { useCallback, useEffect, useRef } from 'react';

/** Component-local UI intent only. Never decides whether a write committed. */
export function useWorkflowLibraryActionLifetime(scope: unknown) {
  const state = useRef({ scope, revision: 0, live: true });
  if (state.current.scope !== scope) {
    state.current.scope = scope;
    state.current.revision++;
  }
  useEffect(() => {
    state.current.live = true;
    return () => {
      state.current.live = false;
      state.current.revision++;
    };
  }, []);
  return useCallback(() => {
    const revision = ++state.current.revision;
    return () => state.current.live && state.current.revision === revision;
  }, []);
}
