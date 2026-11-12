import { useCallback, useEffect, useRef, useState } from 'react';
import {
  bundleComparisonPairKey,
  type BundleComparisonEditorState,
  type BundleComparisonManifest,
  type BundleComparisonOwner,
  type BundleComparisonPair,
  type BundleComparisonSend,
} from '../../studio-server-shared/workflow-bundle-comparison-types';
import type { BundleComparisonSetup } from './WorkflowBundleCompareModal';
import { readBundleComparison } from './bundleComparisonApi';

export type BundleComparisonSession = BundleComparisonSetup & { id: string };
export function useWorkflowBundleComparison(
  send: BundleComparisonSend,
  editorState: BundleComparisonEditorState,
  editorInstanceId?: string | null,
) {
  const [session, setSession] = useState<BundleComparisonSession | null>(null);
  const sessionRef = useRef(session);
  const latestProject = useRef(editorState.projectId);
  latestProject.current = editorState.projectId;
  const [modal, setModal] = useState<{ newerBundleId: string; initial?: BundleComparisonSetup } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef<{ sessionId: string } | null>(null);
  const generation = useRef(0);
  const owner = useRef<BundleComparisonOwner | null>(null);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refreshAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  // Actual displayed project, or the navigation baseline when nothing is attached.
  const sessionProject = useRef<string | null>(null);
  const instance = useRef(editorInstanceId);
  const updateSession = useCallback((next: BundleComparisonSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
  const exit = useCallback(() => {
    const current = sessionRef.current;
    const pendingSession = pendingRef.current?.sessionId;
    const epoch = ++generation.current;
    refreshAbort.current?.abort();
    pendingRef.current = null;
    owner.current = null;
    sessionProject.current = null;
    sessionRef.current = null;
    selectedRef.current = null;
    setSession(null);
    setSelected(null);
    setPending(null);
    setModal(null);
    setError('');
    setErrors({});
    if (current || pendingSession)
      void send({
        action: 'stop',
        owner: { sessionId: current?.id ?? pendingSession!, generation: epoch },
      }).then((result) => {
        if (alive.current && generation.current === epoch && result?.error) setError(result.error);
      });
  }, [send]);
  useEffect(() => {
    const previous = instance.current;
    instance.current = editorInstanceId;
    if (previous && previous !== editorInstanceId) exit();
  }, [editorInstanceId, exit]);
  const open = useCallback(
    async (next: BundleComparisonSession, pair: BundleComparisonPair, preferredGraphId?: string) => {
      refreshAbort.current?.abort();
      const epoch = ++generation.current;
      const key = bundleComparisonPairKey(pair);
      const older = next.manifest.older.projects.find((p) => p.projectId === pair.olderId);
      if (pair.olderId && !older) {
        setError('The Older project is unavailable. Review matching.');
        return;
      }
      pendingRef.current = { sessionId: next.id };
      setPending(key);
      setError('');
      const result = await send({
        action: 'open',
        intent: {
          sessionId: next.id,
          generation: epoch,
          preferredGraphId,
          pair: {
            older: older
              ? { bundleId: next.manifest.older.bundleId, projectId: older.projectId, revisionId: older.revisionId }
              : null,
            newer: pair.newerId ? { bundleId: next.manifest.newer.bundleId, projectId: pair.newerId } : null,
          },
          pairs: next.pairs,
          labels: {
            referenceLabel: `${next.manifest.older.name} · Older (saved)`,
            currentLabel: `${next.manifest.newer.name} · Newer`,
          },
          referenceCatalog: next.manifest.older,
        },
      });
      if (!alive.current || generation.current !== epoch) return;
      if (result?.cancelled) {
        exit();
        return;
      }
      pendingRef.current = null;
      setPending(null);
      if (!result || result.error || result.owner?.sessionId !== next.id || result.owner.generation !== epoch) {
        const message =
          result?.error ??
          'The editor has not confirmed this comparison. Check the active tab or exit comparison before trying again.';
        setError(message);
        setErrors((previous) => ({ ...previous, [key]: message }));
        if (!result || !result.error) {
          // An uncertain acknowledgement is never permission to replay an open.
          // Invalidate that in-flight intent before offering another selection.
          owner.current = null;
          selectedRef.current = null;
          setSelected(null);
          void send({ action: 'stop', owner: { sessionId: next.id, generation: ++generation.current } });
        }
        if (
          !owner.current ||
          result?.owner?.sessionId !== owner.current.sessionId ||
          result?.owner?.generation !== owner.current.generation ||
          result?.projectId !== sessionProject.current
        ) {
          owner.current = null;
          selectedRef.current = null;
          setSelected(null);
          sessionProject.current = result ? result.projectId : latestProject.current;
        }
        if (!sessionRef.current) updateSession(next);
        return;
      }
      owner.current = result.owner;
      sessionProject.current = result.projectId;
      // Availability errors belong to the reviewed versions and mapping.
      const sameReview = sessionRef.current?.manifest === next.manifest && sessionRef.current?.pairs === next.pairs;
      updateSession(next);
      selectedRef.current = key;
      setSelected(key);
      setErrors((previous) => {
        if (!sameReview) return {};
        const copy = { ...previous };
        delete copy[key];
        return copy;
      });
    },
    [send, updateSession, exit],
  );
  const apply = (setup: BundleComparisonSetup) => {
    setModal(null);
    const existingId = sessionRef.current?.id ?? pendingRef.current?.sessionId;
    const next = { ...setup, id: existingId ?? crypto.randomUUID() };
    const previous = sessionRef.current?.pairs.find((p) => bundleComparisonPairKey(p) === selectedRef.current);
    const pair = next.pairs.find((p) => p.newerId && p.newerId === previous?.newerId) ?? next.pairs[0];
    if (pair) void open(next, pair);
    else {
      const epoch = ++generation.current;
      refreshAbort.current?.abort();
      updateSession(next);
      owner.current = null;
      sessionProject.current = editorState.projectId;
      setSelected(null);
      selectedRef.current = null;
      setError('');
      setErrors({});
      if (existingId) {
        // Stopping an Older-only inspection may reactivate its real return tab.
        // Establish the empty session's baseline after that owned transition.
        pendingRef.current = { sessionId: existingId };
        setPending('empty');
        void send({ action: 'stop', owner: { sessionId: existingId, generation: epoch } }).then((result) => {
          if (!alive.current || generation.current !== epoch) return;
          if (result) sessionProject.current = result.projectId;
          if (result?.error) setError(result.error);
          pendingRef.current = null;
          setPending(null);
        });
      } else {
        pendingRef.current = null;
        setPending(null);
      }
    }
  };
  const refresh = async (swap = false) => {
    const current = sessionRef.current;
    if (!current) return;
    refreshAbort.current?.abort();
    const abort = new AbortController();
    refreshAbort.current = abort;
    setError('');
    try {
      const manifest = await readBundleComparison<BundleComparisonManifest>(
        'manifest',
        {
          olderId: swap ? current.manifest.newer.bundleId : current.manifest.older.bundleId,
          newerId: swap ? current.manifest.older.bundleId : current.manifest.newer.bundleId,
        },
        abort.signal,
      );
      if (!alive.current || abort.signal.aborted || sessionRef.current !== current) return;
      const pairs = swap ? current.pairs.map((p) => ({ olderId: p.newerId, newerId: p.olderId })) : current.pairs;
      const before = pairs.flatMap((p) => (p.olderId ? [p.olderId] : [])),
        after = pairs.flatMap((p) => (p.newerId ? [p.newerId] : []));
      if (
        before.length !== manifest.older.projects.length ||
        after.length !== manifest.newer.projects.length ||
        manifest.older.projects.some((p) => !before.includes(p.projectId)) ||
        manifest.newer.projects.some((p) => !after.includes(p.projectId))
      ) {
        setModal({ newerBundleId: manifest.newer.bundleId, initial: { manifest, pairs } });
        setError('Bundle membership changed. Review project matching.');
        return;
      }
      const next = { ...current, manifest, pairs };
      const selectedPair = current.pairs.find((p) => bundleComparisonPairKey(p) === selectedRef.current);
      const pair = selectedPair
        ? swap
          ? { olderId: selectedPair.newerId, newerId: selectedPair.olderId }
          : selectedPair
        : pairs[0];
      if (pair) void open(next, pair);
      else updateSession(next);
    } catch (failure) {
      if (alive.current && !abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : 'Could not refresh Older versions.');
    }
  };
  useEffect(() => {
    const current = sessionRef.current;
    if (!current || pendingRef.current) return;
    if (!current.pairs.length || !owner.current) {
      if (editorState.projectId !== sessionProject.current) exit();
      return;
    }
    if (editorState.owner?.sessionId !== current.id) {
      exit();
      return;
    }
    if (editorState.owner.generation < owner.current.generation) return;
    if (sessionProject.current === editorState.projectId) return;
    const target = current.pairs.find((p) => p.newerId === editorState.projectId);
    if (target) void open(current, target);
    else exit();
  }, [editorState, pending, open, exit]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      refreshAbort.current?.abort();
      generation.current++;
      const id = sessionRef.current?.id ?? pendingRef.current?.sessionId;
      if (id) void send({ action: 'stop', owner: { sessionId: id, generation: generation.current } });
    };
  }, [send]);
  const navigate = useCallback(
    (projectId: string, graphId: string) => {
      const current = sessionRef.current;
      if (!current) return false;
      const pair = current.pairs.find((p) => p.newerId === projectId || p.olderId === projectId);
      if (!pair) {
        exit();
        return false;
      }
      void open(current, pair, graphId);
      return true;
    },
    [open, exit],
  );
  return {
    session,
    modal,
    selected,
    pending,
    error,
    errors,
    navigate,
    exit,
    apply,
    begin: (newerBundleId: string, element?: HTMLElement) => {
      refreshAbort.current?.abort();
      opener.current = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setModal({ newerBundleId });
    },
    closeModal: () => {
      setModal(null);
      requestAnimationFrame(() => {
        if (opener.current?.isConnected) opener.current.focus();
      });
    },
    edit: () => {
      refreshAbort.current?.abort();
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const current = sessionRef.current;
      if (current) setModal({ newerBundleId: current.manifest.newer.bundleId, initial: current });
    },
    select: (pair: BundleComparisonPair) => {
      const current = sessionRef.current;
      if (current) void open(current, pair);
    },
    swap: () => void refresh(true),
    refresh: () => void refresh(false),
  };
}
