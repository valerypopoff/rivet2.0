import { createHash, randomUUID } from 'node:crypto';
import { loadProjectFromString, type GraphId, type Project } from '@valerypopoff/rivet2-node';
import { badRequest, conflict } from '../../../utils/httpError.js';
import { assertEndpointDatasetReadable, listEndpointGraphCalls } from '../endpoint-release-graphs.js';
import type { ManagedWorkflowContext } from './context.js';
import type { ManagedWorkflowDbClient } from './db.js';
import {
  ENDPOINT_RELEASE_IO_TIMEOUT_MS,
  endpointReleaseTargetKey,
  MAX_ARTIFACTS,
  MAX_BINDINGS,
  MAX_ENDPOINT_RELEASE_BYTES,
  type EndpointReleaseManifest,
  type EndpointReleaseReference,
  type EndpointReleaseSelector,
} from './endpoint-release-manifest.js';
import { readEndpointArtifact, type EndpointReleasePin } from './endpoint-release-reader.js';
import {
  readDependencyPointers,
  selectDependencyRevision,
  type EndpointDependencyPointer,
} from './endpoint-release-selection.js';
import { isSubgraphReferenceInScope } from './subgraph-access.js';
import { lockBundleTopology } from './topology-lock.js';

const MAX_GRAPHS = 12_000;
type ReleaseContext = Pick<ManagedWorkflowContext, 'pool' | 'queries' | 'blobStore'>;
type Selection = { projectId: string; selector: EndpointReleaseSelector; revisionId: string; fromDraft: boolean };
type Scope = { callerId: string; targetId: string };
export type PreparedEndpointRelease = {
  releaseId: string;
  manifest: EndpointReleaseManifest;
  pins: Map<string, EndpointReleasePin>;
  selections: Selection[];
  scopes: Scope[];
};

function assertScope(caller: EndpointDependencyPointer, target: EndpointDependencyPointer) {
  if (!isSubgraphReferenceInScope(caller.bundle_id, target.bundle_id)) {
    throw badRequest(`${caller.name} cannot reference ${target.name} across a bundle boundary.`);
  }
}

export async function prepareEndpointRelease(
  context: ReleaseContext,
  rootWorkflowId: string,
  rootRevisionId: string,
  rootSelector: 'latest' | 'published',
): Promise<PreparedEndpointRelease> {
  const signal = AbortSignal.timeout(ENDPOINT_RELEASE_IO_TIMEOUT_MS);
  const pointers = new Map<string, EndpointDependencyPointer>();
  const pins = new Map<string, EndpointReleasePin>();
  const projects = new Map<string, Project>();
  const display = new Map<string, EndpointReleaseManifest['projects'][number]>();
  const selections = new Map<string, Selection>();
  const scopes = new Map<string, Scope>();
  const references: EndpointReleaseReference[] = [];
  let bytes = 0;
  let graphCount = 0;

  const pointerFor = async (projectId: string) => {
    signal.throwIfAborted();
    let pointer = pointers.get(projectId);
    if (!pointer) {
      pointer = (await readDependencyPointers(context.pool, [projectId])).get(projectId);
      if (!pointer) throw conflict(`Referenced project ${projectId} is missing.`);
      pointers.set(projectId, pointer);
    }
    return pointer;
  };
  const select = async (
    projectId: string,
    selector: EndpointReleaseSelector,
    expectedRevisionId?: string,
  ): Promise<string> => {
    const pointer = await pointerFor(projectId);
    const revisionId = selectDependencyRevision(pointer, selector);
    if (!revisionId)
      throw conflict(`${pointer.name} has no ${selector === 'published' ? 'published' : 'saved'} revision.`);
    if (expectedRevisionId && revisionId !== expectedRevisionId)
      throw conflict('The project changed while preparing the publication. Review it again.');
    selections.set(endpointReleaseTargetKey(projectId, selector), {
      projectId,
      selector,
      revisionId,
      fromDraft: selector === 'latest' || (selector === 'project-reference' && !pointer.published_revision_id),
    });
    if (projects.has(revisionId)) return revisionId;
    if (projects.size >= MAX_ARTIFACTS) throw badRequest('The endpoint references too many project revisions.');
    const revision = await context.queries.getRevision(context.pool, revisionId);
    if (!revision || revision.workflow_id !== projectId)
      throw conflict(`The revision for ${pointer.name} is unavailable.`);
    const { contents, datasetsContents } = await readEndpointArtifact(context, revision, signal);
    bytes += Buffer.byteLength(contents) + Buffer.byteLength(datasetsContents ?? '');
    if (bytes > MAX_ENDPOINT_RELEASE_BYTES)
      throw badRequest('The endpoint revision exceeds the total artifact size limit.');
    const project = loadProjectFromString(contents);
    // The bytes of an unreadable legacy dataset prove that it cannot serve as a rollback point.
    assertEndpointDatasetReadable(datasetsContents, rootSelector === 'published' ? 409 : 503);
    if (project.metadata.id !== projectId)
      throw conflict(`The revision for ${pointer.name} has a different project identity.`);
    projects.set(revisionId, project);
    pins.set(revisionId, revision);
    display.set(revisionId, {
      artifactId: revisionId,
      projectId,
      name: pointer.name,
      relativePath: pointer.relative_path,
      ...(pointer.bundle_relative_path ? { bundleRelativePath: pointer.bundle_relative_path } : {}),
      savedAt: new Date(revision.created_at).toISOString(),
    });
    return revisionId;
  };
  const rootArtifactId = await select(rootWorkflowId, rootSelector, rootRevisionId);
  const entryGraphId = projects.get(rootArtifactId)?.metadata.mainGraphId;
  if (!entryGraphId) throw badRequest('Select a main graph before publishing the endpoint.');
  const legacyLoaders = new Map<string, Map<string, string>>();
  const addReference = (reference: EndpointReleaseReference) => {
    if (references.length >= MAX_BINDINGS) throw badRequest('The endpoint has too many graph references.');
    references.push(reference);
  };

  // Legacy reference loading is eager, with project IDs visited once per owner.
  const loadDeclaredReferences = async (ownerId: string) => {
    const cached = legacyLoaders.get(ownerId);
    if (cached) return cached;
    const owner = projects.get(ownerId)!;
    const loaded = new Map<string, string>([[owner.metadata.id, ownerId]]);
    const pending = [ownerId];
    while (pending.length) {
      const sourceArtifactId = pending.pop()!;
      for (const reference of projects.get(sourceArtifactId)?.references ?? []) {
        let id = loaded.get(reference.id);
        if (!id) {
          id = await select(reference.id, 'project-reference');
          loaded.set(reference.id, id);
          pending.push(id);
        }
        if (id !== ownerId)
          addReference({
            sourceArtifactId,
            sourceGraphId: '',
            nodeId: '',
            targetArtifactId: id,
            targetGraphId: '',
            selector: 'project-reference',
          });
      }
    }
    legacyLoaders.set(ownerId, loaded);
    return loaded;
  };

  const visited = new Set<string>();
  const active = new Set<string>();
  const dynamicLocalProjects = new Set<string>();
  const visit = async (artifactId: string, graphId: GraphId, depth: number, crossProject: boolean) => {
    signal.throwIfAborted();
    if (depth > 64) throw badRequest('The endpoint graph dependency depth exceeds 64.');
    const key = JSON.stringify([artifactId, graphId]);
    if (active.has(key) && crossProject) throw badRequest(`A project dependency cycle reaches graph ${graphId}.`);
    if (visited.has(key)) return;
    if (++graphCount > MAX_GRAPHS) throw badRequest('The endpoint references too many graphs.');
    visited.add(key);
    active.add(key);
    const owner = projects.get(artifactId)!;
    const legacy = await loadDeclaredReferences(artifactId);
    const { calls, callsAnyLocalGraph } = listEndpointGraphCalls(owner, graphId);
    if (callsAnyLocalGraph) dynamicLocalProjects.add(artifactId);
    for (const call of calls) {
      if (!call.targetProjectId) {
        await visit(artifactId, call.targetGraphId, depth + 1, false);
        continue;
      }

      const selector = call.selector!;
      let child: string;
      try {
        if (selector === 'project-reference') {
          const declared = legacy.get(call.targetProjectId);
          if (!declared || declared === artifactId)
            throw badRequest('This target is absent from the project reference list.');
          child = declared;
        } else {
          const callerPointer = await pointerFor(owner.metadata.id);
          const targetPointer = await pointerFor(call.targetProjectId);
          assertScope(callerPointer, targetPointer);
          scopes.set(JSON.stringify([callerPointer.workflow_id, targetPointer.workflow_id]), {
            callerId: callerPointer.workflow_id,
            targetId: targetPointer.workflow_id,
          });
          child = await select(call.targetProjectId, selector);
        }
        if (!Object.hasOwn(projects.get(child)!.graphs, call.targetGraphId))
          throw badRequest(`Graph ${call.targetGraphId} is absent from ${display.get(child)!.name}.`);
      } catch (error) {
        if (!(error instanceof Error) || !('status' in error) || Number(error.status) >= 500) throw error;
        const graphName = owner.graphs[graphId]?.metadata?.name ?? graphId;
        throw conflict(`${display.get(artifactId)!.name} / ${graphName} / ${call.node.title}: ${error.message}`);
      }
      addReference({
        sourceArtifactId: artifactId,
        sourceGraphId: graphId,
        nodeId: call.node.id,
        targetArtifactId: child,
        targetGraphId: call.targetGraphId,
        selector,
      });
      await visit(child, call.targetGraphId, depth + 1, true);
    }
    active.delete(key);
  };
  await visit(rootArtifactId, entryGraphId, 0, false);
  // Potential targets are independent graph entries, not one recursive chain.
  for (const artifactId of dynamicLocalProjects) {
    for (const graphId of Object.keys(projects.get(artifactId)!.graphs) as GraphId[]) {
      await visit(artifactId, graphId, 0, false);
    }
  }
  const manifest: EndpointReleaseManifest = {
    version: 1,
    rootArtifactId,
    entryGraphId,
    projects: [...display.values()],
    references,
  };
  const json = JSON.stringify(manifest);
  if (Buffer.byteLength(json) > 4 * 1024 * 1024 || /\\u0000/i.test(json))
    throw badRequest('The endpoint revision metadata is too large or contains unsupported text.');
  return {
    releaseId: randomUUID(),
    manifest,
    pins,
    selections: [...selections.values()],
    scopes: [...scopes.values()],
  };
}

export async function validatePreparedEndpointReleases(
  client: Parameters<typeof lockBundleTopology>[0],
  releases: PreparedEndpointRelease[],
) {
  if (!releases.length) return;
  await lockBundleTopology(client);
  const projectIds = [
    ...new Set(
      releases.flatMap((release) => [
        ...release.selections.map((selection) => selection.projectId),
        ...release.manifest.projects.map((project) => project.projectId),
      ]),
    ),
  ];
  const current = await readDependencyPointers(client, projectIds, true);
  for (const release of releases) {
    for (const snapshot of release.manifest.projects) {
      const pointer = current.get(snapshot.projectId);
      if (!pointer || pointer.relative_path !== snapshot.relativePath || pointer.name !== snapshot.name)
        throw conflict('A project moved or was renamed while preparing publication. Review it again.');
      if ((pointer.bundle_relative_path ?? undefined) !== snapshot.bundleRelativePath)
        throw conflict('Bundle membership changed while preparing publication. Review it again.');
    }
    for (const { projectId, selector, revisionId } of release.selections) {
      if (selectDependencyRevision(current.get(projectId), selector) !== revisionId)
        throw conflict('A referenced revision changed while preparing publication. Review it again.');
    }
    for (const { callerId, targetId } of release.scopes) {
      assertScope(current.get(callerId)!, current.get(targetId)!);
    }
  }
}

export function hashPreparedEndpointReleases(releases: PreparedEndpointRelease[], missingRollback: boolean) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        manifests: releases.map((release) => release.manifest),
        missingRollback,
      }),
    )
    .digest('hex');
}

export async function storeEndpointRelease(
  client: ManagedWorkflowDbClient,
  owner: string,
  release: PreparedEndpointRelease,
) {
  await client.query('INSERT INTO workflow_endpoint_releases (release_id, workflow_id, manifest) VALUES ($1,$2,$3)', [
    release.releaseId,
    owner,
    JSON.stringify(release.manifest),
  ]);
  await client.query(
    `
    INSERT INTO workflow_endpoint_release_projects (release_id, revision_id, project_blob_key, dataset_blob_key)
    SELECT $1, revision_id, project_blob_key, dataset_blob_key
    FROM jsonb_to_recordset($2::jsonb) AS pin(revision_id text, project_blob_key text, dataset_blob_key text)
  `,
    [release.releaseId, JSON.stringify([...release.pins.values()])],
  );
}
