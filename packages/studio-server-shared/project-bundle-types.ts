import type { WorkflowFolderItem, WorkflowProjectItem } from './workflow-types.js';

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

/** Uploads are bounded separately from background exports. */
export const PROJECT_BUNDLE_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const PROJECT_BUNDLE_UPLOAD_MAX_FILES = 514;
export type ProjectBundleUploadFile = { path: string; contents: string };
export type ProjectBundleImportResult = {
  folder: WorkflowFolderItem;
  projects: WorkflowProjectItem[];
  rootProjectId: string;
  /** Portable dependency snapshots imported outside the explicit bundle boundary. */
  dependenciesFolder?: WorkflowFolderItem;
};
