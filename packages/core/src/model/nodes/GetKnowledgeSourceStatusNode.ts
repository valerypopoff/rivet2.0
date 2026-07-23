import { nanoid } from 'nanoid/non-secure';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  normalizeKnowledgeSourceReference,
  normalizeKnowledgeSourceStatusResult,
} from '../../integrations/KnowledgeStoreValidation.js';

export type GetKnowledgeSourceStatusNode = ChartNode<'getKnowledgeSourceStatus', GetKnowledgeSourceStatusNodeData>;

export type GetKnowledgeSourceStatusNodeData = {
  expectedVersion: string;
  useExpectedVersionInput: boolean;
};

export class GetKnowledgeSourceStatusNodeImpl extends NodeImpl<GetKnowledgeSourceStatusNode> {
  static create(): GetKnowledgeSourceStatusNode {
    return {
      id: nanoid() as NodeId,
      type: 'getKnowledgeSourceStatus',
      title: 'Get Knowledge Source Status',
      visualData: { x: 0, y: 0, width: 300 },
      data: { expectedVersion: '', useExpectedVersionInput: false },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [
      { id: 'source' as PortId, title: 'Source', dataType: 'knowledge-source', required: true },
    ];
    if (this.data.useExpectedVersionInput) {
      inputs.push({ id: 'expected-version' as PortId, title: 'Expected Version', dataType: 'string' });
    }
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'source' as PortId, title: 'Resolved Source', dataType: 'knowledge-source' },
      { id: 'exists' as PortId, title: 'Exists', dataType: 'boolean' },
      { id: 'active-version' as PortId, title: 'Active Version', dataType: 'string' },
      { id: 'matches-expected-version' as PortId, title: 'Matches Expected Version', dataType: 'boolean' },
      { id: 'document-count' as PortId, title: 'Document Count', dataType: 'number' },
      { id: 'chunk-count' as PortId, title: 'Chunk Count', dataType: 'number' },
      { id: 'updated-at' as PortId, title: 'Updated At', dataType: 'datetime' },
      { id: 'metadata' as PortId, title: 'Metadata', dataType: 'object' },
      { id: 'message' as PortId, title: 'Status Message', dataType: 'string' },
    ];
  }

  getEditors(): EditorDefinition<GetKnowledgeSourceStatusNode>[] {
    return [
      {
        type: 'string',
        dataKey: 'expectedVersion',
        useInputToggleDataKey: 'useExpectedVersionInput',
        label: 'Expected Version',
      },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Get Knowledge Source Status',
      infoBoxTitle: 'Get Knowledge Source Status Node',
      infoBoxBody: 'Reads the durable active source manifest. A missing source is returned as normal output.',
      group: 'Knowledge',
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const source = normalizeKnowledgeSourceReference(coerceType(inputs['source' as PortId], 'knowledge-source'));
    const expectedVersion = (
      this.data.useExpectedVersionInput
        ? coerceType(inputs['expected-version' as PortId], 'string')
        : this.data.expectedVersion
    ).trim();
    const normalizedExpectedVersion = expectedVersion
      ? normalizeKnowledgeSourceReference({ ...source, version: expectedVersion }).version
      : undefined;
    const store = await context.getKnowledgeStore(source.connectionId);
    const result = normalizeKnowledgeSourceStatusResult(
      await store.getSourceStatus(
        { source, ...(normalizedExpectedVersion ? { expectedVersion: normalizedExpectedVersion } : {}) },
        { signal: context.signal, reportProgress: context.reportProgress },
      ),
      source,
      normalizedExpectedVersion,
    );
    return {
      ['source' as PortId]: { type: 'knowledge-source', value: result.source },
      ['exists' as PortId]: { type: 'boolean', value: result.exists },
      ['active-version' as PortId]: { type: 'string', value: result.activeVersion ?? '' },
      ['matches-expected-version' as PortId]: { type: 'boolean', value: result.matchesExpectedVersion ?? false },
      ['document-count' as PortId]: { type: 'number', value: result.documentCount ?? 0 },
      ['chunk-count' as PortId]: { type: 'number', value: result.chunkCount ?? 0 },
      ['updated-at' as PortId]: { type: 'datetime', value: result.updatedAt ?? '' },
      ['metadata' as PortId]: { type: 'object', value: result.metadata ?? {} },
      ['message' as PortId]: { type: 'string', value: result.message },
    };
  }
}

export const getKnowledgeSourceStatusNode = nodeDefinition(
  GetKnowledgeSourceStatusNodeImpl,
  'Get Knowledge Source Status',
);
