import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { deserializeDatasets, loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';

import { SqliteWorkflowBackend } from './sqlite-workflow-backend.js';
import type { LocalWorkflowCatalogSnapshot, LocalRecordingCatalogSnapshot } from './workflow-catalog.js';
import { getFilesystemProjectRevisionId } from '../routes/workflows/project-stats.js';
import type { WorkflowFolderItem } from '../../../studio-server-shared/workflow-types.js';

export type LocalServingCheckReport = {
  projects: number;
  endpoints: number;
  webApps: number;
  publishedVersions: number;
  recordings: number;
};

/** Read-only behavior verification, not an activation certificate. Never executes
 * a production graph, package module, or external service. No mismatch includes
 * project payloads, inputs or secrets in its error text. */
export async function verifySqliteWorkflowServing(options: {
  databasePath: string;
  artifactRoot: string;
  virtualRoot: string;
  folders: string[];
  projects: LocalWorkflowCatalogSnapshot[] | (() => AsyncIterable<LocalWorkflowCatalogSnapshot>);
  recordings: LocalRecordingCatalogSnapshot[] | (() => AsyncIterable<LocalRecordingCatalogSnapshot>);
  assertFrozen: () => Promise<void>;
}): Promise<LocalServingCheckReport> {
  options = {
    ...options,
    folders: [...options.folders],
    projects: typeof options.projects === 'function' ? options.projects : structuredClone(options.projects),
    recordings: typeof options.recordings === 'function' ? options.recordings : structuredClone(options.recordings),
  };
  const sourceProjects = () => (typeof options.projects === 'function' ? options.projects() : options.projects);
  const sourceRecordings = () => (typeof options.recordings === 'function' ? options.recordings() : options.recordings);
  const recordingMetadata = new Map<
    string,
    Omit<LocalRecordingCatalogSnapshot, 'recordingContents' | 'replayProjectContents' | 'replayDatasetContents'>
  >();
  for await (const {
    recordingContents: _recording,
    replayProjectContents: _project,
    replayDatasetContents: _dataset,
    ...metadata
  } of sourceRecordings()) {
    if (recordingMetadata.has(metadata.recordingId)) throw new Error('Duplicate source recording.');
    recordingMetadata.set(metadata.recordingId, metadata);
  }
  const backend = new SqliteWorkflowBackend({
    ...options,
    withWrite: async () => {
      throw new Error('Candidate verification cannot write.');
    },
  });
  const equal = (actual: unknown, expected: unknown, field: string) => {
    if (!isDeepStrictEqual(actual, expected)) throw new Error(`SQLite serving verification failed: ${field}.`);
  };
  const sort = (values: string[]) => [...values].sort();
  // Legacy normalization supplies absent optional fields as undefined. JSON
  // rows omit those properties, which is the same identity, not lost data.
  // Preserve every defined value (including null) in this comparison.
  const identity = (value: object | undefined) =>
    value && Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
  const absolute = (value: string) => path.join(options.virtualRoot, ...value.split('/'));
  const report: LocalServingCheckReport = {
    projects: 0,
    endpoints: 0,
    webApps: 0,
    publishedVersions: 0,
    recordings: 0,
  };
  try {
    await options.assertFrozen();
    backend.initialize({ readOnly: true });
    const tree = await backend.getTree();
    const folders: WorkflowFolderItem[] = [];
    const projects = [...tree.projects];
    const visit = (items: WorkflowFolderItem[]) => {
      for (const folder of items) {
        folders.push(folder);
        projects.push(...folder.projects);
        visit(folder.folders);
      }
    };
    visit(tree.folders);
    equal(sort(folders.map((folder) => folder.relativePath)), sort(options.folders), 'folder set');
    const remainingProjects = new Set(projects.map((project) => project.relativePath));
    for await (const source of sourceProjects()) {
      if (!remainingProjects.delete(source.relativePath))
        throw new Error('SQLite serving verification failed: project set.');
      await options.assertFrozen();
      const loaded = await backend.loadHostedProject(absolute(source.relativePath));
      equal(loaded.contents, source.contents, 'draft bytes');
      equal(loaded.datasetsContents, source.datasetsContents, 'draft datasets');
      equal(
        loaded.revisionId,
        getFilesystemProjectRevisionId(source.contents, source.datasetsContents),
        'draft revision',
      );
      const item = projects.find((item) => item.relativePath === source.relativePath)!;
      equal(item.projectMetadataId, source.workflowId, 'project identity');
      equal(
        [item.name, item.fileName, item.updatedAt],
        [source.name, source.fileName, source.updatedAt],
        'project metadata',
      );
      equal(
        [
          item.settings.endpointName,
          item.settings.publishedEndpointName,
          item.settings.publicationStatus,
          item.settings.lastPublishedAt,
        ],
        [source.endpointName, source.publishedEndpointName, source.endpointStatus, source.lastPublishedAt],
        'publication pointers',
      );
      const appMetadata = (app: {
        uiGraphId: string;
        uiGraphName: string;
        slug: string;
        allowedEmails: string[];
        publishedAt: string;
      }) => [app.uiGraphId, app.uiGraphName, app.slug, app.allowedEmails, app.publishedAt];
      equal(
        [...(item.settings.publishedWebApps ?? [])]
          .sort((a, b) => a.uiGraphId.localeCompare(b.uiGraphId))
          .map(appMetadata),
        [...source.publishedWebApps].sort((a, b) => a.uiGraphId.localeCompare(b.uiGraphId)).map(appMetadata),
        'published web-app set',
      );
      equal(item.settings.endpointAccess, source.endpointAccess, 'endpoint access');
      equal(item.settings.publicationVersion, source.publicationVersion, 'publication concurrency');
      const checkExecution = async (
        execution: Awaited<ReturnType<typeof backend.loadPublishedExecutionProject>>,
        contents: string,
        datasets: string | null,
      ) => {
        if (!execution) throw new Error('SQLite serving verification failed: execution target missing.');
        const [project, attached] = loadProjectAndAttachedDataFromString(contents);
        equal(execution.project, project, 'execution project');
        equal(execution.attachedData, attached, 'execution attachments');
        equal(execution.projectVirtualPath, absolute(source.relativePath), 'execution path');
        equal(execution.endpointAccess, source.endpointAccess, 'execution access');
        equal(
          await execution.datasetProvider.exportDatasetsForProject(project.metadata.id),
          datasets ? deserializeDatasets(datasets) : [],
          'execution datasets',
        );
      };
      if (source.endpointName && source.publishedContents !== null) {
        await checkExecution(
          await backend.loadLatestExecutionProject(source.endpointName),
          source.contents,
          source.datasetsContents,
        );
        report.endpoints++;
      }
      if (source.publishedEndpointName && source.publishedContents !== null) {
        await checkExecution(
          await backend.loadPublishedExecutionProject(source.publishedEndpointName),
          source.publishedContents,
          source.publishedDatasetsContents,
        );
        report.endpoints++;
      }
      const versions = (await backend.listWorkflowPublishedVersions(source.relativePath)).versions;
      equal(
        sort(versions.map((version) => version.id)),
        sort(source.publishedVersions.map((version) => version.versionId)),
        'version set',
      );
      for (const sourceVersion of source.publishedVersions) {
        const version = versions.find((version) => version.id === sourceVersion.versionId)!;
        equal(
          [version.endpointName, version.publishedAt, version.isStarred, version.comment, version.isCurrent],
          [
            sourceVersion.endpointName,
            sourceVersion.publishedAt,
            sourceVersion.isStarred,
            sourceVersion.comment,
            sourceVersion.versionId === source.publishedVersionId,
          ],
          'version metadata',
        );
        const preview = await backend.readWorkflowPublishedVersionPreview(source.relativePath, sourceVersion.versionId);
        equal(
          preview,
          { contents: sourceVersion.contents, datasetsContents: sourceVersion.datasetsContents },
          'version preview',
        );
        equal(
          (await backend.readWorkflowPublishedVersionDownload(source.relativePath, sourceVersion.versionId)).contents,
          sourceVersion.contents,
          'version download',
        );
        report.publishedVersions++;
      }
      for (const app of source.publishedWebApps) {
        const published = await backend.loadPublishedWebAppExecutionProject(app.slug);
        const latest = await backend.loadLatestWebAppExecutionProject(app.slug);
        await checkExecution(published, app.contents, app.datasetsContents);
        await checkExecution(latest, source.contents, source.datasetsContents);
        for (const execution of [published, latest])
          equal(
            [execution!.webAppUiGraphId, execution!.webAppAllowedEmails, execution!.webAppBindingId],
            [app.uiGraphId, app.allowedEmails, `filesystem:${app.appId}`],
            'web-app execution binding',
          );
        equal(
          await backend.resolveWebAppAccessPolicy(app.slug),
          {
            projectVirtualPath: absolute(source.relativePath),
            relativePath: source.relativePath,
            appId: app.appId,
            uiGraphId: app.uiGraphId,
            allowedEmails: app.allowedEmails,
            bindingId: `filesystem:${app.appId}`,
          },
          'web-app policy',
        );
        report.webApps++;
      }
      const expectedRuns = [...recordingMetadata.values()].filter(
        (recording) => recording.workflowId === source.workflowId,
      );
      const actualIds: string[] = [];
      for (let page = 1; page <= Math.max(1, Math.ceil(expectedRuns.length / 100)); page++) {
        const result = await backend.listWorkflowRecordingRunsPage(source.workflowId, page, 100);
        equal(result.totalRuns, expectedRuns.length, 'recording count');
        actualIds.push(...result.runs.map((run) => run.id));
        for (const run of result.runs) {
          const expected = expectedRuns.find((source) => source.recordingId === run.id);
          if (!expected) throw new Error('SQLite serving verification failed: unexpected recording.');
          equal(
            [
              run.createdAt,
              run.status,
              run.runKind,
              run.durationMs,
              run.endpointNameAtExecution,
              run.errorMessage,
              identity(run.executionIdentity),
            ],
            [
              expected.createdAt,
              expected.status,
              expected.runKind,
              expected.durationMs,
              expected.endpointName,
              expected.errorMessage ?? undefined,
              identity(expected.executionIdentity),
            ],
            'recording metadata',
          );
        }
      }
      equal(sort(actualIds), sort(expectedRuns.map((recording) => recording.recordingId)), 'recording set');
      report.projects++;
    }
    if (remainingProjects.size) throw new Error('SQLite serving verification failed: project set.');
    for await (const source of sourceRecordings()) {
      await options.assertFrozen();
      equal(
        await backend.readWorkflowRecordingArtifact(source.recordingId, 'recording'),
        source.recordingContents,
        'recording payload',
      );
      equal(
        await backend.readWorkflowRecordingArtifact(source.recordingId, 'replay-project'),
        source.replayProjectContents,
        'replay project',
      );
      if (source.replayDatasetContents !== null)
        equal(
          await backend.readWorkflowRecordingArtifact(source.recordingId, 'replay-dataset'),
          source.replayDatasetContents,
          'replay datasets',
        );
      else {
        let missing = false;
        try {
          await backend.readWorkflowRecordingArtifact(source.recordingId, 'replay-dataset');
        } catch (error) {
          if ((error as { status?: number }).status === 404) missing = true;
          else throw error;
        }
        equal(missing, true, 'unexpected replay datasets');
      }
      report.recordings++;
    }
    await options.assertFrozen();
    return report;
  } finally {
    backend.close();
  }
}
