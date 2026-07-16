import { useDraggable, useDroppable } from '@dnd-kit/core';
import {
  type CSSProperties,
  type FC,
  useEffect,
  useRef,
  useState,
  useMemo,
  type FocusEvent,
  type KeyboardEvent,
  memo,
  type SVGProps,
} from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { projectMetadataState } from '../../state/savedGraphs.js';
import clsx from 'clsx';
import { type GraphId, type NodeGraph, type ProjectComparisonChangeKind } from '@valerypopoff/rivet2-core';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import TextField from '@atlaskit/textfield';
import { expandedFoldersState } from '../../state/ui';
import { getGraphFolderExpansionStorageKey, type NodeGraphFolder, type NodeGraphFolderItem } from './graphFolders';
import { type GraphReachabilityBucket } from '../../utils/graphReachability.js';
import { MainGraphIcon } from './MainGraphIcon';
import { NodeRunningIndicator } from '../visualNode/NodeRunningIndicator.js';
import { getFolderItemPresentation, getGraphListItemPath } from './useGraphListPresentation.js';
import { Tooltip } from '../Tooltip.js';

export const FolderItem: FC<{
  item: NodeGraphFolderItem;
  runningGraphs: GraphId[];
  renamingItemFullPath: string | undefined;
  graph: NodeGraph;
  graphReachabilityByGraphId: Record<GraphId, GraphReachabilityBucket>;
  graphCompareKindByGraphId: Record<GraphId, ProjectComparisonChangeKind | undefined>;
  referencingSelectedGraphIds: ReadonlySet<GraphId>;
  depth: number;
  dragOverFolderName: string | undefined;
  draggingItemFolder: string | undefined;
  onGraphSelected?: (savedGraph: NodeGraph) => void;
  onRenameItem: (fullPath: string, newFullPath: string) => void;
  onCancelRename: () => void;
  showUnreachableIndicators: boolean;
}> = memo(
  ({
    item,
    runningGraphs,
    renamingItemFullPath,
    graph,
    graphReachabilityByGraphId,
    graphCompareKindByGraphId,
    referencingSelectedGraphIds,
    draggingItemFolder,
    onGraphSelected,
    onRenameItem,
    onCancelRename,
    depth,
    dragOverFolderName,
    showUnreachableIndicators,
  }) => {
    const projectMetadata = useAtomValue(projectMetadataState);
    const [expandedFolders, setExpandedFolders] = useAtom(expandedFoldersState);

    const fullPath = getGraphListItemPath(item);
    const folderExpansionKey = getGraphFolderExpansionStorageKey(projectMetadata.id, fullPath);
    const isExpanded = expandedFolders[folderExpansionKey] ?? true; // Default open

    const {
      containsReferencingSelectedGraph,
      folderGraphCount,
      graphIsRunning,
      isCollapsedOpenGraphFolder,
      isDraggingOver,
      isMainGraph,
      isRenaming,
      isSelected,
      referencesSelectedGraph,
      savedGraph,
      shouldShowUnreachableIndicator,
    } = getFolderItemPresentation({
      currentGraph: graph,
      dragOverFolderName,
      draggingItemFolder,
      fullPath,
      graphReachabilityByGraphId,
      isExpanded,
      item,
      mainGraphId: projectMetadata.mainGraphId,
      referencingSelectedGraphIds,
      renamingItemFullPath,
      runningGraphs,
      showUnreachableIndicators,
    });

    const handleRenameSaved = useStableCallback((newName: string) => {
      onRenameItem(fullPath, fullPath.replace(/[^/]+$/, newName));
    });

    const isComparisonRemovedGraph =
      item.type === 'graph' && item.isComparisonGhost && item.compareChangeKind === 'removed';

    const {
      attributes,
      listeners,
      setNodeRef: setDraggableNodeRef,
      transform,
      isDragging,
    } = useDraggable({ id: fullPath, disabled: isComparisonRemovedGraph });
    const suppressNextClickRef = useRef(false);
    const draggableRowProps = isRenaming || isComparisonRemovedGraph ? {} : { ...listeners, ...attributes };
    const dragStyle: CSSProperties = transform
      ? { position: 'relative', transform: `translate3d(0, ${transform.y}px, 0)`, zIndex: 100 }
      : {};
    const { setNodeRef: setDroppableNodeRef } = useDroppable({
      id: item.type === 'folder' ? fullPath + '/' : fullPath,
      disabled: isComparisonRemovedGraph,
    });

    const virtualDepth = useMemo(
      () =>
        isDragging && item.type === 'folder' && item.fullPath !== dragOverFolderName
          ? dragOverFolderName?.split('/').length ?? 0
          : depth,
      [isDragging, dragOverFolderName, depth, item],
    );
    const itemDepthStyle = { '--graph-item-indent': `${virtualDepth * 20}px` } as CSSProperties;
    const folderItemStyle = { ...itemDepthStyle, ...dragStyle };
    const showChildGuideLine = item.type === 'folder' && isExpanded && item.children.length > 0;
    const graphCompareKind = savedGraph?.metadata?.id ? graphCompareKindByGraphId[savedGraph.metadata.id] : undefined;
    const folderCompareKind =
      item.type === 'folder' ? getFolderCompareKind(item, graphCompareKindByGraphId) : undefined;
    const visibleCompareKind =
      item.type === 'graph'
        ? item.compareChangeKind ?? graphCompareKind
        : item.type === 'folder' && !isExpanded
          ? folderCompareKind
          : undefined;

    const setExpanded = useStableCallback((expanded: boolean) => {
      setExpandedFolders((prev) => ({
        ...prev,
        [folderExpansionKey]: expanded,
      }));
    });

    useEffect(() => {
      if (isDragging) {
        suppressNextClickRef.current = true;
      }
    }, [isDragging]);

    const handleItemClick = useStableCallback(() => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        return;
      }

      if (isComparisonRemovedGraph) {
        return;
      }

      if (item.type === 'graph') {
        onGraphSelected?.(item.graph);
      } else {
        setExpanded(!isExpanded);
      }
    });

    return (
      <div ref={setDroppableNodeRef}>
        <div
          className={clsx('folder-item', { 'dragging-over': isDraggingOver, dragging: isDragging })}
          ref={setDraggableNodeRef}
          style={folderItemStyle}
        >
          <div
            className={clsx('graph-item', {
              selected: isSelected,
              'folder-graph-item': item.type === 'folder',
              'contains-open-graph': isCollapsedOpenGraphFolder,
              'compare-removed-graph': isComparisonRemovedGraph,
            })}
            data-contextmenutype={
              isComparisonRemovedGraph ? undefined : item.type === 'folder' ? 'graph-folder' : 'graph-item'
            }
            data-graphid={savedGraph?.metadata?.id}
            data-folderpath={item.type === 'folder' ? item.fullPath : item.graph.metadata?.name}
          >
            <div className="graph-item-select" {...draggableRowProps} onClick={handleItemClick}>
              {isRenaming ? (
                <FolderItemRename
                  value={fullPath.replace(/.*\//, '')}
                  onSaved={handleRenameSaved}
                  onCancel={onCancelRename}
                />
              ) : (
                <>
                  {graphIsRunning && (
                    <div className="spinner">
                      <NodeRunningIndicator isRunning delayMs={0} label="Graph running" />
                    </div>
                  )}
                  {(referencesSelectedGraph || containsReferencingSelectedGraph) && (
                    <span
                      className={clsx('graph-reference-dot', {
                        'folder-reference-dot': containsReferencingSelectedGraph,
                      })}
                      aria-hidden="true"
                    />
                  )}
                  <span className="graph-item-name">
                    {item.type === 'folder' &&
                      (isExpanded ? (
                        <OpenFolderIcon className="graph-folder-icon" aria-hidden="true" />
                      ) : (
                        <FolderIcon className="graph-folder-icon" aria-hidden="true" />
                      ))}
                    <span className="graph-item-name-text">{item.name}</span>
                    {isMainGraph && <MainGraphIcon className="graph-main-icon" />}
                    {folderGraphCount != null && (
                      <span className="graph-folder-count">
                        <span>{folderGraphCount}</span>
                      </span>
                    )}
                  </span>
                </>
              )}
              {shouldShowUnreachableIndicator && (
                <Tooltip
                  content="This graph is not reachable from the Main Graph or a web app."
                  placement="right"
                  tag="span"
                  className="unreachable-indicator-tooltip"
                >
                  <span className="unreachable-indicator" role="img" aria-label="Unreachable graph">
                    <UnreachableGraphIcon aria-hidden="true" />
                  </span>
                </Tooltip>
              )}
              {visibleCompareKind && (
                <span className={`graph-compare-badge compare-${visibleCompareKind}`}>{visibleCompareKind}</span>
              )}
            </div>
          </div>
          {item.type === 'folder' && (
            <div
              className={clsx('folder-children', {
                expanded: isExpanded,
                'with-guide-line': showChildGuideLine,
              })}
            >
              {item.children.map((child) => (
                <FolderItem
                  key={child.type === 'graph' ? child.graph.metadata?.id : child.fullPath}
                  item={child}
                  runningGraphs={runningGraphs}
                  renamingItemFullPath={renamingItemFullPath}
                  graph={graph}
                  graphReachabilityByGraphId={graphReachabilityByGraphId}
                  graphCompareKindByGraphId={graphCompareKindByGraphId}
                  referencingSelectedGraphIds={referencingSelectedGraphIds}
                  onGraphSelected={onGraphSelected}
                  onRenameItem={onRenameItem}
                  onCancelRename={onCancelRename}
                  dragOverFolderName={dragOverFolderName}
                  depth={virtualDepth + 1}
                  draggingItemFolder={draggingItemFolder}
                  showUnreachableIndicators={showUnreachableIndicators}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },
);

FolderItem.displayName = 'FolderItem';

function getFolderCompareKind(
  item: NodeGraphFolder,
  graphCompareKindByGraphId: Record<GraphId, ProjectComparisonChangeKind | undefined>,
): ProjectComparisonChangeKind | undefined {
  let hasAdded = false;
  let hasRemoved = false;

  for (const child of item.children) {
    const childKind =
      child.type === 'graph'
        ? child.compareChangeKind ??
          (child.graph.metadata?.id ? graphCompareKindByGraphId[child.graph.metadata.id] : undefined)
        : getFolderCompareKind(child, graphCompareKindByGraphId);

    if (childKind === 'changed') {
      return 'changed';
    }

    if (childKind === 'removed') {
      hasRemoved = true;
    }

    if (childKind === 'added') {
      hasAdded = true;
    }
  }

  return hasRemoved ? 'removed' : hasAdded ? 'added' : undefined;
}

const OpenFolderIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path
      d="M3 11V6a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.664.89l.812 1.22A2 2 0 0 0 13.07 7H19a2 2 0 0 1 2 2v2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3 11h18l-2 7a2 2 0 0 1-1.92 1.45H5.92A2 2 0 0 1 4 18l-1-7Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const UnreachableGraphIcon: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 28 22" fill="none" {...props}>
    {/* Existing connection */}
    <path d="M9.5 17.5 H19.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />

    <circle cx="5" cy="17.5" r="3.5" fill="currentColor" />
    <circle cx="24" cy="17.5" r="3.5" fill="currentColor" />

    {/* Failed connection attempt — begins with a gap */}
    <path
      d="M6 13 C8 6.5 14 3.5 19 4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray="2.5 5"
      strokeDashoffset="3.5"
    />

    {/* Larger 45-degree cross */}
    <path d="M20.5 1.5 L26.5 7.5 M26.5 1.5 L20.5 7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const FolderItemRename: FC<{
  value: string;
  onSaved: (newName: string) => void;
  onCancel: () => void;
}> = ({ value, onSaved, onCancel }) => {
  const [renameValue, setRenameValue] = useState(value);
  const renameFieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ownerDocument = renameFieldRef.current?.ownerDocument ?? document;
    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && renameFieldRef.current?.contains(target)) {
        return;
      }

      onCancel();
    };

    ownerDocument.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      ownerDocument.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, [onCancel]);

  const handleRenameFocus = useStableCallback((e: FocusEvent<HTMLInputElement>) => {
    e.target.select();
    e.preventDefault();
  });

  const handleRenameBlur = useStableCallback(() => {
    onCancel();
  });

  const handleRenameKeyDown = useStableCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onSaved(renameValue);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  });

  return (
    <div ref={renameFieldRef}>
      <TextField
        autoFocus
        onFocus={handleRenameFocus}
        onBlur={handleRenameBlur}
        onKeyDown={handleRenameKeyDown}
        value={renameValue}
        onChange={(e) => setRenameValue((e.target as HTMLInputElement).value)}
      />
    </div>
  );
};
