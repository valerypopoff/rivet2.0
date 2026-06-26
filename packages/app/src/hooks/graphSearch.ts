import type { ChartNode, GraphId, NodeGraph, NodeId } from '@valerypopoff/rivet2-core';

export const NODE_LIBRARY_GRAPH_SEARCH_ID = '__node-library__' as GraphId;

const MAX_SERIALIZED_CHARS = 12_000;
const MAX_SERIALIZED_DEPTH = 5;
const MAX_CONTAINER_ENTRIES = 50;
const CONTENT_SNIPPET_CONTEXT_CHARS = 90;
const MAX_CONTENT_SNIPPETS = 5;

export type GraphSearchItem = {
  kind: 'graph' | 'node';
  nodeId?: NodeId;
  graphId: GraphId;
  graphName: string;
  title: string;
  nodeType: string;
  joinedData: string;
  fields: GraphSearchField[];
};

export type GraphSearchNodeMetadata = {
  nodeTypeLabel?: string;
  searchableContentKeys?: readonly string[];
};

type SearchableEditorDefinition = {
  type: string;
  dataKey?: string;
  includeInGraphSearch?: boolean;
  editors?: SearchableEditorDefinition[];
};

export type GraphSearchMatchLocation =
  | 'graph name'
  | 'node name'
  | 'node id'
  | 'node description'
  | 'node type'
  | 'node content';

type GraphSearchField = {
  location: GraphSearchMatchLocation;
  normalizedText: string;
  minQueryLength?: number;
};

export type GraphSearchGraphMatch = {
  kind: 'graph';
  graphId: GraphId;
  graphName: string;
  locations: GraphSearchMatchLocation[];
  contentSnippets: string[];
  occurrenceCount: number;
};

export type GraphSearchNodeMatch = {
  kind: 'node';
  nodeId: NodeId;
  graphId: GraphId;
  graphName: string;
  nodeTitle: string;
  nodeType: string;
  locations: GraphSearchMatchLocation[];
  contentSnippets: string[];
  occurrenceCount: number;
};

export type GraphSearchMatch = GraphSearchGraphMatch | GraphSearchNodeMatch;

export type GraphSearchResult = {
  matches: GraphSearchMatch[];
  fallbackToTerms: boolean;
};

export type GraphSearchStats = {
  occurrenceCount: number;
  graphCount: number;
};

export type GroupedGraphSearchMatches = {
  key: string;
  graphId: GraphId;
  graphName: string;
  matches: Array<{
    match: GraphSearchNodeMatch;
    index: number;
  }>;
};

export function buildProjectGraphSearchItems(
  graphs: Record<GraphId, NodeGraph>,
  getNodeMetadata: (node: ChartNode) => string | undefined | GraphSearchNodeMetadata,
): GraphSearchItem[] {
  return getUniqueGraphEntriesById(graphs).flatMap(({ graph, graphId }) =>
    buildGraphSearchItems(graph, getNodeMetadata, graphId),
  );
}

export function buildGraphSearchItems(
  graph: NodeGraph,
  getNodeMetadata: (node: ChartNode) => string | undefined | GraphSearchNodeMetadata,
  fallbackGraphId?: GraphId,
): GraphSearchItem[] {
  const graphId = graph.metadata?.id ?? fallbackGraphId ?? ('' as GraphId);
  const graphName = graph.metadata?.name?.trim() || 'Unknown Graph';
  const normalizedGraphName = normalizeSearchText(graphName);

  const graphItem: GraphSearchItem = {
    kind: 'graph',
    graphId,
    graphName,
    title: graphName,
    nodeType: '',
    joinedData: '',
    fields: [
      {
        location: 'graph name',
        normalizedText: normalizedGraphName,
      },
    ],
  };

  const nodeItems = graph.nodes.map((node) => {
    const metadata = normalizeGraphSearchNodeMetadata(getNodeMetadata(node));
    const joinedData = serializeSearchableContentFields(node.data, metadata.searchableContentKeys);
    const title = node.title ?? '';
    const description = node.description ?? '';
    const nodeType = metadata.nodeTypeLabel ?? node.type;

    const fields: GraphSearchField[] = [
      {
        location: 'node name',
        normalizedText: normalizeSearchText(title),
      },
      {
        location: 'node id',
        normalizedText: normalizeSearchText(node.id),
        minQueryLength: 6,
      },
      {
        location: 'node description',
        normalizedText: normalizeSearchText(description),
      },
      {
        location: 'node type',
        normalizedText: normalizeSearchText(nodeType),
      },
      {
        location: 'node content',
        normalizedText: normalizeSearchText(joinedData),
      },
    ];

    return {
      kind: 'node' as const,
      nodeId: node.id,
      graphId,
      graphName,
      title,
      nodeType,
      joinedData,
      fields,
    };
  });

  return [graphItem, ...nodeItems];
}

export function searchGraphNodes(items: readonly GraphSearchItem[], query: string): GraphSearchMatch[] {
  return searchGraphNodesWithMode(items, query).matches;
}

export function searchGraphNodesWithMode(items: readonly GraphSearchItem[], query: string): GraphSearchResult {
  const wholeQuery = normalizeSearchText(query).trim();
  const queryTerms = wholeQuery.split(/\s+/).filter(Boolean);

  if (queryTerms.length === 0) {
    return { matches: [], fallbackToTerms: false };
  }

  const exactMatches = findGraphSearchMatches(
    items,
    [wholeQuery],
    (item) => item.fields.some((field) => doesSearchFieldMatch(field, wholeQuery)),
    getFieldTermsForSnippets,
  );

  if (exactMatches.length > 0) {
    return { matches: exactMatches, fallbackToTerms: false };
  }

  return {
    matches: findGraphSearchMatches(
      items,
      queryTerms,
      (item) => queryTerms.every((term) => item.fields.some((field) => doesSearchFieldMatch(field, term))),
      getFieldTermsForSnippets,
    ),
    fallbackToTerms: queryTerms.length > 1,
  };
}

export function groupGraphSearchMatches(matches: readonly GraphSearchMatch[]): GroupedGraphSearchMatches[] {
  const groups: GroupedGraphSearchMatches[] = [];
  const groupIndexes = new Map<string, number>();

  matches.forEach((match, index) => {
    const key = match.graphId;
    let groupIndex = groupIndexes.get(key);

    if (groupIndex == null) {
      groupIndex = groups.length;
      groupIndexes.set(key, groupIndex);
      groups.push({
        key,
        graphId: match.graphId,
        graphName: match.graphName,
        matches: [],
      });
    }

    const group = groups[groupIndex]!;

    if (match.kind === 'node') {
      group.matches.push({ match, index });
    }
  });

  return groups;
}

export function getGraphSearchStats(matches: readonly GraphSearchMatch[]): GraphSearchStats {
  const graphIds = new Set<GraphId>();
  let occurrenceCount = 0;

  for (const match of matches) {
    graphIds.add(match.graphId);
    occurrenceCount += match.occurrenceCount;
  }

  return {
    occurrenceCount,
    graphCount: graphIds.size,
  };
}

export function formatGraphSearchStats(stats: GraphSearchStats): string {
  const occurrenceLabel = stats.occurrenceCount === 1 ? 'occurrence' : 'occurrences';
  const graphLabel = stats.graphCount === 1 ? 'graph' : 'graphs';

  return `${stats.occurrenceCount.toLocaleString()} ${occurrenceLabel} in ${stats.graphCount.toLocaleString()} ${graphLabel}`;
}

export function isNodeGraphSearchMatch(match: GraphSearchMatch): match is GraphSearchNodeMatch {
  return match.kind === 'node';
}

export function serializeGraphSearchValue(value: unknown): string {
  const seen = new WeakSet<object>();

  const serialized = serializeValue(value, {
    depth: 0,
    seen,
  });

  return serialized.length > MAX_SERIALIZED_CHARS
    ? `${serialized.slice(0, MAX_SERIALIZED_CHARS).trimEnd()} ...`
    : serialized;
}

export function serializeSearchableContentFields(
  value: unknown,
  searchableContentKeys: readonly string[] | undefined,
): string {
  if (!value || typeof value !== 'object' || !searchableContentKeys || searchableContentKeys.length === 0) {
    return '';
  }

  const contentParts: string[] = [];
  const valueRecord = value as Record<string, unknown>;

  for (const key of searchableContentKeys) {
    if (!Object.prototype.hasOwnProperty.call(valueRecord, key)) {
      continue;
    }

    const serializedValue = serializeGraphSearchValue(valueRecord[key]).trim();

    if (serializedValue.length > 0) {
      contentParts.push(serializedValue);
    }
  }

  return contentParts.join('\n\n');
}

export function getSynchronousSearchableEditorDataKeys(loadEditors: () => unknown): string[] {
  let editors: unknown;

  try {
    editors = loadEditors();
  } catch {
    return [];
  }

  if (isPromiseLike(editors)) {
    // Graph search only indexes synchronous editor metadata; async editor loaders need the inspector UI context.
    void Promise.resolve(editors).catch(() => undefined);
    return [];
  }

  return Array.isArray(editors) ? getSearchableEditorDataKeys(editors as SearchableEditorDefinition[]) : [];
}

export function getGraphSearchContentSnippets(content: string, queryTerms: readonly string[]): string[] {
  const terms = queryTerms.map((term) => normalizeSearchText(term)).filter(Boolean);

  if (terms.length === 0 || content.length === 0) {
    return [];
  }

  const normalizedContent = normalizeSearchText(content);
  const matchRanges = getSearchTermRanges(normalizedContent, terms);

  if (matchRanges.length === 0) {
    return [];
  }

  const expandedRanges = matchRanges.map((range) => ({
    start: Math.max(0, range.start - CONTENT_SNIPPET_CONTEXT_CHARS),
    end: Math.min(content.length, range.end + CONTENT_SNIPPET_CONTEXT_CHARS),
  }));

  return mergeRanges(expandedRanges)
    .slice(0, MAX_CONTENT_SNIPPETS)
    .map((range) => formatContentSnippet(content, range));
}

export function clampGraphSearchSelectedIndex(selectedIndex: number, matchCount: number): number {
  if (matchCount <= 0) {
    return 0;
  }

  return Math.min(Math.max(selectedIndex, 0), matchCount - 1);
}

function serializeValue(
  value: unknown,
  state: {
    depth: number;
    seen: WeakSet<object>;
  },
): string {
  if (value == null) {
    return String(value);
  }

  if (typeof value === 'string') {
    return value.length > MAX_SERIALIZED_CHARS ? `${value.slice(0, MAX_SERIALIZED_CHARS).trimEnd()} ...` : value;
  }

  const valueType = typeof value;

  if (valueType === 'number' || valueType === 'boolean' || valueType === 'bigint') {
    return String(value);
  }

  if (valueType === 'symbol') {
    return String(value);
  }

  if (valueType === 'function') {
    const functionName = (value as { name?: string }).name;
    return `[Function ${functionName || 'anonymous'}]`;
  }

  if (state.depth >= MAX_SERIALIZED_DEPTH) {
    return '[MaxDepth]';
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (typeof value === 'object') {
    if (state.seen.has(value)) {
      return '[Circular]';
    }

    state.seen.add(value);

    try {
      if (Array.isArray(value)) {
        let items: string[];

        try {
          items = value
            .slice(0, MAX_CONTAINER_ENTRIES)
            .map((item) => serializeValue(item, { depth: state.depth + 1, seen: state.seen }));
        } catch {
          return '[Unserializable Array]';
        }

        if (value.length > MAX_CONTAINER_ENTRIES) {
          items.push('...');
        }

        return `[${items.join(' ')}]`;
      }

      let entries: [string, unknown][];
      let entryCount: number;

      try {
        const allEntries = Object.entries(value);
        entries = allEntries.slice(0, MAX_CONTAINER_ENTRIES);
        entryCount = allEntries.length;
      } catch {
        return '[Unserializable Object]';
      }

      const parts = entries.map(([key, entryValue]) => {
        const serializedEntryValue = serializeValue(entryValue, { depth: state.depth + 1, seen: state.seen });
        return `${key} ${serializedEntryValue}`;
      });

      if (entryCount > MAX_CONTAINER_ENTRIES) {
        parts.push('...');
      }

      return `{${parts.join(' ')}}`;
    } finally {
      state.seen.delete(value);
    }
  }

  return '';
}

function normalizeSearchText(text: string): string {
  return text.toLowerCase();
}

function normalizeGraphSearchNodeMetadata(metadata: string | undefined | GraphSearchNodeMetadata): {
  nodeTypeLabel: string | undefined;
  searchableContentKeys: readonly string[];
} {
  if (typeof metadata === 'string' || metadata == null) {
    return {
      nodeTypeLabel: metadata,
      searchableContentKeys: [],
    };
  }

  return {
    nodeTypeLabel: metadata.nodeTypeLabel,
    searchableContentKeys: metadata.searchableContentKeys ?? [],
  };
}

function getSearchableEditorDataKeys(editors: readonly SearchableEditorDefinition[]): string[] {
  const dataKeys = new Set<string>();

  for (const editor of editors) {
    if ((editor.type === 'code' || editor.includeInGraphSearch) && typeof editor.dataKey === 'string') {
      dataKeys.add(editor.dataKey);
    }

    if (Array.isArray(editor.editors)) {
      getSearchableEditorDataKeys(editor.editors).forEach((dataKey) => dataKeys.add(dataKey));
    }
  }

  return [...dataKeys];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function getMatchLocations(item: GraphSearchItem, queryTerms: readonly string[]): GraphSearchMatchLocation[] {
  const locations: GraphSearchMatchLocation[] = [];

  for (const field of item.fields) {
    if (queryTerms.some((term) => doesSearchFieldMatch(field, term)) && !locations.includes(field.location)) {
      locations.push(field.location);
    }
  }

  return locations.length > 0 ? locations : ['node content'];
}

function findGraphSearchMatches(
  items: readonly GraphSearchItem[],
  queryTerms: readonly string[],
  predicate: (item: GraphSearchItem) => boolean,
  getSnippetTerms: (item: GraphSearchItem, queryTerms: readonly string[]) => string[],
): GraphSearchMatch[] {
  return items.filter(predicate).map((item): GraphSearchMatch => {
    if (item.kind === 'graph') {
      return {
        kind: 'graph',
        graphId: item.graphId,
        graphName: item.graphName,
        locations: ['graph name'],
        contentSnippets: [],
        occurrenceCount: countSearchItemOccurrences(item, queryTerms),
      };
    }

    return {
      kind: 'node',
      nodeId: item.nodeId!,
      graphId: item.graphId,
      graphName: item.graphName,
      nodeTitle: item.title.trim() || item.nodeType,
      nodeType: item.nodeType,
      locations: getMatchLocations(item, queryTerms),
      contentSnippets: getGraphSearchContentSnippets(item.joinedData, getSnippetTerms(item, queryTerms)),
      occurrenceCount: countSearchItemOccurrences(item, queryTerms),
    };
  });
}

function getFieldTermsForSnippets(item: GraphSearchItem, queryTerms: readonly string[]): string[] {
  const contentField = item.fields.find((field) => field.location === 'node content');

  if (!contentField) {
    return [];
  }

  return queryTerms.every((term) => doesSearchFieldMatch(contentField, term)) ? [...queryTerms] : [];
}

function doesSearchFieldMatch(field: GraphSearchField, term: string): boolean {
  return term.length >= (field.minQueryLength ?? 1) && field.normalizedText.includes(term);
}

function countSearchItemOccurrences(item: GraphSearchItem, queryTerms: readonly string[]): number {
  let occurrenceCount = 0;

  for (const field of item.fields) {
    for (const term of queryTerms) {
      occurrenceCount += countSearchFieldOccurrences(field, term);
    }
  }

  return occurrenceCount;
}

function countSearchFieldOccurrences(field: GraphSearchField, term: string): number {
  if (term.length < (field.minQueryLength ?? 1)) {
    return 0;
  }

  let occurrenceCount = 0;
  let startIndex = 0;

  while (startIndex < field.normalizedText.length) {
    const matchIndex = field.normalizedText.indexOf(term, startIndex);

    if (matchIndex === -1) {
      break;
    }

    occurrenceCount += 1;
    startIndex = matchIndex + Math.max(term.length, 1);
  }

  return occurrenceCount;
}

function getSearchTermRanges(content: string, queryTerms: readonly string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const term of queryTerms) {
    let startIndex = 0;

    while (startIndex < content.length) {
      const matchIndex = content.indexOf(term, startIndex);

      if (matchIndex === -1) {
        break;
      }

      ranges.push({
        start: matchIndex,
        end: matchIndex + term.length,
      });
      startIndex = matchIndex + Math.max(term.length, 1);
    }
  }

  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];

    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function formatContentSnippet(content: string, range: { start: number; end: number }): string {
  const prefix = range.start > 0 ? '...' : '';
  const suffix = range.end < content.length ? '...' : '';
  return `${prefix}${content.slice(range.start, range.end).trim()}${suffix}`;
}

function getUniqueGraphEntriesById(graphs: Record<GraphId, NodeGraph>): Array<{ graphId: GraphId; graph: NodeGraph }> {
  const uniqueGraphs = new Map<GraphId, NodeGraph>();

  Object.entries(graphs).forEach(([recordKey, graph]) => {
    uniqueGraphs.set(graph.metadata?.id ?? (recordKey as GraphId), graph);
  });

  return Array.from(uniqueGraphs.entries()).map(([graphId, graph]) => ({ graphId, graph }));
}
