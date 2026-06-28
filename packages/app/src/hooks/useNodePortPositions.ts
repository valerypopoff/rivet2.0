import { type ChartNode, type PortId, type NodeId } from '@valerypopoff/rivet2-core';
import { useState, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { type PortPositions } from '../components/NodeCanvas';

const OBSERVED_PORT_LAYOUT_SELECTOR = [
  '.node:not(.overlayNode)',
  '.node:not(.overlayNode) .node-ports',
  '.node:not(.overlayNode) .input-ports',
  '.node:not(.overlayNode) .output-ports',
].join(', ');

const PORT_LAYOUT_MUTATION_SELECTOR = [
  '.node',
  '.node-ports',
  '.input-ports',
  '.output-ports',
  '.port',
  '.port-circle',
].join(', ');

const OBSERVED_PORT_LAYOUT_ATTRIBUTE_FILTER = ['class', 'style'];

function isPortLayoutMutationElement(element: Element): boolean {
  return element.matches(PORT_LAYOUT_MUTATION_SELECTOR) || !!element.querySelector(PORT_LAYOUT_MUTATION_SELECTOR);
}

/**
 * Calculate the position of every port relative to the canvas root, in canvas space.
 * This is done in one pass per NodeCanvas render, and is used to draw the edges between nodes.
 * It's done this way with a nodePortPositions state using rounded numbers for performance reasons.
 * In the ideal case, no position will have changed, so the state does not update.
 */
export function useNodePortPositions({
  enabled,
  isDraggingNode,
  isDraggingWire,
  nodes,
  visibleNodeIdSet,
}: {
  enabled: boolean;
  isDraggingNode: boolean;
  isDraggingWire: boolean;
  nodes: readonly ChartNode[];
  visibleNodeIdSet: ReadonlySet<NodeId>;
}) {
  const [nodePortPositions, setNodePortPositions] = useState<PortPositions>({});
  const nodePortPositionsRef = useRef(nodePortPositions);
  const liveMeasurementAnimationFrameRef = useRef<number | undefined>(undefined);
  const scheduledRecalculateAnimationFrameRef = useRef<number | undefined>(undefined);
  const observedPortLayoutElementsRef = useRef<HTMLElement[]>([]);
  const nodesById = useMemo(() => Object.fromEntries(nodes.map((node) => [node.id, node])), [nodes]) as Record<
    NodeId,
    ChartNode
  >;
  const canvasRef = useRef<HTMLDivElement>(null);

  const recalculate = useCallback(() => {
    if (!enabled) {
      return;
    }

    const previousPositions = nodePortPositionsRef.current;

    // Lot of duplication but meh
    const normalPortElements = canvasRef.current?.querySelectorAll(
      '.node:not(.overlayNode) .port-circle',
    ) as NodeListOf<HTMLDivElement>;
    let changed = false;

    const newPositions = { ...previousPositions };
    const seen = new Set<string>();

    for (const elem of normalPortElements) {
      const portId = elem.dataset.portid! as PortId;
      const nodeId = elem.dataset.nodeid! as NodeId;
      const portType = elem.dataset.porttype! as 'input' | 'output';
      const key = `${nodeId}-${portType}-${portId}`;

      if (seen.has(key)) {
        continue;
      }

      // For most nodes we can grab the harcoded position from the node data for the root position of the node
      const node = nodesById[nodeId];

      if (!node) {
        continue;
      }

      const nodePos = { x: node.visualData.x, y: node.visualData.y };

      // Then we add the port's offset position from the node
      const positionFromNode = { left: elem.offsetLeft, top: elem.offsetTop };
      let elemParent = elem.offsetParent as HTMLElement | undefined;

      while (!elemParent?.classList.contains('node')) {
        positionFromNode.left += elemParent?.offsetLeft ?? 0;
        positionFromNode.top += elemParent?.offsetTop ?? 0;
        elemParent = elemParent?.offsetParent as HTMLElement | undefined;
      }

      const precision = 10;

      const pos = {
        x: Math.round((nodePos.x + positionFromNode.left + elem.offsetWidth / 2) * precision) / precision,
        y: Math.round((nodePos.y + positionFromNode.top + elem.offsetHeight / 2) * precision) / precision,
      };

      const prevPos = previousPositions[key];

      if (prevPos?.x !== pos.x || prevPos?.y !== pos.y) {
        changed = true;
        newPositions[key] = pos;
      }

      seen.add(key);
    }

    // Fixes a rendering issue where when you drag a node, for one frame the node.visualData.x and node.visualData.y have been updated
    // to the new position, but the overlay is still active moving the node by the same amount, which causes the wires to flicker
    // as for one frame they move double the distance.
    if (isDraggingNode) {
      const overlayPortElements = canvasRef.current?.querySelectorAll(
        '.overlayNode .port-circle',
      ) as NodeListOf<HTMLDivElement>;

      for (const elem of overlayPortElements) {
        const nodeElem = elem.closest('.node') as HTMLElement;

        const portId = elem.dataset.portid! as PortId;
        const nodeId = elem.dataset.nodeid! as NodeId;
        const portType = elem.dataset.porttype! as 'input' | 'output';
        const key = `${nodeId}-${portType}-${portId}`;

        if (seen.has(key)) {
          continue;
        }

        const node = nodesById[nodeId];

        if (!node) {
          continue;
        }

        const nodePos = { x: node.visualData.x, y: node.visualData.y };

        // For the overlay nodes, they have an additional transform on the parent element, so we need to account for that
        const overlayPositionedElement = nodeElem.offsetParent as HTMLDivElement;
        const translate3dRegexMatch = overlayPositionedElement?.style.transform?.match(
          /translate3d\((?:([\d.-]+)(?:px?)), *(?:([\d.-]+)(?:px?)), *(?:([\d.-]+)(?:px?))?\)/,
        );
        const [, x, y] = translate3dRegexMatch ?? [];

        if (x && y) {
          nodePos.x += parseFloat(x || '0');
          nodePos.y += parseFloat(y || '0');
        }

        const positionFromNode = { left: elem.offsetLeft, top: elem.offsetTop };
        let elemParent = elem.offsetParent as HTMLElement | undefined;

        while (!elemParent?.classList.contains('node')) {
          positionFromNode.left += elemParent?.offsetLeft ?? 0;
          positionFromNode.top += elemParent?.offsetTop ?? 0;
          elemParent = elemParent?.offsetParent as HTMLElement | undefined;
        }

        const precision = 10;

        const pos = {
          x: Math.round((nodePos.x + positionFromNode.left + elem.offsetWidth / 2) * precision) / precision,
          y: Math.round((nodePos.y + positionFromNode.top + elem.offsetHeight / 2) * precision) / precision,
        };

        const prevPos = previousPositions[key];

        if (prevPos?.x !== pos.x || prevPos?.y !== pos.y) {
          changed = true;
          newPositions[key] = pos;
        }
      }
    }

    if (changed) {
      nodePortPositionsRef.current = newPositions;
      setNodePortPositions(newPositions);
    }
  }, [enabled, isDraggingNode, nodesById]);

  const scheduleRecalculate = useCallback(() => {
    if (!enabled || scheduledRecalculateAnimationFrameRef.current !== undefined) {
      return;
    }

    scheduledRecalculateAnimationFrameRef.current = window.requestAnimationFrame(() => {
      scheduledRecalculateAnimationFrameRef.current = undefined;
      recalculate();
    });
  }, [enabled, recalculate]);

  useLayoutEffect(() => {
    // Port positions are in canvas space, so viewport pan/zoom should not force a fresh DOM-measure pass.
    // We do need to remeasure when the rendered node set changes, because visibility culling mounts and unmounts ports.
    recalculate();
  }, [recalculate, visibleNodeIdSet]);

  useLayoutEffect(() => {
    if (!enabled || !canvasRef.current) {
      return;
    }

    const canvasElement = canvasRef.current;
    const resizeObserver = new ResizeObserver(() => {
      scheduleRecalculate();
    });

    const refreshObservedPortLayoutElements = () => {
      for (const element of observedPortLayoutElementsRef.current) {
        resizeObserver.unobserve(element);
      }

      observedPortLayoutElementsRef.current = Array.from(
        canvasElement.querySelectorAll(OBSERVED_PORT_LAYOUT_SELECTOR),
      ) as HTMLElement[];

      for (const element of observedPortLayoutElementsRef.current) {
        resizeObserver.observe(element);
      }
    };

    refreshObservedPortLayoutElements();

    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target instanceof HTMLElement && isPortLayoutMutationElement(mutation.target)) {
          refreshObservedPortLayoutElements();
          scheduleRecalculate();
          return;
        }

        for (const addedNode of mutation.addedNodes) {
          if (addedNode instanceof HTMLElement && isPortLayoutMutationElement(addedNode)) {
            refreshObservedPortLayoutElements();
            scheduleRecalculate();
            return;
          }
        }

        for (const removedNode of mutation.removedNodes) {
          if (removedNode instanceof HTMLElement && isPortLayoutMutationElement(removedNode)) {
            refreshObservedPortLayoutElements();
            scheduleRecalculate();
            return;
          }
        }
      }
    });

    mutationObserver.observe(canvasElement, {
      attributes: true,
      attributeFilter: OBSERVED_PORT_LAYOUT_ATTRIBUTE_FILTER,
      childList: true,
      subtree: true,
    });

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      observedPortLayoutElementsRef.current = [];

      if (scheduledRecalculateAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scheduledRecalculateAnimationFrameRef.current);
        scheduledRecalculateAnimationFrameRef.current = undefined;
      }
    };
  }, [enabled, scheduleRecalculate]);

  useLayoutEffect(() => {
    const shouldMeasureLive = isDraggingNode || isDraggingWire;

    if (!enabled || !shouldMeasureLive) {
      return;
    }

    let cancelled = false;

    // Node drags use overlay transforms that do not change node data, and wire drags can
    // reveal newly visible targets via auto-scroll. Keep port measurements live until the
    // interaction ends so wire endpoints never fall back to stale coordinates.
    const tick = () => {
      recalculate();

      if (!cancelled) {
        liveMeasurementAnimationFrameRef.current = window.requestAnimationFrame(tick);
      }
    };

    tick();

    return () => {
      cancelled = true;

      if (liveMeasurementAnimationFrameRef.current !== undefined) {
        window.cancelAnimationFrame(liveMeasurementAnimationFrameRef.current);
        liveMeasurementAnimationFrameRef.current = undefined;
      }
    };
  }, [enabled, isDraggingNode, isDraggingWire, recalculate]);

  useLayoutEffect(() => {
    nodePortPositionsRef.current = nodePortPositions;
  }, [nodePortPositions]);

  return { nodePortPositions, canvasRef, recalculate };
}
