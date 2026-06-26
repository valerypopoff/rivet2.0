import { type ChartNode, type SubGraphNode } from '@valerypopoff/rivet2-core';
import { useAtomValue } from 'jotai';
import { type FC, type MouseEvent, type PointerEvent } from 'react';
import { useGoToSubgraphNode } from '../../hooks/useGoToSubgraphNode.js';
import { projectState } from '../../state/savedGraphs.js';
import { Tooltip } from '../Tooltip.js';
import { SubgraphGraphIcon } from './SubgraphGraphIcon.js';

export const SubGraphHeaderLink: FC<{ node: ChartNode }> = ({ node }) => {
  const goToSubgraphNode = useGoToSubgraphNode();
  const project = useAtomValue(projectState);

  if (node.type !== 'subGraph') {
    return null;
  }

  const subGraphNode = node as SubGraphNode;
  const graphId = subGraphNode.data.graphId;

  if (!graphId || !project.graphs[graphId]) {
    return null;
  }

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    goToSubgraphNode(subGraphNode);
  };

  const stopHeaderDrag = (event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
  };

  return (
    <Tooltip className="subgraph-link-tooltip" content="Go to subgraph">
      <button
        type="button"
        className="subgraph-link-button"
        aria-label="Go to subgraph"
        onClick={handleClick}
        onMouseDown={stopHeaderDrag}
        onPointerDown={stopHeaderDrag}
      >
        <SubgraphGraphIcon />
      </button>
    </Tooltip>
  );
};
