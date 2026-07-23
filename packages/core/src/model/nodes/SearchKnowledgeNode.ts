import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  normalizeKnowledgeFilter,
  normalizeKnowledgeQueries,
  normalizeSearchKnowledgeSourceResult,
  normalizeKnowledgeSourceReference,
} from '../../integrations/KnowledgeStoreValidation.js';

export type SearchKnowledgeNode = ChartNode<'searchKnowledge', SearchKnowledgeNodeData>;

export type SearchKnowledgeNodeData = {
  filter: Record<string, unknown>;
  useFilterInput: boolean;
  topK: number;
  maxConcurrency: number;
  finalResultCount: number;
  rerankMode: 'off' | 'connection-default' | 'required';
  rerankTopN: number;
};

export class SearchKnowledgeNodeImpl extends NodeImpl<SearchKnowledgeNode> {
  static create(): SearchKnowledgeNode {
    return {
      id: nanoid() as NodeId,
      type: 'searchKnowledge',
      title: 'Search Knowledge',
      visualData: { x: 0, y: 0, width: 270 },
      data: {
        filter: {},
        useFilterInput: false,
        topK: 10,
        maxConcurrency: 3,
        finalResultCount: 10,
        rerankMode: 'off',
        rerankTopN: 7,
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      { id: 'source' as PortId, title: 'Source', dataType: 'knowledge-source', required: true },
      { id: 'query' as PortId, title: 'Query', dataType: ['string', 'string[]'], required: true },
    ];
    if (this.data.useFilterInput) inputs.push({ id: 'filter' as PortId, title: 'Metadata Filter', dataType: 'object' });
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'evidence' as PortId, title: 'Evidence', dataType: 'knowledge-evidence[]' },
      { id: 'source' as PortId, title: 'Resolved Source', dataType: 'knowledge-source' },
      { id: 'source-found' as PortId, title: 'Source Found', dataType: 'boolean' },
      { id: 'query-results' as PortId, title: 'Query Results', dataType: 'object[]' },
      { id: 'message' as PortId, title: 'Status Message', dataType: 'string' },
    ];
  }

  getEditors(): EditorDefinition<SearchKnowledgeNode>[] {
    return [
      {
        type: 'jsonObject',
        dataKey: 'filter',
        useInputToggleDataKey: 'useFilterInput',
        label: 'Metadata Filter',
        helperMessage: 'Enter a JSON filter expression, or leave {} to search without a metadata filter.',
      },
      { type: 'number', dataKey: 'topK', label: 'Results Per Query', min: 1, max: 100 },
      { type: 'number', dataKey: 'maxConcurrency', label: 'Query Concurrency', min: 1, max: 32 },
      { type: 'number', dataKey: 'finalResultCount', label: 'Final Result Count', min: 1, max: 500 },
      {
        type: 'dropdown',
        dataKey: 'rerankMode',
        label: 'Provider Reranking',
        options: [
          { value: 'off', label: 'Off' },
          { value: 'connection-default', label: 'Connection Default' },
          { value: 'required', label: 'Required' },
        ],
      },
      {
        type: 'number',
        dataKey: 'rerankTopN',
        label: 'Rerank Result Count',
        min: 1,
        max: 100,
        hideIf: (data) => data.rerankMode === 'off',
      },
    ];
  }

  getBody(): string {
    return dedent`
      ${this.data.topK} per query -> ${this.data.finalResultCount} final
      Reranking: ${this.data.rerankMode}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Search Knowledge',
      infoBoxTitle: 'Search Knowledge Node',
      infoBoxBody: 'Searches the active durable source version and returns normalized, deduplicated evidence.',
      group: 'Knowledge',
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const source = normalizeKnowledgeSourceReference(coerceType(inputs['source' as PortId], 'knowledge-source'));
    const queryInput = inputs['query' as PortId];
    const queries = normalizeKnowledgeQueries(
      queryInput?.type === 'string[]'
        ? queryInput.value
        : queryInput?.type === 'any' && Array.isArray(queryInput.value)
          ? queryInput.value
          : [coerceType(queryInput, 'string')],
    );
    const rawFilter = this.data.useFilterInput ? coerceType(inputs['filter' as PortId], 'object') : this.data.filter;
    const filter = Object.keys(rawFilter).length ? normalizeKnowledgeFilter(rawFilter) : undefined;
    const rerank =
      this.data.rerankMode === 'off'
        ? undefined
        : ({ mode: this.data.rerankMode, topN: this.data.rerankTopN } as const);
    const store = await context.getKnowledgeStore(source.connectionId);
    const result = normalizeSearchKnowledgeSourceResult(
      await store.search(
        {
          source,
          queries,
          topK: this.data.topK,
          maxConcurrency: this.data.maxConcurrency,
          finalResultCount: this.data.finalResultCount,
          filter,
          rerank,
        },
        { signal: context.signal, reportProgress: context.reportProgress },
      ),
      source,
      queries,
    );
    return {
      ['evidence' as PortId]: { type: 'knowledge-evidence[]', value: result.evidence },
      ['source' as PortId]: { type: 'knowledge-source', value: result.source },
      ['source-found' as PortId]: { type: 'boolean', value: result.sourceFound },
      ['query-results' as PortId]: {
        type: 'object[]',
        value: result.queryResults.map((queryResult) => ({
          query: queryResult.query,
          evidence: queryResult.evidence,
        })),
      },
      ['message' as PortId]: { type: 'string', value: result.message },
    };
  }
}

export const searchKnowledgeNode = nodeDefinition(SearchKnowledgeNodeImpl, 'Search Knowledge');
