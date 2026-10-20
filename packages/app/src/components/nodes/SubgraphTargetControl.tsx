import { css } from '@emotion/react';
import Select from '@atlaskit/select';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FC } from 'react';
import {
  getGraphBoundary,
  getSubgraphProjectKey,
  getSubgraphTargetBoundaryChange,
  getSubgraphTargetBoundaryIssue,
  reconcileSubgraphTargetBoundary,
  type GraphId,
  type Project,
  type ProjectId,
  type SubGraphNode,
  type SubgraphProjectVersion,
} from '@valerypopoff/rivet2-core';
import {
  useSubgraphProjectCatalog,
  type SubgraphProjectTreeFolder,
  type SubgraphProjectTreeItem,
} from '../../providers/ProvidersContext';
import { projectState, projectsState, referencedProjectsState } from '../../state/savedGraphs';
import { GraphSelectorSelect, getHierarchicalGraphOptions } from '../editors/GraphSelectorEditor';
import { OpenFolderIcon } from '../graphList/OpenFolderIcon';
import { graphState } from '../../state/graph';
import { useNodeEditorSessionContext } from '../nodeEditor/NodeEditorSessionContext';
import { filterSubgraphProjectTree, subgraphSourceScope } from '../../utils/subgraphBundleScope.js';

const controlCss = css`
  min-width: 0;
  width: 100%;

  .target-label {
    overflow-wrap: anywhere;
  }

  .target-error {
    color: var(--error);
    font-size: var(--ui-font-size-sm);
    margin-top: 6px;
  }

  .target-warning {
    color: var(--warning);
    font-size: var(--ui-font-size-sm);
    margin-top: 6px;
  }
`;

type Tree = { folders: SubgraphProjectTreeFolder[]; projects: SubgraphProjectTreeItem[] };

function findProjectName(tree: Tree | null, projectId: ProjectId): string | undefined {
  if (!tree) return undefined;
  const visit = (folders: SubgraphProjectTreeFolder[], projects: SubgraphProjectTreeItem[]): string | undefined => {
    const project = projects.find((item) => item.projectMetadataId === projectId);
    if (project) return project.name;
    for (const folder of folders) {
      const name = visit(folder.folders, folder.projects);
      if (name) return name;
    }
    return undefined;
  };
  return visit(tree.folders, tree.projects);
}
type TargetOption = {
  value: string;
  label: string;
  searchText: string;
  kind: 'section' | 'folder' | 'project' | 'graph-folder' | 'graph';
  depth: number;
  folderId?: string;
  projectId?: ProjectId;
  graphId?: GraphId;
  expanded?: boolean;
  isDisabled?: boolean;
};
type PreviewStatus = 'loading' | 'ready' | 'failed';

function makeTargetOptions(
  tree: Tree,
  ownProjectId: ProjectId,
  version: SubgraphProjectVersion,
  expandedFolders: ReadonlySet<string>,
  expandedProjects: ReadonlySet<ProjectId>,
  previews: Record<string, Project>,
  previewStatus: Readonly<Record<string, PreviewStatus>>,
  loadingTree: boolean,
  searching: boolean,
): TargetOption[] {
  const visit = (
    path: string,
    depth: number,
    folders: SubgraphProjectTreeFolder[],
    projects: SubgraphProjectTreeItem[],
  ): TargetOption[] => {
    const options: TargetOption[] = [];
    for (const folder of folders) {
      const folderPath = path ? `${path}/${folder.name}` : folder.name;
      const children =
        searching || expandedFolders.has(folder.id)
          ? visit(folderPath, depth + 1, folder.folders, folder.projects)
          : [];
      options.push({
        value: `folder:${folder.id}`,
        label: folder.name,
        searchText: `${folderPath} ${children.map((child) => child.searchText).join(' ')}`,
        kind: 'folder',
        depth,
        folderId: folder.id,
        expanded: searching || expandedFolders.has(folder.id),
      });
      options.push(...children);
    }
    for (const item of projects) {
      if (item.projectMetadataId === ownProjectId) continue;
      const projectId = item.projectMetadataId as ProjectId | undefined;
      const graphOptions =
        projectId && expandedProjects.has(projectId)
          ? getHierarchicalGraphOptions(previews[getSubgraphProjectKey({ projectId, version })]?.graphs ?? {}).map(
              (graphOption): TargetOption => ({
                value:
                  graphOption.kind === 'graph'
                    ? `graph:${projectId}:${graphOption.graphId}`
                    : `graph-folder:${projectId}:${graphOption.value}`,
                label: graphOption.label,
                searchText: `${item.relativePath} ${graphOption.searchText}`,
                kind: graphOption.kind === 'folder' ? 'graph-folder' : 'graph',
                depth: depth + 1 + graphOption.depth,
                projectId,
                graphId: graphOption.graphId,
                isDisabled:
                  graphOption.kind === 'folder' ||
                  loadingTree ||
                  previewStatus[getSubgraphProjectKey({ projectId, version })] !== 'ready',
              }),
            )
          : [];
      options.push({
        value: `project:${item.id}`,
        label: item.name,
        searchText: `${item.relativePath} ${graphOptions.map((option) => option.searchText).join(' ')}`,
        kind: 'project',
        depth,
        projectId,
        expanded: !!projectId && expandedProjects.has(projectId),
        isDisabled: !projectId,
      });
      options.push(...graphOptions);
    }
    return options;
  };
  const options = visit('', 0, tree.folders, tree.projects);
  return [
    {
      value: 'section:projects',
      label: 'Projects',
      searchText: options.map((option) => option.searchText).join(' '),
      kind: 'section',
      depth: 0,
      isDisabled: true,
    },
    ...options,
  ];
}

export const SubgraphTargetControl: FC<{
  node: SubGraphNode;
  isReadonly?: boolean;
  projectTree?: Tree | null;
  onProjectTreeChange?(tree: Tree | null): void;
  onChange(next: SubGraphNode): void;
}> = ({ node, isReadonly, projectTree, onProjectTreeChange, onChange }) => {
  const catalog = useSubgraphProjectCatalog();
  const store = useStore();
  const session = useNodeEditorSessionContext();
  const ownProject = useAtomValue(projectState);
  const openedProjects = useAtomValue(projectsState).openedProjects;
  const membershipKey = openedProjects[ownProject.metadata.id]?.hostedBundleKey;
  const graphId = useAtomValue(graphState).metadata?.id;
  const referencedProjects = useAtomValue(referencedProjectsState);
  const setReferencedProjects = useSetAtom(referencedProjectsState);
  const [localTree, setLocalTree] = useState<Tree | null>(null);
  // The settings source buttons and dropdown share one snapshot. Node-body
  // controls own their snapshot when no settings editor is present.
  const tree = projectTree === undefined ? localTree : projectTree;
  const setTree = onProjectTreeChange ?? setLocalTree;
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<ProjectId>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loadingTree, setLoadingTree] = useState(false);
  const [previewStatus, setPreviewStatus] = useState<Record<string, PreviewStatus>>({});
  const [error, setError] = useState<string>();
  const requestGenerations = useRef(new Map<string, number>());
  const treeGeneration = useRef(0);
  const mounted = useRef(false);
  const version = node.data.targetVersion ?? 'latest';
  const scope = subgraphSourceScope(node.data, tree, ownProject.metadata.id);
  const otherProjects = catalog && scope !== 'this-project';
  const selectedKey = node.data.targetProjectId
    ? getSubgraphProjectKey({ projectId: node.data.targetProjectId, version })
    : undefined;
  const selectedPreview = selectedKey ? referencedProjects[selectedKey] : undefined;

  const isCurrent = useCallback(() => {
    const graph = store.get(graphState);
    const current = session?.getNode() ?? graph.nodes.find((entry) => entry.id === node.id);
    return (
      mounted.current &&
      store.get(projectState).metadata.id === ownProject.metadata.id &&
      store.get(projectsState).openedProjects[ownProject.metadata.id]?.hostedBundleKey === membershipKey &&
      graph.metadata?.id === graphId &&
      current?.type === node.type &&
      ((current.data as SubGraphNode['data']).targetVersion ?? 'latest') === version &&
      !!(
        catalog &&
        ((current.data as SubGraphNode['data']).targetScope || (current.data as SubGraphNode['data']).targetProjectId)
      ) === !!otherProjects &&
      (current.data as SubGraphNode['data']).targetScope === node.data.targetScope &&
      (!session || session.isCurrent())
    );
  }, [
    store,
    session,
    ownProject.metadata.id,
    membershipKey,
    graphId,
    node.id,
    node.type,
    node.data.targetScope,
    version,
    catalog,
    otherProjects,
  ]);

  useLayoutEffect(() => {
    const requests = requestGenerations.current;
    const treeRequests = treeGeneration;
    mounted.current = true;
    setPreviewStatus({});
    setLoadingTree(false);
    setError(undefined);
    return () => {
      mounted.current = false;
      treeRequests.current++;
      // Keep generations monotonic; clearing the map could reuse an old ID.
      for (const [key, generation] of requests) requests.set(key, generation + 1);
    };
  }, [session, ownProject.metadata.id, membershipKey, graphId, version, otherProjects, node.data.targetScope]);

  useLayoutEffect(() => {
    setTree(null);
  }, [catalog, ownProject.metadata.id, membershipKey, setTree]);

  useEffect(() => {
    // Local node-body selectors need no server catalog. Settings load it even
    // before a target is chosen so they can advertise Same bundle correctly.
    if (!catalog || tree || menuOpen || (!onProjectTreeChange && !node.data.targetProjectId)) return;
    let active = true;
    const generation = ++treeGeneration.current;
    void catalog.listTree().then(
      (nextTree) => {
        if (active && isCurrent() && treeGeneration.current === generation) setTree(nextTree);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [catalog, tree, menuOpen, isCurrent, setTree, onProjectTreeChange, node.data.targetProjectId]);

  useEffect(() => {
    if (!catalog || !node.data.targetProjectId || !selectedKey || selectedPreview) return;
    let active = true;
    const projectId = node.data.targetProjectId;
    const generation = (requestGenerations.current.get(selectedKey) ?? 0) + 1;
    requestGenerations.current.set(selectedKey, generation);
    void catalog.preview({ projectId, version, callerProjectId: ownProject.metadata.id }).then(
      (project) => {
        if (!active || !isCurrent() || requestGenerations.current.get(selectedKey) !== generation) return;
        setReferencedProjects((current) =>
          Object.hasOwn(current, selectedKey) ? current : { ...current, [selectedKey]: project },
        );
        setPreviewStatus((current) => ({ ...current, [selectedKey]: 'ready' }));
      },
      (error: unknown) => {
        if (active && isCurrent() && requestGenerations.current.get(selectedKey) === generation) {
          setPreviewStatus((current) => ({ ...current, [selectedKey]: 'failed' }));
          if (error instanceof Error && 'status' in error && error.status === 403) setError(error.message);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [catalog, node.data.targetProjectId, selectedKey, selectedPreview, setReferencedProjects, version, isCurrent]);

  if (!catalog || !otherProjects) {
    if (!catalog && node.data.targetProjectId) {
      return (
        <div css={controlCss}>
          <span className="target-label">
            {selectedPreview?.metadata.title ||
              openedProjects[node.data.targetProjectId]?.title ||
              node.data.targetProjectId}
            {' / '}
            {selectedPreview?.graphs[node.data.graphId]?.metadata?.name || node.data.graphId}
          </span>
        </div>
      );
    }
    return (
      <GraphSelectorSelect
        value={node.data.graphId}
        isReadonly={isReadonly}
        includeMissingSelectedGraph
        hierarchical
        ariaLabel="Subgraph graph"
        className="subgraph-node-body-select"
        onChange={(graphId) =>
          isCurrent() &&
          !isReadonly &&
          (!session || session.canWrite()) &&
          onChange({
            ...node,
            data: {
              ...node.data,
              graphId,
              targetScope: undefined,
              targetProjectId: undefined,
              targetVersion: undefined,
              targetBoundary: undefined,
            },
          })
        }
      />
    );
  }

  const options = tree
    ? makeTargetOptions(
        filterSubgraphProjectTree(tree, ownProject.metadata.id, scope),
        ownProject.metadata.id,
        version,
        expandedFolders,
        expandedProjects,
        referencedProjects,
        previewStatus,
        loadingTree,
        !!search.trim(),
      )
    : [];
  const selectedGraph = selectedPreview?.graphs[node.data.graphId];
  const selectedProjectName = node.data.targetProjectId
    ? findProjectName(tree, node.data.targetProjectId) ?? selectedPreview?.metadata?.title ?? node.data.targetProjectId
    : undefined;
  const selectedGraphName =
    selectedGraph?.metadata?.name?.split('/').pop() ??
    (selectedPreview ? `Missing graph: ${node.data.graphId}` : node.data.graphId);
  const boundaryIssue = selectedGraph
    ? getSubgraphTargetBoundaryIssue(node.data.targetBoundary, getGraphBoundary(selectedPreview, node.data.graphId)!)
    : null;
  const selectedOption: TargetOption | null =
    node.data.targetProjectId && node.data.graphId
      ? {
          value: `graph:${node.data.targetProjectId}:${node.data.graphId}`,
          label: `${selectedProjectName} > ${selectedGraphName}`,
          searchText: '',
          kind: 'graph',
          depth: 0,
          projectId: node.data.targetProjectId,
          graphId: node.data.graphId,
        }
      : null;

  const loadPreview = async (projectId: ProjectId) => {
    if (!isCurrent()) return;
    const key = getSubgraphProjectKey({ projectId, version });
    const generation = (requestGenerations.current.get(key) ?? 0) + 1;
    requestGenerations.current.set(key, generation);
    setPreviewStatus((current) => ({ ...current, [key]: 'loading' }));
    setError(undefined);
    try {
      const project = await catalog.preview({ projectId, version, callerProjectId: ownProject.metadata.id });
      if (!isCurrent() || requestGenerations.current.get(key) !== generation) return;
      setReferencedProjects((current) => ({ ...current, [key]: project }));
      setPreviewStatus((current) => ({ ...current, [key]: 'ready' }));
    } catch (caught) {
      if (!isCurrent() || requestGenerations.current.get(key) !== generation) return;
      setPreviewStatus((current) => ({ ...current, [key]: 'failed' }));
      setError(caught instanceof Error ? caught.message : 'Could not load project graphs.');
    }
  };

  const openMenu = () => {
    if (!isCurrent() || isReadonly) return;
    const generation = ++treeGeneration.current;
    setMenuOpen(true);
    setLoadingTree(true);
    setError(undefined);
    // Shared definitions preserve existing wires, but do not authorize a new
    // selection. Each menu visit refreshes its visible expanded projects.
    setPreviewStatus({});
    for (const [key, generation] of requestGenerations.current) requestGenerations.current.set(key, generation + 1);
    void catalog.listTree().then(
      (nextTree) => {
        if (!isCurrent() || treeGeneration.current !== generation) return;
        setTree(nextTree);
        setLoadingTree(false);
        const visible = filterSubgraphProjectTree(
          nextTree,
          ownProject.metadata.id,
          subgraphSourceScope(node.data, nextTree, ownProject.metadata.id),
        );
        const refresh = new Set([...expandedProjects].filter((id) => findProjectName(visible, id) !== undefined));
        if (node.data.targetProjectId) refresh.add(node.data.targetProjectId);
        for (const id of refresh) void loadPreview(id);
      },
      (caught) => {
        if (!isCurrent() || treeGeneration.current !== generation) return;
        setError(caught instanceof Error ? caught.message : 'Could not load projects.');
        setLoadingTree(false);
        setTree(null);
      },
    );
    if (node.data.targetProjectId) {
      setExpandedProjects((current) => new Set(current).add(node.data.targetProjectId!));
    }
  };

  return (
    <div css={controlCss}>
      <Select
        aria-label="Subgraph graph"
        className="subgraph-node-body-select"
        isDisabled={isReadonly}
        isSearchable
        isLoading={loadingTree || Object.values(previewStatus).includes('loading')}
        closeMenuOnSelect={false}
        menuIsOpen={menuOpen}
        onMenuOpen={openMenu}
        onMenuClose={() => {
          setMenuOpen(false);
          setSearch('');
        }}
        inputValue={search}
        onInputChange={(value, meta) => {
          if (meta.action === 'input-change') setSearch(value);
        }}
        options={options}
        value={selectedOption}
        placeholder="Select graph..."
        noOptionsMessage={() => error ?? (loadingTree ? 'Loading projects...' : 'No matching projects or graphs')}
        filterOption={(candidate, input) =>
          candidate.data.searchText.toLocaleLowerCase().includes(input.toLocaleLowerCase())
        }
        formatOptionLabel={(option) => (
          <span style={{ alignItems: 'center', display: 'inline-flex', gap: 4, paddingLeft: option.depth * 12 }}>
            {option.kind === 'graph-folder' ? (
              <OpenFolderIcon width={14} height={14} aria-hidden="true" />
            ) : option.kind === 'section' ? (
              '📁'
            ) : option.kind === 'folder' || option.kind === 'project' ? (
              option.expanded ? (
                '▾'
              ) : (
                '▸'
              )
            ) : null}
            <span>{option.label}</span>
          </span>
        )}
        onChange={(option) => {
          if (!option || !isCurrent() || isReadonly || (session && !session.canWrite())) return;
          if (option.kind === 'folder' && option.folderId) {
            setExpandedFolders((current) => {
              const next = new Set(current);
              if (next.has(option.folderId!)) next.delete(option.folderId!);
              else next.add(option.folderId!);
              return next;
            });
          } else if (option.kind === 'project' && option.projectId) {
            setExpandedProjects((current) => {
              const next = new Set(current);
              if (next.has(option.projectId!)) next.delete(option.projectId!);
              else next.add(option.projectId!);
              return next;
            });
            if (!expandedProjects.has(option.projectId)) void loadPreview(option.projectId);
          } else if (option.kind === 'graph' && option.projectId && option.graphId) {
            const key = getSubgraphProjectKey({ projectId: option.projectId, version });
            const preview = referencedProjects[key];
            if (!preview || loadingTree || previewStatus[key] !== 'ready') return;
            const nextBoundary = getGraphBoundary(preview, option.graphId);
            if (!nextBoundary) return;
            const sameTarget = node.data.targetProjectId === option.projectId && node.data.graphId === option.graphId;
            onChange({
              ...node,
              data: {
                ...node.data,
                graphId: option.graphId,
                targetScope: scope === 'same-bundle' ? 'same-bundle' : 'other-projects',
                targetProjectId: option.projectId,
                targetVersion: version,
                targetBoundary:
                  sameTarget && !getSubgraphTargetBoundaryChange(node.data.targetBoundary, nextBoundary)
                    ? reconcileSubgraphTargetBoundary(node.data.targetBoundary, nextBoundary)
                    : nextBoundary,
              },
            });
            setMenuOpen(false);
            setSearch('');
          }
        }}
      />
      {node.data.targetProjectId && selectedPreview && !selectedGraph && (
        <div className="target-error">Selected graph is unavailable. Choose another graph.</div>
      )}
      {selectedKey && previewStatus[selectedKey] === 'failed' && (
        <div className="target-error">Could not refresh the target preview. Try again.</div>
      )}
      {boundaryIssue && (
        <div className="target-warning" role="alert">
          {boundaryIssue}
        </div>
      )}
      {error && (
        <div className="target-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
};
