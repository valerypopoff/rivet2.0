import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  cancelJob,
  clearStaleReplicaStatuses,
  fetchJob,
  fetchRuntimeLibraries,
  installPackages,
  removePackages,
  type JobState,
  type RuntimeLibrariesState,
  type RuntimeLibraryJobLogEntry,
} from './runtimeLibrariesApi';
import {
  mergeRuntimeLibraryLogEntries,
  openRuntimeLibrariesJobStream,
  patchRuntimeLibrariesJobLogState,
  patchRuntimeLibrariesJobStatusState,
} from './runtimeLibrariesJobStream';

export function useRuntimeLibrariesModalState(isOpen: boolean) {
  const STALLED_THRESHOLD_MS = 45_000;
  const [state, setState] = useState<RuntimeLibrariesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [addVersion, setAddVersion] = useState('latest');
  const [showInstallForm, setShowInstallForm] = useState(false);
  const [activeJob, setActiveJob] = useState<JobState | null>(null);
  const [logEntries, setLogEntries] = useState<RuntimeLibraryJobLogEntry[]>([]);
  const [jobResult, setJobResult] = useState<{
    status: 'succeeded' | 'failed';
    error?: string;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [cancellingJob, setCancellingJob] = useState(false);
  const [clearingStaleReplicas, setClearingStaleReplicas] = useState(false);

  const logPanelRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const wasOpenRef = useRef(false);
  const trackedJobIdRef = useRef<string | null>(null);
  const retainedJobRef = useRef<JobState | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refreshActiveStateSilentlyRef = useRef<(jobId?: string) => Promise<void>>(async () => {});

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const applyJobState = useCallback((job: JobState | null) => {
    setActiveJob(job);
    retainedJobRef.current = job;
    if (job) {
      trackedJobIdRef.current = job.id;
      setLogEntries((prev) => mergeRuntimeLibraryLogEntries([], job.logEntries ?? prev));
      return;
    }

    trackedJobIdRef.current = null;
    setLogEntries([]);
  }, []);

  const updateDisplayedJob = useCallback((transform: (base: JobState) => JobState) => {
    setActiveJob((prev) => {
      const base = prev ?? retainedJobRef.current;
      if (!base) {
        return prev;
      }

      const next = transform(base);
      retainedJobRef.current = next;
      return next;
    });
  }, []);

  const startStreaming = useCallback((jobId: string) => {
    closeStream();

    eventSourceRef.current = openRuntimeLibrariesJobStream(
      jobId,
      {
        onLog: (entry) => {
          setLogEntries((prev) => {
            const mergedEntries = mergeRuntimeLibraryLogEntries(prev, [entry]);
            updateDisplayedJob((base) => patchRuntimeLibrariesJobLogState(base, mergedEntries, entry.createdAt));
            return mergedEntries;
          });
        },
        onStatus: (event) => {
          updateDisplayedJob((base) => patchRuntimeLibrariesJobStatusState(base, {
            status: event.status,
            createdAt: event.createdAt,
            cancelRequestedAt: event.cancelRequestedAt,
          }));
        },
        onDone: (event) => {
          setJobResult({ status: event.status as 'succeeded' | 'failed', error: event.error });
          setCancellingJob(false);
          trackedJobIdRef.current = jobId;
          updateDisplayedJob((base) => patchRuntimeLibrariesJobStatusState(base, {
            status: event.status as 'succeeded' | 'failed',
            error: event.error,
            createdAt: event.createdAt,
            cancelRequestedAt: event.cancelRequestedAt,
          }));
          void refreshRef.current();
        },
        onError: () => {
          void refreshActiveStateSilentlyRef.current(jobId);
        },
      },
    );
  }, [closeStream, updateDisplayedJob]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchRuntimeLibraries();
      setState(data);

      if (data.activeJob && data.activeJob.status !== 'succeeded' && data.activeJob.status !== 'failed') {
        applyJobState(data.activeJob);
        startStreaming(data.activeJob.id);
      } else {
        closeStream();
        applyJobState(data.activeJob ?? retainedJobRef.current ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyJobState, closeStream, startStreaming]);

  const refreshActiveStateSilently = useCallback(async (jobId?: string) => {
    try {
      const trackedJobId = jobId ?? trackedJobIdRef.current ?? undefined;
      const [data, currentJob] = await Promise.all([
        fetchRuntimeLibraries(),
        trackedJobId ? fetchJob(trackedJobId).catch(() => null) : Promise.resolve(null),
      ]);

      setState(data);

      if (currentJob) {
        applyJobState(currentJob);
        if (currentJob.status === 'succeeded' || currentJob.status === 'failed') {
          setJobResult({ status: currentJob.status, error: currentJob.error });
          setCancellingJob(false);
          if (!data.activeJob) {
            closeStream();
          }
        } else if (trackedJobIdRef.current !== currentJob.id || eventSourceRef.current == null) {
          startStreaming(currentJob.id);
        }
      } else if (data.activeJob) {
        applyJobState(data.activeJob);
        if (data.activeJob.status !== 'succeeded' && data.activeJob.status !== 'failed' && eventSourceRef.current == null) {
          startStreaming(data.activeJob.id);
        }
      } else {
        closeStream();
        applyJobState(retainedJobRef.current ?? null);
      }

      setError(null);
    } catch {
      // keep existing UI state on background refresh failures
    }
  }, [applyJobState, closeStream, startStreaming]);

  refreshRef.current = refresh;
  refreshActiveStateSilentlyRef.current = refreshActiveStateSilently;

  const displayedJob = activeJob ?? retainedJobRef.current;
  const isJobActive = displayedJob != null &&
    displayedJob.status !== 'succeeded' &&
    displayedJob.status !== 'failed';

  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      void refresh();
    } else if (wasOpenRef.current) {
      closeStream();
      setActiveJob(null);
      setLogEntries([]);
      setJobResult(null);
      setShowInstallForm(false);
      setCancellingJob(false);
      setClearingStaleReplicas(false);
      trackedJobIdRef.current = null;
      retainedJobRef.current = null;
      wasOpenRef.current = false;
    }

    return () => {
      closeStream();
    };
  }, [closeStream, isOpen, refresh]);

  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [logEntries]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const tick = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(tick);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const interval = setInterval(() => {
      void refreshActiveStateSilently(activeJob?.id);
    }, 5_000);
    return () => clearInterval(interval);
  }, [activeJob?.id, isOpen, refreshActiveStateSilently]);

  const handleInstall = useCallback(async () => {
    if (!addName.trim()) {
      return;
    }

    try {
      setError(null);
      setJobResult(null);
      const job = await installPackages([{ name: addName.trim(), version: addVersion.trim() || 'latest' }]);
      applyJobState(job);
      startStreaming(job.id);
      setAddName('');
      setAddVersion('latest');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [addName, addVersion, applyJobState, startStreaming]);

  const handleRemove = useCallback(async (packageName: string) => {
    try {
      setError(null);
      setJobResult(null);
      const job = await removePackages([packageName]);
      applyJobState(job);
      startStreaming(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyJobState, startStreaming]);

  const handleCancel = useCallback(async () => {
    if (!displayedJob || !isJobActive || cancellingJob) {
      return;
    }

    try {
      setCancellingJob(true);
      setError(null);
      const job = await cancelJob(displayedJob.id);
      applyJobState(job);
      if (job.status === 'failed' || job.status === 'succeeded') {
        setJobResult({ status: job.status, error: job.error });
        setCancellingJob(false);
        void refresh();
      }
    } catch (err) {
      setCancellingJob(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyJobState, cancellingJob, displayedJob, isJobActive, refresh]);

  const handleClearStaleReplicas = useCallback(async () => {
    if (clearingStaleReplicas) {
      return;
    }

    try {
      setClearingStaleReplicas(true);
      setError(null);
      await clearStaleReplicaStatuses();
      await refreshActiveStateSilently(activeJob?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearingStaleReplicas(false);
    }
  }, [activeJob?.id, clearingStaleReplicas, refreshActiveStateSilently]);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isJobActive && addName.trim()) {
      e.preventDefault();
      void handleInstall();
    }
  }, [addName, handleInstall, isJobActive]);

  const packages = state ? Object.values(state.packages) : [];
  const lastProgressAtMs = displayedJob?.lastProgressAt ? new Date(displayedJob.lastProgressAt).getTime() : null;
  const isStalled = isJobActive && lastProgressAtMs != null && nowMs - lastProgressAtMs > STALLED_THRESHOLD_MS;

  return {
    state,
    loading,
    error,
    addName,
    addVersion,
    showInstallForm,
    displayedJob,
    logEntries,
    jobResult,
    cancellingJob,
    clearingStaleReplicas,
    isJobActive,
    isStalled,
    nowMs,
    packages,
    replicaReadiness: state?.replicaReadiness ?? null,
    logPanelRef,
    setAddName,
    setAddVersion,
    setShowInstallForm,
    handleInstall,
    handleRemove,
    handleCancel,
    handleClearStaleReplicas,
    handleKeyDown,
  };
}
