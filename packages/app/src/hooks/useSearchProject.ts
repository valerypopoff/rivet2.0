import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { useFuseSearch } from './useFuseSearch';
import { useNodeTypes } from './useNodeTypes';
import { useDependsOnPlugins } from './useDependsOnPlugins';
import { useProjectNodeRegistry } from './useProjectNodeRegistry';
import { projectState } from '../state/savedGraphs';
import { buildProjectSearchItems, type SearchableItem } from './projectSearchItems.js';

export type { SearchableItem };

export type RangeTuple = [number, number];

export type FuseResultMatch = {
  indices: ReadonlyArray<RangeTuple>;
  key?: string;
  refIndex?: number;
  value?: string;
  score?: number;
};

export type SearchedItem = {
  item: SearchableItem;
  matches: readonly FuseResultMatch[] | undefined;
};

export function useSearchProject(query: string, enabled: boolean): SearchedItem[] {
  const project = useAtomValue(projectState);

  useDependsOnPlugins();

  const nodeTypes = useNodeTypes();
  const projectNodeRegistry = useProjectNodeRegistry();

  const searchableNodes = useMemo(() => {
    return buildProjectSearchItems(project, (node) =>
      node.type in nodeTypes ? projectNodeRegistry.getDynamicDisplayName(node.type) : '',
    );
  }, [nodeTypes, project, projectNodeRegistry]);

  const searchedNodes = useFuseSearch(
    searchableNodes,
    query,
    ['id', 'title', 'description', 'joinedData', 'nodeType'],
    {
      enabled,
      noInputEmptyList: true,
    },
  );

  return searchedNodes.map((node): SearchedItem => {
    return {
      item: node.item,
      matches: node.matches,
    };
  });
}
