import { css } from '@emotion/react';
import { type ChartNode, type NodeId } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { type FC, type ReactNode, type RefObject } from 'react';
import { useMoveNodeCommand } from '../../commands/moveNodeCommand.js';
import { useSetNodeWidthsCommand } from '../../commands/setNodeWidthsCommand.js';
import {
  calculateMultiNodeEqualWidthChanges,
  calculateMultiNodeAlignmentMoves,
  type MultiNodeAlignmentAction,
  type NodeLayoutBounds,
} from '../../domain/graphEditing/multiNodeAlignment.js';
import { getCanvasNodeWidth } from '../../hooks/canvasVisibilityBounds.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { isReadOnlyGraphState } from '../../state/graph.js';
import { Tooltip } from '../Tooltip.js';

const DEFAULT_NODE_HEIGHT = 200;

type NodeWidthMeasurementMode = 'layout' | 'resize';

const styles = css`
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 215;
  display: flex;
  align-items: stretch;
  padding: 4px;
  background: var(--grey-darker);
  border: 1px solid var(--grey);
  border-radius: 16px;
  corner-shape: squircle;
  @supports not (corner-shape: squircle) {
    border-radius: 8px;
  }
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.28);
  pointer-events: auto;

  .alignment-grid {
    display: grid;
    grid-template-columns: repeat(3, 36px);
    grid-template-rows: repeat(2, 36px);
  }

  .sizing-column,
  .distribution-column {
    display: grid;
    grid-template-columns: 36px;
    margin-left: 4px;
    padding-left: 8px;
    border-left: 1px solid var(--grey);
  }

  .sizing-column {
    grid-template-rows: 36px;
    align-content: center;
  }

  .distribution-column {
    grid-template-rows: repeat(2, 36px);
  }

  .toolbar-button {
    display: flex;
  }

  button {
    width: 36px;
    height: 36px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: 12px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 6px;
    }
    color: var(--grey-light);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  button:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  button:active {
    background: rgba(255, 255, 255, 0.14);
  }

  svg {
    width: 18px;
    height: 18px;
    display: block;
  }
`;

function measureNodeBounds(
  selectedNodes: readonly ChartNode[],
  canvasRoot: HTMLDivElement | null,
  widthMeasurementMode: NodeWidthMeasurementMode = 'layout',
): NodeLayoutBounds[] {
  const nodeElements = new Map<NodeId, HTMLElement>();

  canvasRoot?.querySelectorAll<HTMLElement>('.node[data-nodeid]:not(.overlayNode)').forEach((element) => {
    const nodeId = element.dataset.nodeid as NodeId | undefined;
    if (nodeId) {
      nodeElements.set(nodeId, element);
    }
  });

  return selectedNodes.map((node) => {
    const element = nodeElements.get(node.id);

    return {
      nodeId: node.id,
      x: node.visualData.x,
      y: node.visualData.y,
      width: getMeasuredNodeWidth(node, element, widthMeasurementMode),
      height: element?.offsetHeight ?? DEFAULT_NODE_HEIGHT,
    };
  });
}

function getMeasuredNodeWidth(
  node: ChartNode,
  element: HTMLElement | undefined,
  widthMeasurementMode: NodeWidthMeasurementMode,
): number {
  if (!element) {
    return getCanvasNodeWidth(node);
  }

  if (widthMeasurementMode === 'layout') {
    return element.offsetWidth;
  }

  const computedWidth = Number.parseFloat(window.getComputedStyle(element).width);
  if (Number.isFinite(computedWidth)) {
    return computedWidth;
  }

  return getCanvasNodeWidth(node);
}

const IconFrame: FC<{ children: ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    {children}
  </svg>
);

const AlignLeftIcon = () => (
  <IconFrame>
    <path d="M3 2v12" />
    <path d="M3 5h8" />
    <path d="M3 11h5" />
  </IconFrame>
);

const AlignCenterIcon = () => (
  <IconFrame>
    <path d="M8 2v12" />
    <path d="M4 5h8" />
    <path d="M5 11h6" />
  </IconFrame>
);

const AlignRightIcon = () => (
  <IconFrame>
    <path d="M13 2v12" />
    <path d="M5 5h8" />
    <path d="M8 11h5" />
  </IconFrame>
);

const AlignTopIcon = () => (
  <IconFrame>
    <path d="M2 3h12" />
    <path d="M5 3v8" />
    <path d="M11 3v5" />
  </IconFrame>
);

const AlignMiddleIcon = () => (
  <IconFrame>
    <path d="M2 8h12" />
    <path d="M5 4v8" />
    <path d="M11 5v6" />
  </IconFrame>
);

const AlignBottomIcon = () => (
  <IconFrame>
    <path d="M2 13h12" />
    <path d="M5 5v8" />
    <path d="M11 8v5" />
  </IconFrame>
);

const DistributeHorizontallyIcon = () => (
  <IconFrame>
    <path d="M3.5 2.5v11" />
    <path d="M8 5v6" />
    <path d="M12.5 2.5v11" />
  </IconFrame>
);

const DistributeVerticallyIcon = () => (
  <IconFrame>
    <path d="M2.5 3.5h11" />
    <path d="M5 8h6" />
    <path d="M2.5 12.5h11" />
  </IconFrame>
);

const EqualWidthIcon = () => (
  <IconFrame>
    <rect x="3" y="4" width="10" height="3" rx="0.8" />
    <rect x="3" y="9" width="10" height="3" rx="0.8" />
  </IconFrame>
);

const ToolbarButton: FC<{
  label: string;
  onClick: () => void;
  children: ReactNode;
}> = ({ label, onClick, children }) => (
  <Tooltip content={label} tag="span" className="toolbar-button">
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  </Tooltip>
);

export interface MultiNodeAlignmentToolbarProps {
  canvasRootRef: RefObject<HTMLDivElement | null>;
  nodes?: ChartNode[];
  onNodesChanged?: (nodes: ChartNode[]) => void;
  selectedNodes: ChartNode[];
}

export function shouldShowMultiNodeAlignmentToolbar(options: {
  selectedNodeCount: number;
  isReadOnlyGraph: boolean;
}): boolean {
  return options.selectedNodeCount >= 2 && !options.isReadOnlyGraph;
}

export const MultiNodeAlignmentToolbar: FC<MultiNodeAlignmentToolbarProps> = ({
  canvasRootRef,
  nodes,
  onNodesChanged,
  selectedNodes,
}) => {
  const moveNode = useMoveNodeCommand();
  const setNodeWidths = useSetNodeWidthsCommand();
  const isReadOnlyGraph = useAtomValue(isReadOnlyGraphState);
  const controlledCanvas = Boolean(nodes && onNodesChanged);

  const applyLocalNodeUpdates = useStableCallback(
    (
      update: (
        node: ChartNode,
      ) => {
        position?: { x: number; y: number };
        width?: number;
      },
    ) => {
      if (!nodes || !onNodesChanged) {
        return;
      }

      onNodesChanged(
        nodes.map((node) => {
          const next = update(node);
          if (!next.position && next.width === undefined) {
            return node;
          }

          return {
            ...node,
            visualData: {
              ...node.visualData,
              ...(next.position ? { x: next.position.x, y: next.position.y } : {}),
              ...(next.width !== undefined ? { width: next.width } : {}),
            },
          };
        }),
      );
    },
  );

  const applyAction = useStableCallback((action: MultiNodeAlignmentAction) => {
    const bounds = measureNodeBounds(selectedNodes, canvasRootRef.current);
    const moves = calculateMultiNodeAlignmentMoves(bounds, action).filter((move) => {
      const node = selectedNodes.find((selectedNode) => selectedNode.id === move.nodeId);
      return !node || node.visualData.x !== move.position.x || node.visualData.y !== move.position.y;
    });

    if (moves.length === 0) {
      return;
    }

    if (controlledCanvas) {
      const movesByNodeId = new Map(moves.map((move) => [move.nodeId, move.position]));
      applyLocalNodeUpdates((node) => ({ position: movesByNodeId.get(node.id) }));
      return;
    }

    moveNode({ moves });
  });

  const applyEqualWidth = useStableCallback(() => {
    const bounds = measureNodeBounds(selectedNodes, canvasRootRef.current, 'resize');
    const currentWidthsByNodeId = new Map(bounds.map((node) => [node.nodeId, node.width]));
    const widths = calculateMultiNodeEqualWidthChanges(bounds).filter((widthChange) => {
      const currentWidth = currentWidthsByNodeId.get(widthChange.nodeId);
      return currentWidth !== widthChange.width;
    });

    if (widths.length === 0) {
      return;
    }

    if (controlledCanvas) {
      const widthsByNodeId = new Map(widths.map((widthChange) => [widthChange.nodeId, widthChange.width]));
      applyLocalNodeUpdates((node) => ({ width: widthsByNodeId.get(node.id) }));
      return;
    }

    setNodeWidths({ widths });
  });

  if (
    !shouldShowMultiNodeAlignmentToolbar({
      selectedNodeCount: selectedNodes.length,
      isReadOnlyGraph: controlledCanvas ? false : isReadOnlyGraph,
    })
  ) {
    return null;
  }

  return (
    <div css={styles}>
      <div className="alignment-grid">
        <ToolbarButton label="Align top" onClick={() => applyAction('align-top')}>
          <AlignTopIcon />
        </ToolbarButton>
        <ToolbarButton label="Align middle" onClick={() => applyAction('align-middle')}>
          <AlignMiddleIcon />
        </ToolbarButton>
        <ToolbarButton label="Align bottom" onClick={() => applyAction('align-bottom')}>
          <AlignBottomIcon />
        </ToolbarButton>
        <ToolbarButton label="Align left" onClick={() => applyAction('align-left')}>
          <AlignLeftIcon />
        </ToolbarButton>
        <ToolbarButton label="Align center" onClick={() => applyAction('align-center')}>
          <AlignCenterIcon />
        </ToolbarButton>
        <ToolbarButton label="Align right" onClick={() => applyAction('align-right')}>
          <AlignRightIcon />
        </ToolbarButton>
      </div>
      <div className="sizing-column">
        <ToolbarButton label="Make equal width" onClick={applyEqualWidth}>
          <EqualWidthIcon />
        </ToolbarButton>
      </div>
      <div className="distribution-column">
        <ToolbarButton label="Distribute horizontally" onClick={() => applyAction('distribute-horizontally')}>
          <DistributeHorizontallyIcon />
        </ToolbarButton>
        <ToolbarButton label="Distribute vertically" onClick={() => applyAction('distribute-vertically')}>
          <DistributeVerticallyIcon />
        </ToolbarButton>
      </div>
    </div>
  );
};
