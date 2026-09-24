import { css } from '@emotion/react';
import Select from '@atlaskit/select';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef, useState, type FC } from 'react';
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
import { projectState, referencedProjectsState } from '../../state/savedGraphs';
import { GraphSelectorSelect, getHierarchicalGraphOptions } from '../editors/GraphSelectorEditor';
import { OpenFolderIcon } from '../graphList/OpenFolderIcon';

const controlCss = css`
  min-width: 0;
  width: 100%;

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

function makeTargetOptions(
  tree: Tree,
  ownProjectId: ProjectId,
  version: SubgraphProjectVersion,
  expandedFolders: ReadonlySet<string>,
  expandedProjects: ReadonlySet<ProjectId>,
  previews: Record<string, Project>,
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
                isDisabled: graphOption.kind === 'folder',
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
  onChange(next: SubGraphNode): void;
}> = ({ node, isReadonly, onChange }) => {
  const catalog = useSubgraphProjectCatalog();
  const ownProject = useAtomValue(projectState);
  const referencedProjects = useAtomValue(referencedProjectsState);
  const setReferencedProjects = useSetAtom(referencedProjectsState);
  const [tree, setTree] = useState<Tree | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<ReadonlySet<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<ProjectId>>(new Set());
  const [previews, setPreviews] = useState<Record<string, Project>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingProjectId, setLoadingProjectId] = useState<ProjectId>();
  const [error, setError] = useState<string>();
  const [failedPreviewKey, setFailedPreviewKey] = useState<string>();
  const requestGenerations = useRef(new Map<string, number>());
  const version = node.data.targetVersion ?? 'latest';
  const otherProjects = catalog && (node.data.targetScope === 'other-projects' || !!node.data.targetProjectId);
  const selectedKey = node.data.targetProjectId
    ? getSubgraphProjectKey({ projectId: node.data.targetProjectId, version })
    : undefined;
  const selectedPreview = selectedKey ? previews[selectedKey] ?? referencedProjects[selectedKey] : undefined;

  useEffect(() => {
    if (!catalog || !node.data.targetProjectId || tree) return;
    let active = true;
    void catalog.listTree().then(
      (nextTree) => {
        if (active) setTree(nextTree);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [catalog, node.data.targetProjectId, tree]);

  useEffect(() => {
    if (!catalog || !node.data.targetProjectId || !selectedKey || selectedPreview) return;
    let active = true;
    const projectId = node.data.targetProjectId;
    const generation = (requestGenerations.current.get(selectedKey) ?? 0) + 1;
    requestGenerations.current.set(selectedKey, generation);
    void catalog.preview({ projectId, version }).then(
      (project) => {
        if (!active || requestGenerations.current.get(selectedKey) !== generation) return;
        setPreviews((current) => ({ ...current, [selectedKey]: project }));
        setReferencedProjects((current) =>
          Object.hasOwn(current, selectedKey) ? current : { ...current, [selectedKey]: project },
        );
        setFailedPreviewKey(undefined);
      },
      () => {
        if (active && requestGenerations.current.get(selectedKey) === generation) setFailedPreviewKey(selectedKey);
      },
    );
    return () => {
      active = false;
    };
  }, [catalog, node.data.targetProjectId, selectedKey, selectedPreview, setReferencedProjects, version]);

  if (!catalog || !otherProjects) {
    if (!catalog && node.data.targetProjectId) {
      return (
        <div css={controlCss}>
          <span>
            {node.data.targetProjectId} / {node.data.graphId}
          </span>
          <div className="target-error">This project target can only be edited or run in Rivet Studio Server.</div>
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

  const availablePreviews: Record<string, Project> = { ...referencedProjects, ...previews };
  const options = tree
    ? makeTargetOptions(
        tree,
        ownProject.metadata.id,
        version,
        expandedFolders,
        expandedProjects,
        availablePreviews,
        !!search.trim(),
      )
    : [];
  const selectedGraph = selectedPreview?.graphs[node.data.graphId];
  const selectedProjectName = node.data.targetProjectId
    ? findProjectName(tree, node.data.targetProjectId) ?? selectedPreview?.metadata?.title ?? node.data.targetProjectId
    : undefined;
  const selectedGraphName = selectedGraph?.metadata?.name?.split('/').pop() ??
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

  const loadPreview = async (projectId: ProjectId, refresh: boolean) => {
    const key = getSubgraphProjectKey({ projectId, version });
    if (!refresh && availablePreviews[key]) return;
    const generation = (requestGenerations.current.get(key) ?? 0) + 1;
    requestGenerations.current.set(key, generation);
    setLoadingProjectId(projectId);
    setError(undefined);
    try {
      const project = await catalog.preview({ projectId, version });
      if (requestGenerations.current.get(key) !== generation) return;
      setPreviews((current) => ({ ...current, [key]: project }));
      setReferencedProjects((current) => ({ ...current, [key]: project }));
      setFailedPreviewKey(undefined);
    } catch (caught) {
      if (requestGenerations.current.get(key) !== generation) return;
      if (selectedKey === key) setFailedPreviewKey(key);
      setError(caught instanceof Error ? caught.message : 'Could not load project graphs.');
    } finally {
      if (requestGenerations.current.get(key) === generation) {
        setLoadingProjectId((current) => (current === projectId ? undefined : current));
      }
    }
  };

  const openMenu = () => {
    setMenuOpen(true);
    setLoadingTree(true);
    setError(undefined);
    void catalog.listTree().then(
      (nextTree) => {
        setTree(nextTree);
        setLoadingTree(false);
      },
      (caught) => {
        setError(caught instanceof Error ? caught.message : 'Could not load projects.');
        setLoadingTree(false);
      },
    );
    if (node.data.targetProjectId) {
      setExpandedProjects((current) => new Set(current).add(node.data.targetProjectId!));
      void loadPreview(node.data.targetProjectId, true);
    }
  };

  return (
    <div css={controlCss}>
      <Select
        aria-label="Subgraph graph"
        className="subgraph-node-body-select"
        isDisabled={isReadonly}
        isSearchable
        isLoading={loadingTree || !!loadingProjectId}
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
          if (!option) return;
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
            void loadPreview(option.projectId, false);
          } else if (option.kind === 'graph' && option.projectId && option.graphId) {
            const key = getSubgraphProjectKey({ projectId: option.projectId, version });
            const preview = availablePreviews[key];
            if (!preview || failedPreviewKey === key) return;
            const nextBoundary = getGraphBoundary(preview, option.graphId)!;
            const sameTarget = node.data.targetProjectId === option.projectId && node.data.graphId === option.graphId;
            onChange({
              ...node,
              data: {
                ...node.data,
                graphId: option.graphId,
                targetScope: 'other-projects',
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
      {selectedKey && failedPreviewKey === selectedKey && (
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
