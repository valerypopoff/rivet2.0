export type RunSchedule =
  | { kind: 'once'; localTime: string }
  | { kind: 'interval'; minutes: number; anchor: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] }
  | { kind: 'monthly'; time: string; day: number | 'last' };

export type ScheduledRunDraft = {
  name: string;
  description: string;
  projectId: string;
  version: 'latest' | 'published';
  enabled: boolean;
  timeZone: string;
  schedule: RunSchedule;
  input?: Record<string, unknown>;
  record: boolean;
  timeoutMinutes: number;
  missed: 'skip' | 'latest';
};
export type ScheduledRun = ScheduledRunDraft & {
  id: string;
  revision: number;
  nextAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type ScheduledOccurrence = {
  id: string;
  scheduleId: string;
  scheduleRevision: number;
  name: string;
  projectId: string;
  scheduledAt: number;
  /** Durable queue admission time; absent in occurrences written by older servers. */
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  status: 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'skipped' | 'cancelled';
  reason?: string;
  revisionKey?: string;
  graphId?: string;
  recordingId?: string;
  recordingStatus?: 'off' | 'saved' | 'unavailable';
  cancelRequested?: boolean;
};
export type ScheduledRunList = { schedules: ScheduledRun[]; history: ScheduledOccurrence[] };
export type ScheduledRunSummary = { enabledCount: number };
