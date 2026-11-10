export type WorkflowBundleVersion = 'latest' | 'published';

export type BundleMergeAction =
  | { sourceProjectId: string; kind: 'replace'; targetProjectId: string }
  | { sourceProjectId: string; kind: 'add'; relativePath: string };
export type BundleMergeDependency =
  | { sourceProjectId: string; kind: 'existing'; targetProjectId: string }
  | { sourceProjectId: string; kind: 'add'; relativePath: string };
export type BundleMergeGraphMapping = { sourceProjectId: string; sourceGraphId: string; targetGraphId: string };
export type BundleMergeChoices = {
  destinationBundleId: string;
  actions: BundleMergeAction[];
  dependencies: BundleMergeDependency[];
  graphs: BundleMergeGraphMapping[];
};
export type BundleMergeProject = { projectId: string; title: string; relativePath: string };
export type BundleMergeCatalog = {
  bundleId: string;
  namespaceId: string;
  name: string;
  relativePath: string;
  projects: BundleMergeProject[];
};
export type BundleMergeSite = {
  projectId: string;
  projectTitle: string;
  graphId?: string;
  graphName?: string;
  nodeId?: string;
  nodeTitle?: string;
  prefabId?: string;
  variantIndex?: number;
  active: boolean;
};
export type BundleMergeDiagnostic = { id: string; message: string; site?: BundleMergeSite };
export type BundleMergeGraphChoice = {
  sourceProjectId: string;
  sourceGraphId: string;
  sourceGraphName: string;
  targetProjectId: string;
  options: Array<{ id: string; name: string }>;
  sites: BundleMergeSite[];
  selectedGraphId?: string;
};
export type BundleMergePreview = {
  source: BundleMergeCatalog;
  destination: BundleMergeCatalog;
  actions: BundleMergeAction[];
  requiredProjects: Array<{ project: BundleMergeProject; sites: BundleMergeSite[] }>;
  requiredGraphs: BundleMergeGraphChoice[];
  /** Current named choices remain editable after their correspondence resolves. */
  mappedGraphs?: BundleMergeGraphChoice[];
  blockers: BundleMergeDiagnostic[];
  warnings: BundleMergeDiagnostic[];
  rewrites: number;
  versionChanges: number;
  datasets: Array<{ sourceProjectId: string; count: number }>;
  fingerprint?: string;
};
export type BundleMergeCommit = {
  choices: BundleMergeChoices;
  fingerprint: string;
  acknowledgedWarnings: string[];
};
export type BundleMergeResult = {
  operationId: string;
  folder: import('./workflow-types.js').WorkflowFolderItem;
  projectMapping: Record<string, string>;
  projects: Array<{ projectId: string; path: string; revisionId: string; added: boolean }>;
  warnings: BundleMergeDiagnostic[];
};
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
