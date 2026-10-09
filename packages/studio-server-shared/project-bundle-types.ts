export type ProjectBundleJobStatus = {
  id: string;
  /** Durable export-wide selection; absent for older per-call-version jobs. */
  versionPolicy?: 'latest' | 'published';
  phase: 'collecting' | 'packaging' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
  projects: number;
  bytes: number;
  archiveBytes?: number;
  archiveHash?: string;
  expiresAt: string;
  error?: string;
};
