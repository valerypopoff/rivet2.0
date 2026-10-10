import { createHash } from 'node:crypto';
import { deserializeProject } from '@valerypopoff/rivet2-core/serialization';
import type { WorkflowProjectStats } from './types.js';

/** Pure payload indexing: no settings repositories, filesystem roots or runtime initialization. */
export type WorkflowProjectIndexData = {
  stats: WorkflowProjectStats;
  projectMetadataId?: string;
  /** Opaque content version used for hosted filesystem save conflict checks. */
  revisionId: string;
};

function appendRevisionPart(hash: ReturnType<typeof createHash>, contents: string | null): void {
  if (contents == null) {
    hash.update('null\0');
    return;
  }
  const bytes = Buffer.from(contents, 'utf8');
  hash.update('text\0');
  hash.update(String(bytes.byteLength));
  hash.update('\0');
  hash.update(bytes);
}

/** Hash both persisted payloads without changing the public revision contract. */
export function getFilesystemProjectRevisionId(contents: string, datasetsContents: string | null): string {
  const hash = createHash('sha256');
  hash.update('rivet-filesystem-project-revision-v1\0');
  appendRevisionPart(hash, contents);
  appendRevisionPart(hash, datasetsContents);
  return `fs-sha256:${hash.digest('hex')}`;
}

export function getWorkflowProjectIndexDataFromContents(
  contents: string,
  datasetsContents: string | null = null,
): WorkflowProjectIndexData {
  const revisionId = getFilesystemProjectRevisionId(contents, datasetsContents);
  try {
    const [project] = deserializeProject(contents);
    const graphs = Object.values(project.graphs ?? {});
    return {
      stats: {
        graphCount: graphs.length,
        webAppCount: Object.keys(project.uiGraphs ?? {}).length,
        totalNodeCount: graphs.reduce((count, graph) => {
          const nodes = graph.nodes as unknown;
          if (Array.isArray(nodes)) return count + nodes.length;
          if (nodes != null && typeof nodes === 'object') return count + Object.keys(nodes).length;
          return count;
        }, 0),
      },
      revisionId,
      ...(project.metadata.id ? { projectMetadataId: project.metadata.id } : {}),
    };
  } catch {
    return { stats: { graphCount: 0, totalNodeCount: 0, webAppCount: 0 }, revisionId };
  }
}
