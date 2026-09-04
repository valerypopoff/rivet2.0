import { useCallback, useEffect, useState } from 'react';

import {
  clearStaleDeploymentReplicaStatuses,
  fetchDeploymentStatus,
  type DeploymentStatus,
} from './deploymentStatusApi';

const POLL_INTERVAL_MS = 5_000;
const CLOCK_INTERVAL_MS = 1_000;

/** Poll only while the operational Settings section is visible. */
export function useDeploymentStatus(enabled: boolean) {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearingStaleReplicas, setClearingStaleReplicas] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) {
      setLoading(true);
    }

    try {
      const nextStatus = await fetchDeploymentStatus();
      setStatus(nextStatus);
      setError(null);
    } catch (caughtError) {
      if (!background) {
        setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || status?.topology !== 'replicated') {
      return;
    }

    const interval = window.setInterval(() => {
      void refresh({ background: true });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, refresh, status?.topology]);

  // Heartbeat ages are calculated locally. Keep that presentation clock
  // independent from the less-frequent network refresh that changes the
  // replica registry itself.
  useEffect(() => {
    if (!enabled || status?.topology !== 'replicated') {
      return;
    }

    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [enabled, status?.topology]);

  const clearStaleReplicas = useCallback(async () => {
    if (clearingStaleReplicas) {
      return;
    }

    try {
      setClearingStaleReplicas(true);
      setError(null);
      setCleanupMessage(null);
      const result = await clearStaleDeploymentReplicaStatuses();
      setCleanupMessage(
        result.deletedReplicaCount === 0
          ? 'No stale replica records needed cleanup.'
          : `Cleared ${result.deletedReplicaCount} stale replica record${result.deletedReplicaCount === 1 ? '' : 's'}.`,
      );
      await refresh({ background: true });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setClearingStaleReplicas(false);
    }
  }, [clearingStaleReplicas, refresh]);

  return {
    status,
    loading,
    error,
    nowMs,
    clearingStaleReplicas,
    cleanupMessage,
    clearStaleReplicas,
  };
}
