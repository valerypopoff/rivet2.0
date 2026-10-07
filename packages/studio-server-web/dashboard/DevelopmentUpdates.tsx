import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { nanoid } from 'nanoid';
import { isValidBridgeOrigin } from '../../studio-server-shared/editor-bridge';
import { getDevelopmentGeneration, type DevelopmentRefreshWindow } from './developmentRefreshGuard';

type BuildStatus = {
  session: string;
  generation: string | null;
  phase: 'building' | 'ready' | 'failed';
  error: string | null;
};

function dashboardHasPendingInput() {
  // Blur does not make an unsubmitted form or an in-flight rename disposable.
  // Ignore retained but hidden UI so it cannot permanently block updates.
  return [
    ...document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], dialog[open], [aria-busy="true"], form, input:focus, textarea:focus, select:focus, [contenteditable="true"]:focus',
    ),
  ].some((element) => element.getClientRects().length > 0);
}

export function DevelopmentUpdates({
  iframeRef,
  editorReady,
}: {
  iframeRef: RefObject<HTMLIFrameElement>;
  editorReady: boolean;
}) {
  return import.meta.env.VITE_TUNNEL_DEV === 'true' ? (
    <TunnelDevelopmentUpdates iframeRef={iframeRef} editorReady={editorReady} />
  ) : null;
}

function TunnelDevelopmentUpdates({
  iframeRef,
  editorReady,
}: {
  iframeRef: RefObject<HTMLIFrameElement>;
  editorReady: boolean;
}) {
  const [status, setStatus] = useState<BuildStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [deferred, setDeferred] = useState(false);
  const pending = useRef<{ id: string; generation: string; session: string; timer: ReturnType<typeof setTimeout> }>();
  const current = useRef<BuildStatus | null>(null);
  const seen = useRef('');
  const cancel = useCallback(() => {
    if (pending.current) {
      clearTimeout(pending.current.timer);
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'cancel-development-refresh', requestId: pending.current.id },
        window.location.origin,
      );
      pending.current = undefined;
    }
    setChecking(false);
  }, [iframeRef]);
  const prepare = useCallback(() => {
    const build = current.current;
    const target = iframeRef.current?.contentWindow;
    // Dashboard modals and inline forms are not owned by the editor checkpoint.
    if (dashboardHasPendingInput()) {
      setDeferred(true);
      return;
    }
    if (!build?.generation || build.phase !== 'ready' || !target || !editorReady) {
      setDeferred(true);
      return;
    }
    cancel();
    const id = nanoid();
    const timer = setTimeout(() => {
      cancel();
      setDeferred(true);
    }, 5_000);
    pending.current = { id, generation: build.generation, session: build.session, timer };
    setChecking(true);
    target.postMessage({ type: 'prepare-development-refresh', requestId: id }, window.location.origin);
  }, [cancel, editorReady, iframeRef]);
  useEffect(() => {
    if (!checking) return;
    const block = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [checking]);
  useEffect(() => {
    if (import.meta.env.VITE_TUNNEL_DEV !== 'true' || !getDevelopmentGeneration()) return;
    // Reconnection reports status; only a successful new generation can refresh.
    const events = new EventSource('/__rivet_dev/events');
    events.onmessage = (event) => {
      let build: BuildStatus;
      try {
        build = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        !build ||
        !['building', 'ready', 'failed'].includes(build.phase) ||
        typeof build.session !== 'string' ||
        (build.generation !== null && typeof build.generation !== 'string')
      )
        return;
      if (
        pending.current &&
        (build.generation !== pending.current.generation ||
          build.session !== pending.current.session ||
          build.phase !== 'ready')
      )
        cancel();
      current.current = build;
      setStatus(build);
    };
    events.onerror = () => {
      cancel();
      setStatus((previous) => ({
        session: previous?.session ?? '',
        generation: previous?.generation ?? getDevelopmentGeneration(),
        phase: 'failed',
        error: 'Build connection interrupted. Reconnecting; the current frontend remains available.',
      }));
    };
    return () => {
      events.close();
      cancel();
    };
  }, [cancel]);
  useEffect(() => {
    if (!status || status.phase !== 'ready' || !status.generation || status.generation === getDevelopmentGeneration())
      return;
    const key = `${status.session}/${status.generation}`;
    if (editorReady && seen.current !== key) {
      seen.current = key;
      setDeferred(false);
      prepare();
    }
  }, [status, editorReady, prepare]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        !isValidBridgeOrigin(event, iframeRef.current?.contentWindow ?? null) ||
        event.data?.type !== 'development-refresh-prepared'
      )
        return;
      const request = pending.current;
      if (!request || event.data.requestId !== request.id) return;
      let ready = false;
      try {
        ready =
          event.data.ready === true &&
          (iframeRef.current?.contentWindow as DevelopmentRefreshWindow | null)?.__rivetDevelopmentRefreshReady?.(
            request.id,
          ) === true;
      } catch {
        /* unavailable editor must not reload */
      }
      if (
        ready &&
        !dashboardHasPendingInput() &&
        current.current?.phase === 'ready' &&
        current.current.session === request.session &&
        current.current.generation === request.generation
      ) {
        // Navigation can be cancelled by beforeunload or blocked by the browser.
        // Keep the expiry alive until this document actually unloads so a failed
        // refresh cannot leave the dashboard shield and keyboard lock forever.
        const url = new URL(window.location.href);
        url.searchParams.delete('devBuild');
        window.location.replace(url.href);
      } else {
        cancel();
        setDeferred(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [cancel, iframeRef]);
  if (!status || (status.phase === 'ready' && status.generation === getDevelopmentGeneration())) return null;
  return (
    <div className="development-update" role="status">
      {status.phase === 'building'
        ? 'Building frontend… You can keep working.'
        : status.phase === 'failed'
          ? status.error || 'Frontend build failed; the current version is still available.'
          : checking
            ? 'Checking workspace before refresh…'
            : deferred
              ? 'Frontend update ready. Save changes and finish running work before refreshing.'
              : 'Frontend update ready.'}
      {status.phase === 'ready' && !checking ? (
        <button type="button" className="dashboard-button" onClick={prepare}>
          Refresh when safe
        </button>
      ) : null}
      {checking ? <div className="development-update-shield" aria-hidden="true" /> : null}
    </div>
  );
}
