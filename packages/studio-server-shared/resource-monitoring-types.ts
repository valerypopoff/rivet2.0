export type ResourceSource = 'cgroup-v2' | 'cgroup-v1' | 'node-process';
export type ResourceRole = 'execution' | 'control' | 'combined';
export type ResourcePeriod = '1h' | '24h' | '7d';

export interface ResourceIdentity {
  installation: string;
  incarnation: string;
  role: ResourceRole;
  name: string;
  source: ResourceSource;
}

export interface ResourceAllocation {
  cpuRequestMillicores: number | null;
  memoryRequestBytes: number | null;
  cpuLimitMillicores: number | null;
  memoryLimitBytes: number | null;
}

/** CPU is a rate over durationMs; memory is the gauge observed at at. */
export interface ResourceSample {
  at: number;
  durationMs: number;
  cpuMillicores: number | null;
  memoryBytes: number;
  workingSetBytes: number | null;
  lifetimeMemoryPeakBytes: number | null;
  activeRuns: number | null;
  runLimit: number | null;
}

export interface ResourceMinute {
  at: number;
  revision: number;
  samples: ResourceSample[];
}

export interface ResourceReport {
  identity: ResourceIdentity;
  allocation: ResourceAllocation;
  buckets: ResourceMinute[];
  droppedSamples: number;
}

export interface ResourceStatistics {
  average: number | null;
  p95: number | null;
  peak: number | null;
  coverageMs: number;
}

export interface ResourceHistoryPoint {
  at: number;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  workingSetBytes: number | null;
  activeRuns: number | null;
  runLimit: number | null;
  reporters: number;
  complete: boolean;
}

export interface ResourceInstanceHistory {
  identity: ResourceIdentity;
  allocation: ResourceAllocation;
  firstSampleAt: number;
  lastSampleAt: number;
  latest: ResourceSample;
  droppedSamples: number;
  cpu: ResourceStatistics;
  memory: ResourceStatistics;
  workingSet: ResourceStatistics;
  points: ResourceHistoryPoint[];
}

export interface ResourcePoolHistory {
  scope: 'container' | 'process';
  role: 'execution' | 'control';
  latest: ResourceHistoryPoint | null;
  cpu: ResourceStatistics;
  memory: ResourceStatistics;
  points: ResourceHistoryPoint[];
}

export interface ResourceHistory {
  available: boolean;
  error: string | null;
  period: ResourcePeriod;
  from: number;
  to: number;
  generatedAt: number;
  sampleIntervalMs: number;
  staleAfterMs: number;
  percentile: 'approximate-duration-weighted';
  instances: ResourceInstanceHistory[];
  pools: ResourcePoolHistory[];
  /** Lower bound after merging a bounded database result with live reports. */
  omittedInstances: number;
}
