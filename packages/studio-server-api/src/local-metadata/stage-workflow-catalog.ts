import { collectSourceFolderPaths, iterateSourceWorkflows } from './filesystem-workflow-source.js';
import { iterateSourceRecordings } from './filesystem-recording-source.js';
import { LocalWorkflowCatalog } from './workflow-catalog.js';
import { localUpgradeSourceError } from './upgrade-diagnostics.js';

/**
 * Candidate-only copy of a frozen workflow tree. The caller must own a
 * persistent maintenance fence and drain active writers before invoking it.
 * Re-reading and exact verification detect host-side changes during the copy.
 */
export async function stageFrozenWorkflowCatalog(options: {
  sourceRoot: string;
  catalog: LocalWorkflowCatalog;
  verifyOnly?: boolean;
  assertFrozen: () => Promise<void>;
}): Promise<{ folders: number; projects: number; publishedVersions: number; publishedWebApps: number }> {
  await options.assertFrozen();
  const folders = await collectSourceFolderPaths(options.sourceRoot);
  options.catalog.initialize({ verifyOnly: options.verifyOnly });
  if (!options.verifyOnly) {
    for (const folder of folders) {
      await options.assertFrozen();
      options.catalog.importFolder(folder);
    }
    for await (const project of iterateSourceWorkflows(options.sourceRoot)) {
      await options.assertFrozen();
      try {
        await options.catalog.importProject(project);
      } catch (error) {
        throw localUpgradeSourceError(error, project.relativePath, 'catalog-import-failed');
      }
    }
  }
  await options.assertFrozen();
  return options.catalog.verifyProjectStream(
    await collectSourceFolderPaths(options.sourceRoot),
    iterateSourceWorkflows(options.sourceRoot),
  );
}

/** Requires the project catalog to have been staged from the same frozen tree. */
export async function stageFrozenRecordingCatalog(options: {
  sourceRoot: string;
  recordingsRoot: string;
  catalog: LocalWorkflowCatalog;
  verifyOnly?: boolean;
  assertFrozen: () => Promise<void>;
}): Promise<number> {
  await options.assertFrozen();
  const projects: Array<{ workflowId: string }> = [];
  for await (const project of iterateSourceWorkflows(options.sourceRoot))
    projects.push({ workflowId: project.workflowId });
  const recordings = () => iterateSourceRecordings(options.recordingsRoot, projects);
  options.catalog.initialize({ verifyOnly: options.verifyOnly });
  if (!options.verifyOnly) {
    for await (const recording of recordings()) {
      await options.assertFrozen();
      await options.catalog.importRecording(recording);
    }
  }
  await options.assertFrozen();
  return options.catalog.verifyRecordingStream(recordings());
}
