import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { ChartNode, NodeBody, NodeConnection, NodeGraph, NodeId } from '@valerypopoff/rivet2-core';
import { ErrorBoundary } from 'react-error-boundary';
import { graphState } from '../../state/graph.js';
import {
  projectCompareReferenceState,
  viewingProjectComparisonNodeState,
  type ProjectCompareReference,
} from '../../state/projectComparison.js';
import { useProjectNodeRegistry } from '../../hooks/useProjectNodeRegistry.js';
import { useGetRivetUIContext } from '../../hooks/useGetRivetUIContext.js';
import { useVisibleCanvasNodes } from '../../hooks/useVisibleCanvasNodes.js';
import { useCanvasViewContext } from '../CanvasContext.js';
import { PlainNodeBody, MarkdownNodeBody, NodeBodySpecWrapper } from '../NodeBody.js';
import { ColorizedNodeBody } from '../ColorizedNodeBody.js';
import { NodeTitleLabel } from '../visualNode/NodeTitleLabel.js';
import { getNodeHeaderColor, getNodeHeaderForegroundColor } from '../../utils/nodeColor.js';
import {
  getComparisonBodySpecs,
  getComparisonNodeFallback,
  getComparisonNodePorts,
  getComparisonNodesById,
} from './comparisonNodeSnapshot.js';

export function ComparisonNodeLayer({
  referenceConnections,
  removedNodes,
  layer,
  viewportBounds,
}: {
  referenceConnections: readonly NodeConnection[];
  removedNodes: ChartNode[];
  layer: 'comments' | 'nodes';
  viewportBounds: { left: number; right: number; top: number; bottom: number };
}) {
  const reference = useAtomValue(projectCompareReferenceState);
  const currentGraph = useAtomValue(graphState);
  const graph =
    currentGraph.metadata?.id ? reference?.referenceProject.graphs[currentGraph.metadata.id] : undefined;
  const removedIds = useMemo(() => new Set(removedNodes.map((node) => node.id)), [removedNodes]);
  const nodesById = useMemo(
    () => (graph && reference ? getComparisonNodesById(reference.referenceProject, graph) : {}),
    [graph, reference],
  );
  const nodes = useMemo(() => {
    if (!graph) return [];
    // Also measure historical layouts for surviving endpoints of removed/changed wires.
    const endpoints = new Set(
      referenceConnections.flatMap((connection) => [
        connection.inputNodeId,
        connection.outputNodeId,
      ]),
    );
    return graph.nodes.filter(
      (node) =>
        (removedIds.has(node.id) || endpoints.has(node.id)) &&
        (layer === 'comments' ? node.type === 'comment' : node.type !== 'comment'),
    );
  }, [graph, referenceConnections, removedIds, layer]);
  const { visibleNodeIdSet, heavyContentNodeIdSet } = useVisibleCanvasNodes({
    nodes,
    viewportBounds,
    draggingNodeIds: [],
    editingNodeId: null,
    expandedOutputNodeIds: [],
    hoveringNodeId: undefined,
    selectedNodeIds: [],
  });
  if (!reference || !graph) return null;
  return (
    <>
      {nodes
        .filter((node) => visibleNodeIdSet.has(node.id))
        .map((node) => (
          <ComparisonNode
            key={node.id}
            node={node}
            graph={graph}
            reference={reference}
            nodesById={nodesById}
            geometryOnly={!removedIds.has(node.id)}
            loadBody={heavyContentNodeIdSet.has(node.id)}
          />
        ))}
    </>
  );
}

function ComparisonNode({
  node,
  graph,
  reference,
  nodesById,
  geometryOnly,
  loadBody,
}: {
  nodesById: Record<NodeId, ChartNode>;
  node: ChartNode;
  graph: NodeGraph;
  reference: ProjectCompareReference;
  geometryOnly: boolean;
  loadBody: boolean;
}) {
  const project = reference.referenceProject;
  const registry = useProjectNodeRegistry();
  const getUIContext = useGetRivetUIContext();
  const inspect = useSetAtom(viewingProjectComparisonNodeState);
  const { isZoomedOut } = useCanvasViewContext();
  const resolvedNode = nodesById[node.id] ?? node;
  const ports = useMemo(
    () => getComparisonNodePorts(registry, project, graph, node, nodesById),
    [registry, project, graph, node, nodesById],
  );
  const fallback = useMemo(() => getComparisonNodeFallback(resolvedNode, project), [resolvedNode, project]);
  const [preview, setPreview] = useState<{
    node: ChartNode;
    reference: ProjectCompareReference;
    graph: NodeGraph;
    body: NodeBody;
  }>();
  useEffect(() => {
    if (!loadBody || isZoomedOut) return;
    let active = true;
    void (async () => {
      try {
        const context = await getUIContext({ node: resolvedNode });
        const body = await registry
          .createDynamicImpl(resolvedNode)
          .getBody({ ...context, node: resolvedNode, project, graph, referencedProjects: {} });
        if (active) setPreview({ node, reference, graph, body });
      } catch {
        if (active) setPreview({ node, reference, graph, body: undefined });
      }
    })();
    return () => {
      active = false;
    };
  }, [getUIContext, graph, isZoomedOut, loadBody, node, project, reference, registry, resolvedNode]);
  const specs = getComparisonBodySpecs(
    preview?.node === node && preview.reference === reference && preview.graph === graph ? preview.body : undefined,
    fallback,
  );
  const open = () => {
    if (graph.metadata?.id && !geometryOnly) inspect({ graphId: graph.metadata.id, nodeId: node.id, reference });
  };
  const bg = getNodeHeaderColor(resolvedNode.visualData.color);
  return (
    <div
      className={`node comparison-node ${geometryOnly ? 'reference-geometry' : 'compare-removed'}`}
      data-comparison-nodeid={node.id}
      aria-hidden={geometryOnly || undefined}
      style={
        {
          transform: `translate(${node.visualData.x}px, ${node.visualData.y}px)`,
          width: resolvedNode.visualData.width,
          '--node-bg': bg,
          '--node-bg-foreground': getNodeHeaderForegroundColor(bg),
        } as CSSProperties
      }
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        open();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="node-border-overlay" aria-hidden="true" />
      <div className="node-title">
        <NodeTitleLabel node={resolvedNode} />
        {!geometryOnly && (
          <>
            <span className="comparison-deleted-label">Deleted</span>
            <button
              type="button"
              className="comparison-inspect"
              title="Inspect deleted node"
              aria-label="Inspect deleted node"
              onClick={open}
            >
              ⓘ
            </button>
          </>
        )}
      </div>
      {!isZoomedOut && (
        <div className="node-body">
          <ErrorBoundary resetKeys={[reference, graph, node]} fallback={<pre>{fallback.slice(0, 4000)}</pre>}>
            {specs.map((spec, index) => (
              <NodeBodySpecWrapper
                key={index}
                fontFamily={spec.fontFamily ?? 'monospace'}
                fontSize={spec.fontSize ?? 12}
              >
                {spec.type === 'plain' ? (
                  <PlainNodeBody {...spec} />
                ) : spec.type === 'markdown' ? (
                  <MarkdownNodeBody {...spec} disableLinks />
                ) : (
                  <ColorizedNodeBody {...spec} />
                )}
              </NodeBodySpecWrapper>
            ))}
          </ErrorBoundary>
        </div>
      )}
      <div className="node-ports">
        {(['input', 'output'] as const).map((side) => (
          <div key={side} className={`${side}-ports`}>
            {(side === 'input' ? ports.inputs : ports.outputs).map((port) => (
              <div className="port" key={port.id}>
                <div
                  className={`port-circle ${side}-port`}
                  data-portid={port.id}
                  data-nodeid={node.id}
                  data-porttype={side}
                  data-comparison-reference="true"
                />
                {!isZoomedOut && <div className="port-label">{port.title}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
