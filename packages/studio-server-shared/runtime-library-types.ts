export interface RuntimeLibraryEntry {
  name: string;
  version: string;
  installedAt?: string;
}

export interface RuntimeLibraryPackageSpec {
  name: string;
  version: string;
}

export type JobStatus = 'queued' | 'running' | 'validating' | 'activating' | 'succeeded' | 'failed';
export type RuntimeLibraryLogSource = 'stdout' | 'stderr' | 'system';

export type RuntimeLibrariesBackendMode = 'filesystem' | 'managed';
export type RuntimeLibraryJobType = 'install' | 'remove';
export type RuntimeLibraryReplicaTier = 'endpoint' | 'editor';
export type RuntimeLibraryProcessRole = 'api' | 'executor';
export type RuntimeLibraryReplicaSyncState = 'starting' | 'syncing' | 'ready' | 'error';

export interface RuntimeLibraryJobLogEntry {
  message: string;
  createdAt: string;
  source: RuntimeLibraryLogSource;
}

export interface RuntimeLibraryJobState {
  id: string;
  type: RuntimeLibraryJobType;
  status: JobStatus;
  packages: RuntimeLibraryPackageSpec[];
  logs: string[];
  logEntries: RuntimeLibraryJobLogEntry[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  releaseId?: string | null;
  lastProgressAt: string;
  cancelRequestedAt?: string | null;
}

export interface RuntimeLibraryReplicaStatus {
  replicaId: string;
  tier: RuntimeLibraryReplicaTier;
  processRole: RuntimeLibraryProcessRole;
  displayName: string;
  hostname: string;
  podName?: string;
  targetReleaseId: string | null;
  syncedReleaseId: string | null;
  syncState: RuntimeLibraryReplicaSyncState;
  isReadyForActiveRelease: boolean;
  lastHeartbeatAt: string;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastError?: string;
}

export interface RuntimeLibraryReplicaTierState {
  tier: RuntimeLibraryReplicaTier;
  liveReplicaCount: number;
  readyReplicaCount: number;
  staleReplicaCount: number;
  replicas: RuntimeLibraryReplicaStatus[];
}

export interface RuntimeLibraryReplicaReadinessState {
  activeReleaseId: string | null;
  heartbeatTtlMs: number;
  endpoint: RuntimeLibraryReplicaTierState;
  editor: RuntimeLibraryReplicaTierState;
}

export interface RuntimeLibraryReplicaCleanupResult {
  deletedReplicaCount: number;
  deletedReplicaIds: string[];
  staleBefore: string;
}

export interface RuntimeLibrariesState {
  backend: RuntimeLibrariesBackendMode;
  packages: Record<string, RuntimeLibraryEntry>;
  hasActiveLibraries: boolean;
  updatedAt: string;
  activeJob: RuntimeLibraryJobState | null;
  activeReleaseId?: string | null;
  replicaReadiness?: RuntimeLibraryReplicaReadinessState | null;
}
