export type ProjectBundleJobStatus = {
  id: string;
  phase: 'collecting' | 'packaging' | 'ready' | 'failed' | 'cancelled' | 'interrupted';
  projects: number;
  bytes: number;
  archiveBytes?: number;
  archiveHash?: string;
  expiresAt: string;
  error?: string;
};
