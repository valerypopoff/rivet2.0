import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { RivetKnowledgeDocument } from '../../integrations/KnowledgeStore.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { DataValue } from '../DataValue.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  normalizeKnowledgeDocument,
  normalizeKnowledgeMetadata,
  normalizeKnowledgeSourceReference,
  normalizeSyncKnowledgeSourceResult,
} from '../../integrations/KnowledgeStoreValidation.js';

export type SyncKnowledgeSourceNode = ChartNode<'syncKnowledgeSource', SyncKnowledgeSourceNodeData>;

export type SyncKnowledgeSourceNodeData = {
  metadata: Record<string, unknown>;
  useMetadataInput: boolean;
  forceRefresh: boolean;
  useForceRefreshInput: boolean;
  chunkUnit: 'characters' | 'tokens';
  targetSize: number;
  overlap: number;
  minimumBoundarySize: number;
  includeTitle: boolean;
};

export class SyncKnowledgeSourceNodeImpl extends NodeImpl<SyncKnowledgeSourceNode> {
  static create(): SyncKnowledgeSourceNode {
    return {
      id: nanoid() as NodeId,
      type: 'syncKnowledgeSource',
      title: 'Sync Knowledge Source',
      visualData: { x: 0, y: 0, width: 290 },
      data: {
        metadata: {},
        useMetadataInput: false,
        forceRefresh: false,
        useForceRefreshInput: false,
        chunkUnit: 'characters',
        targetSize: 2600,
        overlap: 260,
        minimumBoundarySize: 1400,
        includeTitle: true,
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      { id: 'source' as PortId, title: 'Source', dataType: 'knowledge-source', required: true },
      {
        id: 'documents' as PortId,
        title: 'Documents',
        dataType: ['string', 'string[]', 'knowledge-document', 'knowledge-document[]'],
        required: true,
      },
    ];
    if (this.data.useMetadataInput)
      inputs.push({ id: 'metadata' as PortId, title: 'Source Metadata', dataType: 'object' });
    if (this.data.useForceRefreshInput)
      inputs.push({ id: 'force-refresh' as PortId, title: 'Force Refresh', dataType: 'boolean' });
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'source' as PortId, title: 'Resolved Source', dataType: 'knowledge-source' },
      { id: 'result' as PortId, title: 'Result', dataType: 'string' },
      { id: 'document-count' as PortId, title: 'Document Count', dataType: 'number' },
      { id: 'chunk-count' as PortId, title: 'Chunk Count', dataType: 'number' },
      { id: 'previous-version' as PortId, title: 'Previous Version', dataType: 'string' },
      { id: 'warnings' as PortId, title: 'Warnings', dataType: 'string[]' },
    ];
  }

  getEditors(): EditorDefinition<SyncKnowledgeSourceNode>[] {
    return [
      {
        type: 'jsonObject',
        dataKey: 'metadata',
        useInputToggleDataKey: 'useMetadataInput',
        label: 'Source Metadata',
        helperMessage: 'Enter a flat JSON object, or leave {} when the source has no metadata.',
      },
      {
        type: 'toggle',
        dataKey: 'forceRefresh',
        useInputToggleDataKey: 'useForceRefreshInput',
        label: 'Force Refresh',
      },
      {
        type: 'dropdown',
        dataKey: 'chunkUnit',
        label: 'Chunk Size Unit',
        options: [
          { value: 'characters', label: 'Characters' },
          { value: 'tokens', label: 'Tokens' },
        ],
      },
      { type: 'number', dataKey: 'targetSize', label: 'Target Chunk Size', min: 100, max: 100000 },
      { type: 'number', dataKey: 'overlap', label: 'Chunk Overlap', min: 0, max: 99999 },
      { type: 'number', dataKey: 'minimumBoundarySize', label: 'Minimum Boundary Size', min: 1, max: 100000 },
      { type: 'toggle', dataKey: 'includeTitle', label: 'Include Title In Indexed Text' },
    ];
  }

  getBody(): string {
    return dedent`
      ${this.data.targetSize} ${this.data.chunkUnit}
      ${this.data.overlap} overlap
      ${this.data.includeTitle ? 'Includes titles' : 'Content only'}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Sync Knowledge Source',
      infoBoxTitle: 'Sync Knowledge Source Node',
      infoBoxBody: 'Idempotently chunks and activates a complete immutable version of a knowledge source.',
      group: 'Knowledge',
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const source = normalizeKnowledgeSourceReference(coerceType(inputs['source' as PortId], 'knowledge-source'));
    const documents = normalizeDocumentsInput(inputs['documents' as PortId]);
    const metadataRaw = this.data.useMetadataInput
      ? coerceType(inputs['metadata' as PortId], 'object')
      : this.data.metadata;
    const metadata = normalizeKnowledgeMetadata(metadataRaw, 'Source metadata');
    const forceRefresh = this.data.useForceRefreshInput
      ? coerceType(inputs['force-refresh' as PortId], 'boolean')
      : this.data.forceRefresh;
    const store = await context.getKnowledgeStore(source.connectionId);
    const result = normalizeSyncKnowledgeSourceResult(
      await store.syncSource(
        {
          source,
          documents,
          metadata,
          forceRefresh,
          chunking: {
            unit: this.data.chunkUnit,
            targetSize: this.data.targetSize,
            overlap: this.data.overlap,
            minimumBoundarySize: this.data.minimumBoundarySize,
            includeTitle: this.data.includeTitle,
          },
        },
        {
          signal: context.signal,
          reportProgress: context.reportProgress,
          getTokenCount: (text) => context.tokenizer.getTokenCountForString(text, { node: context.node }),
        },
      ),
      source,
    );

    return {
      ['source' as PortId]: { type: 'knowledge-source', value: result.source },
      ['result' as PortId]: { type: 'string', value: result.result },
      ['document-count' as PortId]: { type: 'number', value: result.documentCount },
      ['chunk-count' as PortId]: { type: 'number', value: result.chunkCount },
      ['previous-version' as PortId]: { type: 'string', value: result.previousVersion ?? '' },
      ['warnings' as PortId]: { type: 'string[]', value: result.warnings },
    };
  }
}

function normalizeDocumentsInput(value: DataValue | undefined): RivetKnowledgeDocument[] {
  if (!value) throw new Error('Sync Knowledge Source is missing its Documents input.');
  if (value.type === 'string') return [normalizeKnowledgeDocument(value.value, 0)];
  if (value.type === 'string[]')
    return value.value.map((document, index) => normalizeKnowledgeDocument(document, index));
  if (value.type === 'knowledge-document') return [normalizeKnowledgeDocument(value.value, 0)];
  if (value.type === 'knowledge-document[]')
    return value.value.map((document, index) => normalizeKnowledgeDocument(document, index));
  throw new Error(`Sync Knowledge Source cannot use ${value.type} as Documents.`);
}

export const syncKnowledgeSourceNode = nodeDefinition(SyncKnowledgeSourceNodeImpl, 'Sync Knowledge Source');
