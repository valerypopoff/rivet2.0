import Button from '@atlaskit/button';
import { useState, type FC } from 'react';

import type {
  RuntimeLibraryReplicaReadinessState,
  RuntimeLibraryReplicaStatus,
  RuntimeLibraryReplicaTierState,
} from './runtimeLibrariesApi';

interface DeploymentReplicaReadinessPanelProps {
  readiness: RuntimeLibraryReplicaReadinessState;
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
  return tier === 'endpoint' ? 'Published endpoint replicas' : 'Editor and dashboard replicas';
}

function formatReleaseShortId(releaseId: string | null): string | null {
  return releaseId ? releaseId.slice(0, 8) : null;
}

function getSummaryTone(tier: RuntimeLibraryReplicaTierState): 'ready' | 'warning' | 'error' | 'neutral' {
  if (tier.liveReplicaCount === 0) {
    return 'neutral';
  }

  if (tier.replicas.some((replica) => replica.syncState === 'error')) {
    return 'error';
  }

  return tier.readyReplicaCount === tier.liveReplicaCount ? 'ready' : 'warning';
}

function getReplicaTone(replica: RuntimeLibraryReplicaStatus): 'ready' | 'warning' | 'error' | 'neutral' {
  if (replica.syncState === 'error') {
    return 'error';
  }

  if (replica.syncState === 'ready' && replica.isReadyForActiveRelease) {
    return 'ready';
  }

  return replica.syncState === 'starting' || replica.syncState === 'syncing' ? 'warning' : 'neutral';
}

function formatReplicaSyncState(syncState: RuntimeLibraryReplicaStatus['syncState']): string {
  return syncState === 'starting' ? 'Starting' :
    syncState === 'syncing' ? 'Syncing' :
      syncState === 'ready' ? 'Ready' : 'Error';
}

export const DeploymentReplicaReadinessPanel: FC<DeploymentReplicaReadinessPanelProps> = ({
  readiness,
  clearingStaleReplicas,
  nowMs,
  onClearStaleReplicas,
}) => {
  const [expanded, setExpanded] = useState<ExpandedTierState>({ endpoint: false, editor: false });
  const totalStaleReplicaCount = readiness.endpoint.staleReplicaCount + readiness.editor.staleReplicaCount;

  const renderTier = (tier: RuntimeLibraryReplicaTierState) => {
    const tone = getSummaryTone(tier);
    const isExpanded = expanded[tier.tier];
    const summary = tier.liveReplicaCount > 0
      ? `${tier.readyReplicaCount} / ${tier.liveReplicaCount} synchronized`
      : 'No live replicas reported';

    return (
      <section key={tier.tier} className={`deployment-status-replica-tier ${tone}`}>
        <div className="deployment-status-replica-tier-head">
          <span>{formatTierLabel(tier.tier)}</span>
          <span>{summary}</span>
        </div>
        {tier.staleReplicaCount > 0 ? (
          <div className="deployment-status-replica-detail">
            {tier.staleReplicaCount} stale replica{tier.staleReplicaCount === 1 ? '' : 's'} not counted
          </div>
        ) : null}
        {tier.replicas.length > 0 ? (
          <Button
            appearance="subtle"
            spacing="compact"
            className="deployment-status-replica-toggle button-size-s"
            onClick={() => setExpanded((previous) => ({ ...previous, [tier.tier]: !previous[tier.tier] }))}
          >
            {isExpanded ? 'Hide replica details' : 'Show replica details'}
          </Button>
        ) : null}
        {isExpanded ? (
          <div className="deployment-status-replica-list">
            {tier.replicas.map((replica) => {
              const syncedReleaseShortId = formatReleaseShortId(replica.syncedReleaseId);
              return (
                <div key={replica.replicaId} className={`deployment-status-replica-item ${getReplicaTone(replica)}`}>
                  <div className="deployment-status-replica-item-head">
                    <span className="deployment-status-replica-name">{replica.displayName}</span>
                    <span className={`deployment-status-replica-badge ${replica.syncState}`}>
                      {formatReplicaSyncState(replica.syncState)}
                    </span>
                  </div>
                  <div className="deployment-status-replica-detail">Last synchronization heartbeat: {formatAge(nowMs, replica.lastHeartbeatAt)}</div>
                  {!replica.isReadyForActiveRelease && syncedReleaseShortId ? (
                    <div className="deployment-status-replica-detail">Synced release: {syncedReleaseShortId}</div>
                  ) : null}
                  {replica.lastError ? (
                    <div className="deployment-status-replica-detail">Error: {replica.lastError}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <section className="app-settings-section deployment-status-section" aria-label="Code runtime synchronization">
      <div className="deployment-status-section-header">
        <div>
          <div className="app-settings-section-title">Code runtime synchronization</div>
          <div className="app-settings-field-help">
            The list shows replicas that reported within the last {Math.round(readiness.heartbeatTtlMs / 1_000)} seconds and synchronized the active Code-node library release. It is not a Kubernetes pod-health or autoscaling view.
          </div>
        </div>
        {totalStaleReplicaCount > 0 ? (
          <Button
            appearance="subtle"
            spacing="compact"
            className="deployment-status-clear-stale button-size-s"
            isDisabled={clearingStaleReplicas}
            onClick={onClearStaleReplicas}
          >
            {clearingStaleReplicas ? 'Clearing stale replicas...' : 'Clear stale replicas'}
          </Button>
        ) : null}
      </div>
      <div className="deployment-status-replica-grid">
        {renderTier(readiness.endpoint)}
        {renderTier(readiness.editor)}
      </div>
    </section>
  );
};
