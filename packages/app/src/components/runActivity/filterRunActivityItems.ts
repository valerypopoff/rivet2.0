import type { RunActivityFilter, RunActivityItemViewModel } from './types.js';

/** Filters the bounded metadata projection without reading result previews or full values. */
export function filterRunActivityItems(
  items: readonly RunActivityItemViewModel[],
  options: { filter: RunActivityFilter; graphId: string; query: string },
): RunActivityItemViewModel[] {
  const queryTerms = normalizeSearchText(options.query).split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      if (options.filter === 'llm-tools' && item.category !== 'model' && item.category !== 'tool') return false;
      if (options.filter === 'errors' && !isErrorActivity(item)) return false;
      if (options.graphId && item.graphId !== options.graphId) return false;
      if (queryTerms.length === 0) return true;
      const searchableText = getSearchableMetadata(item).map(normalizeSearchText).join('\n');
      return queryTerms.every((term) => searchableText.includes(term));
    })
    .sort((left, right) => left.sequence - right.sequence);
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function getSearchableMetadata(item: RunActivityItemViewModel): string[] {
  return [
    item.graphName,
    item.nodeTitle,
    item.nodeType,
    item.provider,
    item.model,
    item.toolName,
    item.error,
    ...(item.searchTerms ?? []),
  ].filter((value): value is string => Boolean(value));
}

function isErrorActivity(item: RunActivityItemViewModel): boolean {
  return (
    item.category === 'error' || item.status === 'error' || item.status === 'interrupted' || item.hasErrors === true
  );
}
