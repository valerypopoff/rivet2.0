import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  remapOwnedDatasets,
  serializeDatasets,
  serializeProject,
} from '@valerypopoff/rivet2-node';
import type {
  StructuralCommand,
  StructuralMutation,
} from '../../../../../studio-server-shared/workflow-mutation-contract.js';
import type { WorkflowProjectItem } from '../../../../../studio-server-shared/workflow-types.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { createBlankProjectFile, sanitizeWorkflowName } from '../fs-helpers.js';
import { getWorkflowDuplicateProjectName } from '../workflow-project-naming.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import {
  assertFolderIdentity,
  folderIdentity,
  previousStructuralResult,
  withCatalogTransaction,
} from './structural-admission.js';
import type { WorkflowRow } from './types.js';
import {
  assertMutationAdmission,
  captureOperation,
  recoverCapturedReceipt,
  withMutationReceipt,
} from './namespace-receipts.js';
import { createPreparedRevisions } from './prepared-revisions.js';

type ProjectCreationCommand = Extract<
  StructuralCommand,
  { operation: 'create-project' | 'copy-project' | 'upload-project' }
>;

/** Capture/prepare without a SQL lease; commit identity checks, pointers and
 * receipt together. Never call the save service from inside another transaction. */
export async function createManagedProject(
  context: ManagedWorkflowContext,
  command: ProjectCreationCommand,
  mutation?: StructuralMutation,
): Promise<WorkflowProjectItem> {
  const captured = captureOperation(
    { command, mutation },
    (input) => input.mutation,
    (input) => input.command,
  );
  ({ command, mutation } = captured.input);
  const admission = captured.admission;
  const previous = await previousStructuralResult<{ project: WorkflowProjectItem }>(context, admission);
  if (previous.state === 'committed') return previous.result.project;
  let source: WorkflowRow | undefined;
  let parent: string;
  let name: string;
  let generatedName: ((index: number) => string) | undefined;
  let contents: string;
  let datasets: string | null = null;
  if (command.operation === 'copy-project') {
    const sourcePath = normalizeManagedWorkflowRelativePath(command.input.relativePath, { allowProjectFile: true });
    source = (await context.queries.getWorkflowByRelativePath(context.pool, sourcePath)) ?? undefined;
    if (!source) throw createHttpError(404, 'Project not found.');
    const expected = mutation?.expectedSource;
    if (
      mutation &&
      (!expected ||
        expected.id !== source.workflow_id ||
        expected.revisionId !== source.current_draft_revision_id ||
        (command.input.version === 'published' && expected.publicationVersion !== (source.publication_version ?? '0')))
    )
      throw conflict('The selected project or version changed. Refresh before copying.');
    const revisionId =
      command.input.version === 'published' ? source.published_revision_id : source.current_draft_revision_id;
    const revision = revisionId ? await context.queries.getRevision(context.pool, revisionId) : null;
    if (!revision || revision.workflow_id !== source.workflow_id)
      throw conflict('The selected saved version is unavailable.');
    const artifact = await context.revisions.readRevisionContents(revision);
    contents = artifact.contents;
    datasets = artifact.datasetsContents;
    parent = source.folder_relative_path;
    const selected = source;
    generatedName = (index) =>
      getWorkflowDuplicateProjectName(
        selected.name,
        command.input.version,
        context.mappers.getWorkflowStatus(selected),
        index,
      );
  } else {
    parent = normalizeManagedWorkflowRelativePath(command.input.parentRelativePath, {
      allowProjectFile: false,
      allowEmpty: true,
    });
    if (command.operation === 'create-project') {
      name = sanitizeWorkflowName(command.input.name, 'project name');
      contents = createBlankProjectFile(name);
    } else {
      const base = sanitizeWorkflowName(
        command.input.fileName
          .replace(/\\/g, '/')
          .split('/')
          .at(-1)!
          .replace(/\.rivet-project$/i, ''),
        'project file name',
      );
      generatedName = (index) => (index ? `${base} ${index}` : base);
      contents = command.input.contents;
    }
  }
  const destinationId =
    mutation && command.operation !== 'copy-project'
      ? mutation.expectedDestinationId
      : await folderIdentity(context.pool, parent);
  // Validate before uploading; revalidate under the lease after uploading.
  if (destinationId === undefined || destinationId !== (await folderIdentity(context.pool, parent)))
    throw conflict('The destination folder changed. Refresh the library.');
  let loaded;
  try {
    loaded = loadProjectAndAttachedDataFromString(contents);
  } catch {
    throw createHttpError(400, 'Could not create project: invalid project file.');
  }
  const [project, attached] = loaded;
  if (source && project.metadata.id !== source.workflow_id)
    throw conflict('Saved project identity does not match its revision.');
  const id = randomUUID();
  if (datasets !== null) {
    try {
      datasets = serializeDatasets(
        remapOwnedDatasets(deserializeDatasets(datasets), project.metadata.id, id as typeof project.metadata.id),
      );
    } catch {
      throw createHttpError(400, 'Dataset ownership does not match the source project.');
    }
  }
  project.metadata.id = id as typeof project.metadata.id;
  let nameIndex = 0;
  // Only an acknowledged, pre-write name collision can reprepare. Exceptions,
  // including lost COMMIT/ROLLBACK acknowledgements, always escape this loop.
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await previousStructuralResult<{ project: WorkflowProjectItem }>(context, admission);
    if (previous.state === 'committed') return previous.result.project;
    if (generatedName) {
      do {
        if (mutation) assertMutationAdmission(mutation);
        if (nameIndex >= 10_000) throw conflict('Too many copies use this name. Rename the source before copying.');
        name = generatedName(nameIndex++);
      } while (
        await context.queries.getWorkflowByRelativePath(
          context.pool,
          parent ? `${parent}/${name}.rivet-project` : `${name}.rivet-project`,
        )
      );
    }
    project.metadata.title = name!;
    const serialized = serializeProject(project, attached);
    if (typeof serialized !== 'string') throw createHttpError(400, 'Could not create project.');
    const target = parent ? `${parent}/${name!}.rivet-project` : `${name!}.rivet-project`;
    const preparations = createPreparedRevisions(context.revisions, admission);
    try {
      const revision = await preparations.prepare(id, serialized, datasets);
      const decision = await withCatalogTransaction(context, async (tx) => {
        const { client, hooks } = tx;
        preparations.observe(hooks);
        if (mutation) {
          const previous = await recoverCapturedReceipt<{ project: WorkflowProjectItem }>(client, admission!);
          if (previous.state === 'committed') return { kind: 'committed' as const, result: previous.result };
          assertMutationAdmission(mutation);
        }
        await assertFolderIdentity(client, parent, destinationId);
        if (source) {
          const current = await context.queries.getWorkflowByRelativePath(client, source.relative_path, {
            forUpdate: true,
          });
          if (JSON.stringify(current) !== JSON.stringify(source))
            throw conflict('The source changed while preparing the copy. Refresh before copying.');
        }
        if (await context.queries.getWorkflowByRelativePath(client, target)) {
          if (generatedName) return { kind: 'needs-reprepare' as const };
          throw conflict('The destination already exists. Refresh before trying again.');
        }
        const result = await withMutationReceipt(tx, admission, async () => {
          await client.query(
            `INSERT INTO workflows(workflow_id,name,file_name,relative_path,folder_relative_path,current_draft_revision_id)
        VALUES($1,$2,$3,$4,$5,$6)`,
            [id, name, path.posix.basename(target), target, parent, revision.revision_id],
          );
          await context.revisions.insertRevision(client, revision);
          preparations.stage(revision, hooks);
          const row = await context.queries.getWorkflowByRelativePath(client, target);
          if (!row) throw new Error('Created project could not be loaded.');
          await context.executionInvalidationController.queueCatalogInvalidation(client);
          return { project: context.mappers.mapWorkflowRowToProjectItem(row) };
        });
        return { kind: 'committed' as const, result };
      });
      if (decision.kind === 'committed') {
        return decision.result.project;
      }
    } finally {
      await preparations.close();
    }
  }
  throw conflict('The generated destination kept changing. Refresh the library before copying again.');
}
