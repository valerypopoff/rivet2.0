import { loadProjectFromString } from '@valerypopoff/rivet2-node';
import { createHttpError } from '../../../utils/httpError.js';
import { assertEndpointDatasetReadable } from '../endpoint-release-graphs.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowDbClient } from './db.js';
import {
  ENDPOINT_RELEASE_IO_TIMEOUT_MS,
  indexEndpointReleaseTargets,
  MAX_ENDPOINT_RELEASE_BYTES,
  parseEndpointReleaseManifest,
  type EndpointReleaseManifest,
  type EndpointReleaseTarget,
} from './endpoint-release-manifest.js';
import type { RevisionRow } from './types.js';

/** Keep retention keys separate from display metadata and workflow revision lifetime. */
export type EndpointReleasePin = Pick<RevisionRow, 'revision_id' | 'project_blob_key' | 'dataset_blob_key'>;
export type StoredEndpointRelease = {
  manifest: EndpointReleaseManifest;
  projects: Map<string, EndpointReleaseManifest['projects'][number]>;
  pins: Map<string, EndpointReleasePin>;
  capturedAt: string;
  targets: Map<string, EndpointReleaseTarget>;
};

export async function readEndpointArtifact(
  context: Pick<ManagedWorkflowContext, 'blobStore'>,
  pin: EndpointReleasePin,
  signal?: AbortSignal,
) {
  const [contents, datasetsContents] = await Promise.all([
    context.blobStore.getText(pin.project_blob_key, { signal }),
    pin.dataset_blob_key ? context.blobStore.getText(pin.dataset_blob_key, { signal }) : null,
  ]);
  return { contents, datasetsContents };
}

export async function readEndpointRelease(
  client: ManagedWorkflowDbClient,
  releaseId: string,
  owner: string,
  rootRevisionId: string,
): Promise<StoredEndpointRelease> {
  const result = await client.query<{ manifest: unknown; pins: EndpointReleasePin[]; captured_at: Date | string }>(
    `
    SELECT r.manifest, r.captured_at, (
      SELECT jsonb_agg(p) FROM workflow_endpoint_release_projects p WHERE p.release_id = r.release_id
    ) AS pins
    FROM workflow_endpoint_releases r
    JOIN workflow_revisions root ON root.revision_id = $3 AND root.workflow_id = r.workflow_id
    JOIN workflow_endpoint_release_projects root_pin
      ON root_pin.release_id = r.release_id AND root_pin.revision_id = root.revision_id
      AND root_pin.project_blob_key = root.project_blob_key
      AND root_pin.dataset_blob_key IS NOT DISTINCT FROM root.dataset_blob_key
    WHERE r.release_id = $1 AND r.workflow_id = $2
  `,
    [releaseId, owner, rootRevisionId],
  );
  const row = result.rows[0];
  const parsed = parseEndpointReleaseManifest(row?.manifest, owner, rootRevisionId);
  if (parsed && row && Array.isArray(row.pins)) {
    const { manifest, projects } = parsed;
    const pins = new Map(row.pins.map((pin) => [pin.revision_id, pin]));
    if (pins.size === projects.size && [...projects.keys()].every((id) => pins.has(id))) {
      const indexed = indexEndpointReleaseTargets(parsed);
      if (indexed.error) throw createHttpError(503, indexed.error);
      return { manifest, projects, pins, targets: indexed.targets, capturedAt: new Date(row.captured_at).toISOString() };
    }
  }
  throw createHttpError(503, 'The captured endpoint revision is unavailable.');
}

function loadCapturedProject(contents: string, projectId: string) {
  const project = loadProjectFromString(contents);
  if (project.metadata.id !== projectId)
    throw createHttpError(503, 'The captured project has a different saved identity.');
  return project;
}

export async function readEndpointReleasePreviewArtifact(
  context: Pick<ManagedWorkflowContext, 'blobStore'>,
  release: StoredEndpointRelease,
  artifactId: string,
) {
  const artifact = release.projects.get(artifactId);
  if (!artifact) throw createHttpError(404, 'This project was not captured in the endpoint revision.');
  const payload = await readEndpointArtifact(
    context,
    release.pins.get(artifactId)!,
    AbortSignal.timeout(ENDPOINT_RELEASE_IO_TIMEOUT_MS),
  );
  loadCapturedProject(payload.contents, artifact.projectId);
  return payload;
}

export async function loadEndpointReleaseArtifacts(
  context: Pick<ManagedWorkflowContext, 'blobStore'>,
  release: StoredEndpointRelease,
) {
  const signal = AbortSignal.timeout(ENDPOINT_RELEASE_IO_TIMEOUT_MS);
  const contents = new Map<string, Awaited<ReturnType<typeof readEndpointArtifact>>>();
  const graphs = new Map<string, Set<string>>();
  let bytes = 0;
  for (const artifact of release.manifest.projects) {
    signal.throwIfAborted();
    const artifactContents = await readEndpointArtifact(context, release.pins.get(artifact.artifactId)!, signal);
    bytes += Buffer.byteLength(artifactContents.contents) + Buffer.byteLength(artifactContents.datasetsContents ?? '');
    if (bytes > MAX_ENDPOINT_RELEASE_BYTES)
      throw createHttpError(503, 'The endpoint revision exceeds the artifact size limit.');
    const project = loadCapturedProject(artifactContents.contents, artifact.projectId);
    assertEndpointDatasetReadable(artifactContents.datasetsContents);
    if (
      artifact.artifactId === release.manifest.rootArtifactId &&
      project.metadata.mainGraphId !== release.manifest.entryGraphId
    )
      throw createHttpError(503, 'The captured endpoint entry graph does not match.');
    graphs.set(artifact.artifactId, new Set(Object.keys(project.graphs)));
    contents.set(artifact.artifactId, artifactContents);
  }
  if (
    !graphs.get(release.manifest.rootArtifactId)?.has(release.manifest.entryGraphId) ||
    release.manifest.references.some(
      (edge) =>
        (edge.sourceGraphId && !graphs.get(edge.sourceArtifactId)?.has(edge.sourceGraphId)) ||
        (edge.targetGraphId && !graphs.get(edge.targetArtifactId)?.has(edge.targetGraphId)),
    )
  )
    throw createHttpError(503, 'A graph in the captured revision is unavailable.');
  return { contents, bytes };
}
