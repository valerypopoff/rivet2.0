import { randomUUID } from 'node:crypto';
import {
  deserializeDatasets,
  serializeDatasets,
  loadProjectAndAttachedDataFromString,
  serializeProject,
  validateProjectBundleManifest,
  validateProjectBundleProjects,
  ProjectBundleError,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import {
  PROJECT_BUNDLE_UPLOAD_MAX_BYTES,
  PROJECT_BUNDLE_UPLOAD_MAX_FILES,
  type ProjectBundleUploadFile,
} from '../../../../studio-server-shared/project-bundle-types.js';
import { badRequest } from '../../utils/httpError.js';
import { sanitizeWorkflowName } from './fs-helpers.js';

export type PreparedProjectBundleImport = {
  folderName: string;
  rootProjectId: string;
  projects: { id: string; name: string; contents: string; datasetsContents: string | null }[];
};

/** Validates the whole group before storage mutation; never installs plugins or executes nodes. */
export function prepareProjectBundleImport(files: ProjectBundleUploadFile[]): PreparedProjectBundleImport {
  if (!files.length || files.length > PROJECT_BUNDLE_UPLOAD_MAX_FILES) throw badRequest('Invalid bundle file count.');
  const byPath = new Map<string, string>();
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    if (
      file.path.length > 4096 ||
      /[\\:\0]/.test(file.path) ||
      file.path.split('/').some((p) => !p || p === '.' || p === '..')
    )
      throw badRequest('Bundle contains an unsafe file path.');
    if (paths.has(file.path.toLowerCase())) throw badRequest('Bundle contains duplicate file paths.');
    paths.add(file.path.toLowerCase());
    bytes += Buffer.byteLength(file.contents);
    if (bytes > PROJECT_BUNDLE_UPLOAD_MAX_BYTES) throw badRequest('Bundle upload exceeds 64 MiB of file contents.');
    byPath.set(file.path, file.contents);
  }
  const manifestText = byPath.get('rivet-bundle.json');
  if (!manifestText || Buffer.byteLength(manifestText) > 1024 * 1024)
    throw badRequest('Choose a bundle containing rivet-bundle.json (maximum 1 MiB).');
  try {
    const manifest = validateProjectBundleManifest(JSON.parse(manifestText.replace(/^\uFEFF/, '')));
    const originals = new Map<
      string,
      {
        project: Project;
        attached: ReturnType<typeof loadProjectAndAttachedDataFromString>[1];
        datasets: ReturnType<typeof deserializeDatasets> | null;
      }
    >();
    const identities = new Set<string>();
    const allowed = new Set(['rivet-bundle.json', 'README.txt']);
    for (const artifact of manifest.artifacts) {
      if (identities.has(artifact.projectId))
        throw badRequest(
          'This bundle contains multiple versions of one project. Re-export using a bundle-wide version selection.',
        );
      identities.add(artifact.projectId);
      const contents = byPath.get(artifact.project.path);
      if (contents === undefined) throw badRequest(`Bundle is missing ${artifact.project.path}.`);
      allowed.add(artifact.project.path);
      const [project, attached] = loadProjectAndAttachedDataFromString(contents);
      const data = artifact.datasets ? byPath.get(artifact.datasets.path) : null;
      if (artifact.datasets) allowed.add(artifact.datasets.path);
      if (data === undefined) throw badRequest('Bundle is missing a declared dataset file.');
      const datasets = data === null ? null : deserializeDatasets(data);
      if (datasets !== null) {
        if (!Array.isArray(datasets)) throw badRequest('Invalid bundle datasets.');
        const datasetIds = new Set<string>();
        for (const dataset of datasets) {
          if (
            !dataset?.meta ||
            !dataset.data ||
            typeof dataset.meta.id !== 'string' ||
            !dataset.meta.id ||
            dataset.meta.projectId !== artifact.projectId ||
            typeof dataset.meta.name !== 'string' ||
            dataset.data.id !== dataset.meta.id ||
            !Array.isArray(dataset.data.rows)
          )
            throw badRequest('Invalid bundle dataset metadata or rows.');
          if (datasetIds.has(dataset.meta.id)) throw badRequest('Bundle contains duplicate dataset IDs.');
          datasetIds.add(dataset.meta.id);
          const rowIds = new Set<string>();
          for (const row of dataset.data.rows) {
            if (
              !row ||
              typeof row.id !== 'string' ||
              !Array.isArray(row.data) ||
              row.data.some((value) => typeof value !== 'string') ||
              (row.embedding !== undefined &&
                (!Array.isArray(row.embedding) ||
                  row.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))))
            )
              throw badRequest('Invalid bundle dataset row or embedding.');
            if (rowIds.has(row.id)) throw badRequest('Bundle contains duplicate dataset row IDs.');
            rowIds.add(row.id);
          }
        }
      }
      originals.set(artifact.id, { project, attached, datasets });
    }
    if (files.some((file) => !allowed.has(file.path))) throw badRequest('Bundle contains undeclared files.');
    validateProjectBundleProjects(manifest, new Map([...originals].map(([id, entry]) => [id, entry.project])));
    const ids = new Map(manifest.artifacts.map((a) => [a.projectId, randomUUID() as ProjectId]));
    const names = new Set<string>();
    const cleanName = (title: string) =>
      sanitizeWorkflowName(
        title
          .replace(/[\\/<>:"|?*\x00-\x1f]/g, ' ')
          .replace(/^\.+/, '')
          .trim()
          .slice(0, 100) || 'Project',
        'project name',
      );
    const resolveId = (id: string): ProjectId => {
      const mapped = ids.get(id);
      if (!mapped) throw badRequest('Bundle contains a project reference outside its imported group.');
      return mapped;
    };
    const projects = manifest.artifacts.map((artifact) => {
      const { project, attached, datasets } = originals.get(artifact.id)!;
      const base = cleanName(project.metadata.title);
      let name = base;
      for (let i = 2; names.has(name.toLowerCase()); i++) name = `${base} ${i}`;
      names.add(name.toLowerCase());
      project.metadata.id = resolveId(artifact.projectId);
      project.metadata.title = name;
      delete project.metadata.path;
      if (project.references)
        project.references = project.references.map(({ hintPaths: _hints, ...reference }) => ({
          ...reference,
          id: resolveId(reference.id),
        }));
      const nodes = [
        ...Object.values(project.graphs).flatMap((g) => g.nodes),
        ...Object.values(project.nodePrefabs ?? {}).map((p) => p.sourceNode),
      ];
      for (const node of nodes) {
        if (node.type !== 'subGraph' && node.type !== 'referencedGraphAlias') continue;
        const targetField = node.type === 'subGraph' ? 'targetProjectId' : 'projectId';
        for (const configuration of [node.data, ...(node.variants ?? []).map((variant) => variant.data)]) {
          // Saved variants deliberately have unknown data in Core's public contract.
          // Narrow each object before remapping; preserve unfinished inactive values.
          if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) continue;
          const data = configuration as Record<string, unknown>;
          const target = data[targetField];
          const mapped = typeof target === 'string' ? ids.get(target) : undefined;
          if (!mapped) continue;
          data[targetField] = mapped;
          // Imported snapshots are drafts, including saved alternative configurations.
          if (node.type === 'subGraph') data.targetVersion = 'latest';
        }
      }
      for (const dataset of datasets ?? []) dataset.meta.projectId = project.metadata.id;
      return {
        id: project.metadata.id,
        name,
        contents: serializeProject(project, attached) as string,
        datasetsContents: datasets === null ? null : serializeDatasets(datasets),
      };
    });
    const rootArtifact = manifest.artifacts.find((a) => a.id === manifest.rootArtifact)!;
    const rootProjectId = resolveId(rootArtifact.projectId);
    const root = projects.find((project) => project.id === rootProjectId)!;
    return { folderName: `${root.name} bundle ${randomUUID().slice(0, 8)}`, rootProjectId, projects };
  } catch (error) {
    if (error instanceof ProjectBundleError) throw badRequest(error.message);
    if (error instanceof Error && 'status' in error) throw error;
    throw badRequest('Invalid bundle manifest, project or dataset file.');
  }
}
