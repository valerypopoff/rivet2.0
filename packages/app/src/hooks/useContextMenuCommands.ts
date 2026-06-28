import { useMemo } from 'react';
import { projectGraphInfoState } from '../state/savedGraphs.js';
import { useAtomValue } from 'jotai';
import { type ContextMenuItem } from './useContextMenuConfiguration.js';
import { values } from '../utils/typeSafety';

export function useContextMenuCommands() {
  const projectInfo = useAtomValue(projectGraphInfoState);

  const commands = useMemo(() => {
    const goToGraphCommands = values(projectInfo.graphs).map(
      (graph): ContextMenuItem => ({
        id: `go-to-graph:${graph.id}`,
        label: graph.name || 'Untitled graph',
        searchSection: 'graphs',
        data: graph.id,
      }),
    );

    return [...goToGraphCommands];
  }, [projectInfo]);

  return commands;
}
