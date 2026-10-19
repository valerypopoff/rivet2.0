export type WorkflowBundleVersion = 'latest' | 'published';
export type WorkflowBundlePreview = {
  bundleId: string;
  name: string;
  relativePath: string;
  fingerprint: string;
  version: WorkflowBundleVersion;
  members: Array<{
    projectId: string;
    relativePath: string;
    revisionId: string;
    selectedVersion: WorkflowBundleVersion;
  }>;
  externalProjectIds: string[];
  warnings: string[];
};
