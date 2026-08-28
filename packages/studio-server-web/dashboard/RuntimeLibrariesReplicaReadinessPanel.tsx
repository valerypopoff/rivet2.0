import Button from '@atlaskit/button';
import { useState, type FC } from 'react';

import type {
  RuntimeLibraryReplicaReadinessState,
  RuntimeLibraryReplicaStatus,
  RuntimeLibraryReplicaTierState,
} from './runtimeLibrariesApi';

interface RuntimeLibrariesReplicaReadinessPanelProps {
  readiness: RuntimeLibraryReplicaReadinessState | null | undefined;
  isJobActive: boolean;
  clearingStaleReplicas: boolean;
  nowMs: number;
  onClearStaleReplicas: () => void;
}

type ExpandedTierState = {
  endpoint: boolean;
  editor: boolean;
};

function formatAge(nowMs: number, iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return 'unknown';
  }

  const ageSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1_000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }

  const minutes = Math.floor(ageSeconds / 60);
  const seconds = ageSeconds % 60;
  return `${minutes}m ${seconds}s ago`;
}

function formatTierLabel(tier: RuntimeLibraryReplicaTierState['tier']): string {
  return tier === 'endpoint' ? 'Endpoint execution replicas' : 'Editor execution replicas';
}

function formatReleaseShortId(releaseId: string | null): string | null {
  if (!releaseId) {
    return null;
  }

  return releaseId.slice(0, 8);
}

function getSummaryTone(tier: RuntimeLibraryReplicaTierState): 'succeeded' | 'warning' | 'failed' | 'idle' {
  if (tier.liveReplicaCount === 0) {
    return 'idle';
  }

  if (tier.replicas.some((replica) => replica.syncState === 'error')) {
    return 'failed';
  }

  if (tier.readyReplicaCount === tier.liveReplicaCount) {
    return 'succeeded';
  }

  return 'warning';
}

function getReplicaTone(replica: RuntimeLibraryReplicaStatus): 'succeeded' | 'warning' | 'failed' | 'idle' {
  if (replica.syncState === 'error') {
    return 'failed';
  }

  if (replica.syncState === 'ready' && replica.isReadyForActiveRelease) {
    return 'succeeded';
  }

  if (replica.syncState === 'starting' || replica.syncState === 'syncing') {
    return 'warning';
  }

  return 'idle';
}

function formatReplicaSyncState(syncState: RuntimeLibraryReplicaStatus['syncState']): string {
  if (syncState === 'starting') {
    return 'Starting';
  }

  if (syncState === 'syncing') {
    return 'Syncing';
  }

  if (syncState === 'ready') {
    return 'Ready';
  }

  return 'Error';
}

export const RuntimeLibrariesReplicaReadinessPanel: FC<RuntimeLibrariesReplicaReadinessPanelProps> = ({
  readiness,
  isJobActive,
  clearingStaleReplicas,
  nowMs,
  onClearStaleReplicas,
}) => {
  const [expanded, setExpanded] = useState<ExpandedTierState>({
    endpoint: false,
    editor: false,
  });

  if (!readiness) {
    return null;
  }

  const totalStaleReplicaCount = readiness.endpoint.staleReplicaCount + readiness.editor.staleReplicaCount;

  const renderTier = (tier: RuntimeLibraryReplicaTierState) => {
    const tone = getSummaryTone(tier);
    const tierKey = tier.tier;
    const isExpanded = expanded[tierKey];
    const staleNote = tier.staleReplicaCount > 0
      ? `${tier.staleReplicaCount} stale replica${tier.staleReplicaCount === 1 ? '' : 's'} not counted`
      : null;
    const summary = tier.liveReplicaCount > 0
      ? `${tier.readyReplicaCount} / ${tier.liveReplicaCount} ready`
      : `No live ${tier.tier === 'endpoint' ? 'endpoint execution' : 'editor execution'} replicas reported`;

    return (
      <div key={tier.tier} className={`runtime-libraries-status ${tone}`}>
        <div className="runtime-libraries-status-head">
          <span>{formatTierLabel(tier.tier)}</span>
          <span>{summary}</span>
        </div>
        {staleNote ? (
          <div className="runtime-libraries-status-detail">{staleNote}</div>
        ) : null}

        {tier.replicas.length > 0 ? (
          <div className="runtime-libraries-replica-actions">
            <Button
              appearance="subtle"
              spacing="compact"
              className="runtime-libraries-replica-toggle button-size-s"
              onClick={() => setExpanded((previous) => ({
                ...previous,
                [tierKey]: !previous[tierKey],
              }))}
            >
              {isExpanded ? 'Hide details' : 'Show details'}
            </Button>
          </div>
        ) : null}

        {isExpanded && tier.replicas.length > 0 ? (
          <div className="runtime-libraries-replica-list">
            {tier.replicas.map((replica) => {
              const syncedReleaseShortId = formatReleaseShortId(replica.syncedReleaseId);
              return (
                <div
                  key={replica.replicaId}
                  className={`runtime-libraries-replica-item ${getReplicaTone(replica)}`}
                >
                  <div className="runtime-libraries-replica-head">
                    <span className="runtime-libraries-replica-name">{replica.displayName}</span>
                    <span className={`runtime-libraries-replica-badge ${replica.syncState}`}>
                      {formatReplicaSyncState(replica.syncState)}
                    </span>
                  </div>
                  <div className="runtime-libraries-replica-detail">
                    Last heartbeat: {formatAge(nowMs, replica.lastHeartbeatAt)}
                  </div>
                  {!replica.isReadyForActiveRelease && syncedReleaseShortId ? (
                    <div className="runtime-libraries-replica-detail">
                      Synced release: {syncedReleaseShortId}
                    </div>
                  ) : null}
                  {replica.lastError ? (
                    <div className="runtime-libraries-replica-detail">
                      Error: {replica.lastError}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="project-settings-field runtime-libraries-section">
      <div className="runtime-libraries-section-header">
        <label className="project-settings-label">
          Replica readiness
        </label>
        {totalStaleReplicaCount > 0 ? (
          <Button
            appearance="subtle"
            spacing="compact"
            className="runtime-libraries-clear-stale-button button-size-s"
            isDisabled={clearingStaleReplicas}
            onClick={onClearStaleReplicas}
          >
            {clearingStaleReplicas ? 'Clearing stale replicas...' : 'Clear stale replicas'}
          </Button>
        ) : null}
      </div>
      <div className="runtime-libraries-help runtime-libraries-readiness-help">
        Counts are based on replicas that reported within the last {Math.round(readiness.heartbeatTtlMs / 1_000)} seconds.
      </div>
      {isJobActive ? (
        <div className="runtime-libraries-status warning">
          Replica counts reflect the current active release. They will update after the new release is activated.
        </div>
      ) : null}
      <div className="runtime-libraries-replica-summary-grid">
        {renderTier(readiness.endpoint)}
        {renderTier(readiness.editor)}
      </div>
    </div>
  );
};
