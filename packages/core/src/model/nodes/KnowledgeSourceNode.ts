import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  normalizeKnowledgeConnectionId,
  normalizeKnowledgeSourceId,
  normalizeKnowledgeSourceReference,
} from '../../integrations/KnowledgeStoreValidation.js';

export type KnowledgeSourceNode = ChartNode<'knowledgeSource', KnowledgeSourceNodeData>;

export type KnowledgeSourceNodeData = {
  connectionId: string;
  useConnectionIdInput: boolean;
  sourceId: string;
  useSourceIdInput: boolean;
  version: string;
  useVersionInput: boolean;
};

export class KnowledgeSourceNodeImpl extends NodeImpl<KnowledgeSourceNode> {
  static create(): KnowledgeSourceNode {
    return {
      id: nanoid() as NodeId,
      type: 'knowledgeSource',
      title: 'Knowledge Source',
      visualData: { x: 0, y: 0, width: 250 },
      data: {
        connectionId: '',
        useConnectionIdInput: false,
        sourceId: '',
        useSourceIdInput: true,
        version: '',
        useVersionInput: false,
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    if (this.data.useConnectionIdInput) {
      inputs.push({ id: 'connection-id' as PortId, title: 'Connection ID', dataType: 'string', required: true });
    }
    if (this.data.useSourceIdInput) {
      inputs.push({ id: 'source-id' as PortId, title: 'Source ID', dataType: 'string', required: true });
    }
    if (this.data.useVersionInput) {
      inputs.push({ id: 'version' as PortId, title: 'Exact Version', dataType: 'string', required: false });
    }
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'source' as PortId, title: 'Source', dataType: 'knowledge-source' }];
  }

  getEditors(): EditorDefinition<KnowledgeSourceNode>[] {
    return [
      {
        type: 'custom',
        customEditorId: 'KnowledgeStoreSelector',
        dataKey: 'connectionId',
        useInputToggleDataKey: 'useConnectionIdInput',
        label: 'Knowledge Store',
        includeInGraphSearch: true,
      },
      {
        type: 'string',
        dataKey: 'sourceId',
        useInputToggleDataKey: 'useSourceIdInput',
        label: 'Source ID',
        includeInGraphSearch: true,
      },
      {
        type: 'string',
        dataKey: 'version',
        useInputToggleDataKey: 'useVersionInput',
        label: 'Exact Version',
        helperMessage: 'Leave blank to resolve the active committed version when the source is used.',
      },
    ];
  }

  getBody(context: RivetUIContext): string {
    const connection = context.project.metadata.knowledgeStores?.[this.data.connectionId];
    return dedent`
      Store: ${this.data.useConnectionIdInput ? '(from input)' : (connection?.displayName ?? this.data.connectionId) || '(not selected)'}
      Source: ${this.data.useSourceIdInput ? '(from input)' : this.data.sourceId || '(not set)'}
      ${this.data.useVersionInput || this.data.version ? 'Exact version configured' : 'Uses active version'}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Knowledge Source',
      infoBoxTitle: 'Knowledge Source Node',
      infoBoxBody: 'Creates a portable reference to one logical source in a named project knowledge store.',
      group: 'Knowledge',
    };
  }

  async process(inputs: Inputs, _context: InternalProcessContext): Promise<Outputs> {
    const connectionId = normalizeKnowledgeConnectionId(
      this.data.useConnectionIdInput ? coerceType(inputs['connection-id' as PortId], 'string') : this.data.connectionId,
    );
    const sourceId = normalizeKnowledgeSourceId(
      this.data.useSourceIdInput ? coerceType(inputs['source-id' as PortId], 'string') : this.data.sourceId,
    );
    const version = (
      this.data.useVersionInput ? coerceType(inputs['version' as PortId], 'string') : this.data.version
    ).trim();
    return {
      ['source' as PortId]: {
        type: 'knowledge-source',
        value: normalizeKnowledgeSourceReference({ connectionId, sourceId, ...(version ? { version } : {}) }),
      },
    };
  }
}

export const knowledgeSourceNode = nodeDefinition(KnowledgeSourceNodeImpl, 'Knowledge Source');
