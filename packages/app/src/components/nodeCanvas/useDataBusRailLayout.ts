import { useAtomValue, useSetAtom } from 'jotai';
import { type RefObject, useLayoutEffect, useState } from 'react';
import { sidebarOpenState } from '../../state/graphBuilder.js';
import { dataBusFullRowCountState, leftSidebarLiveWidthState } from '../../state/ui.js';
import type { DataBusTopology, RenderableDataBusNode } from './dataBusModel.js';
import { shouldUseDataBusFullRow } from './dataBusRailLayout.js';

function getDataBusGroupContentWidths(rail: HTMLDivElement, uiFontScale: number): number[] {
  return [...rail.querySelectorAll<HTMLElement>('.data-bus-group')].map((group) => {
    const header = group.querySelector<HTMLElement>('.data-bus-group-header');
    const channels = group.querySelector<HTMLElement>('.data-bus-channels');
    const connectProvider = group.querySelector<HTMLElement>('.data-bus-connect-provider');
    const channelWidth = [...(channels?.children ?? [])].reduce(
      (width, channel) => width + (channel as HTMLElement).getBoundingClientRect().width,
      0,
    );

    // Include the accent strip and the two one-pixel borders. These widths are
    // stable in compact and full-row modes, unlike the group's constrained box.
    return 3 * uiFontScale + (header?.scrollWidth ?? 0) + channelWidth + (connectProvider?.scrollWidth ?? 0) + 2;
  });
}

/** Owns DOM measurement and global full-row height publication for one rail. */
export function useDataBusRailLayout(options: {
  busNodes: readonly RenderableDataBusNode[];
  railRef: RefObject<HTMLDivElement | null>;
  topology: DataBusTopology;
}): boolean {
  const [fullRow, setFullRow] = useState(false);
  const setDataBusFullRowCount = useSetAtom(dataBusFullRowCountState);
  const leftSidebarOpen = useAtomValue(sidebarOpenState);
  const leftSidebarLiveWidth = useAtomValue(leftSidebarLiveWidthState);

  useLayoutEffect(() => {
    const rail = options.railRef.current;
    if (!rail || options.busNodes.length === 0) {
      setFullRow(false);
      return;
    }

    const updateLayout = () => {
      const uiFontScale = Number.parseFloat(getComputedStyle(rail).getPropertyValue('--ui-font-scale')) || 1;
      const windowWidth = rail.ownerDocument.defaultView?.innerWidth ?? rail.parentElement?.clientWidth ?? 0;
      const viewportWidth = Math.max(0, windowWidth - (leftSidebarOpen ? leftSidebarLiveWidth : 0));
      const nextFullRow = shouldUseDataBusFullRow({
        groupContentWidths: getDataBusGroupContentWidths(rail, uiFontScale),
        uiFontScale,
        viewportWidth,
      });

      setFullRow((current) => (current === nextFullRow ? current : nextFullRow));
    };

    updateLayout();
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            updateLayout();
          });

    resizeObserver?.observe(rail.parentElement ?? rail);
    resizeObserver?.observe(rail);
    rail
      .querySelectorAll<HTMLElement>('.data-bus-group-header, .data-bus-channel, .data-bus-connect-provider')
      .forEach((element) => resizeObserver?.observe(element));
    const mutationObserver =
      rail.ownerDocument.defaultView?.MutationObserver == null
        ? undefined
        : new rail.ownerDocument.defaultView.MutationObserver(updateLayout);
    mutationObserver?.observe(rail, { childList: true, subtree: true });
    rail.ownerDocument.defaultView?.addEventListener('resize', updateLayout);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      rail.ownerDocument.defaultView?.removeEventListener('resize', updateLayout);
    };
  }, [leftSidebarLiveWidth, leftSidebarOpen, options.busNodes, options.railRef, options.topology]);

  useLayoutEffect(() => {
    setDataBusFullRowCount(fullRow ? options.busNodes.length : 0);
  }, [fullRow, options.busNodes.length, setDataBusFullRowCount]);

  useLayoutEffect(
    () => () => {
      setDataBusFullRowCount(0);
    },
    [setDataBusFullRowCount],
  );

  return fullRow;
}
