import {
  NodeDatasetProvider,
  deserializeDatasets,
  loadProjectFromString,
  type SubgraphProjectTarget,
} from '@valerypopoff/rivet2-node';

/** Only inspect a small, complete error envelope; never display upstream text. */
async function readErrorCode(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const deadline = setTimeout(() => void reader.cancel().catch(() => undefined), 3_000);
  deadline.unref();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 8192) return;
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    // Non-JSON error pages are not application policy decisions.
    return;
  } finally {
    clearTimeout(deadline);
    await reader.cancel().catch(() => undefined);
  }
}

/** Service authentication is deliberately separate from the browser's operator session. */
export function createHostedSubgraphProjectLoader(options: {
  baseUrl: string | URL;
  headers: () => HeadersInit;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  async function read(target: SubgraphProjectTarget, action: 'execution' | 'access') {
    const url = new URL(
      `/api/workflows/subgraph-projects/${encodeURIComponent(target.projectId)}/${action}`,
      options.baseUrl,
    );
    url.searchParams.set('version', target.version);
    if (target.callerProjectId) url.searchParams.set('callerProjectId', target.callerProjectId);
    let response: Response;
    try {
      response = await request(url, {
        headers: options.headers(),
        cache: 'no-store',
        redirect: 'error',
        // Loading large artifacts retains the existing fetch lifetime. Permission
        // checks are small and must not leave a cached execution waiting forever.
        ...(action === 'access' ? { signal: AbortSignal.timeout(10_000) } : {}),
      });
    } catch {
      throw new Error('Subgraph project service could not be reached. Check the executor API connection.');
    }
    if (!response.ok) {
      // Only the API's domain code identifies a bundle denial. A generic 403
      // can instead be a proxy/service-auth failure; never echo an upstream body.
      const code = response.status === 403 || response.status === 409 ? await readErrorCode(response) : undefined;
      if (response.status !== 403 && response.status !== 409) await response.body?.cancel().catch(() => undefined);
      if (response.status === 403 && code === 'subgraph_bundle_scope_forbidden')
        throw new Error(
          'Subgraph target is unavailable to this project (403). Bundle members can only be referenced from the same bundle.',
        );
      if (response.status === 401 || response.status === 403)
        throw new Error(
          `Subgraph project service authentication was rejected (${response.status}). Check executor service credentials and API access.`,
        );
      if (response.status === 404) throw new Error('Subgraph target project or selected version was not found (404).');
      if (response.status === 409 && target.version === 'published' && code === 'workflow_publication_missing')
        throw new Error(
          'Subgraph target project has no published version (409). Publish it or choose Saved latest in the Subgraph settings.',
        );
      throw new Error(`Subgraph project service request failed (${response.status}).`);
    }
    if (action === 'access' && response.status !== 204) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Subgraph project service returned an invalid permission response.');
    }
    return response;
  }
  return {
    async validateTarget(target: SubgraphProjectTarget) {
      await read(target, 'access');
    },
    async loadTarget(target: SubgraphProjectTarget) {
      const response = await read(target, 'execution');
      let body: {
        projectContents?: string;
        datasetsContents?: string;
        revisionKey?: string;
        sourceProjectPath?: string;
      };
      try {
        body = await response.json();
      } catch {
        throw new Error('Subgraph project service returned an invalid artifact response.');
      }
      if (typeof body?.projectContents !== 'string')
        throw new Error('Subgraph project service returned no saved artifact.');
      let project: ReturnType<typeof loadProjectFromString>;
      let datasetProvider: NodeDatasetProvider;
      try {
        project = loadProjectFromString(body.projectContents, { logErrors: false });
        datasetProvider = new NodeDatasetProvider(
          body.datasetsContents ? deserializeDatasets(body.datasetsContents) : [],
        );
      } catch {
        throw new Error('Subgraph project service returned an invalid saved artifact.');
      }
      if (project.metadata.id !== target.projectId)
        throw new Error('Subgraph project service returned an invalid target.');
      return {
        project,
        datasetProvider,
        revisionKey: body.revisionKey,
        projectContents: body.projectContents,
        datasetsContents: body.datasetsContents,
        sourceProjectPath: body.sourceProjectPath,
      };
    },
  };
}
