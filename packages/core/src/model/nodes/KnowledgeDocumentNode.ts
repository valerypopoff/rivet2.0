import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { coerceType } from '../../utils/coerceType.js';
import { normalizeKnowledgeDocument, normalizeKnowledgeMetadata } from '../../integrations/KnowledgeStoreValidation.js';

export type KnowledgeDocumentNode = ChartNode<'knowledgeDocument', KnowledgeDocumentNodeData>;

export type KnowledgeDocumentNodeData = {
  text: string;
  useTextInput: boolean;
  documentId: string;
  useDocumentIdInput: boolean;
  title: string;
  useTitleInput: boolean;
  metadata: Record<string, unknown>;
  useMetadataInput: boolean;
};

export class KnowledgeDocumentNodeImpl extends NodeImpl<KnowledgeDocumentNode> {
  static create(): KnowledgeDocumentNode {
    return {
      id: nanoid() as NodeId,
      type: 'knowledgeDocument',
      title: 'Knowledge Document',
      visualData: { x: 0, y: 0, width: 250 },
      data: {
        text: '',
        useTextInput: true,
        documentId: '',
        useDocumentIdInput: false,
        title: '',
        useTitleInput: false,
        metadata: {},
        useMetadataInput: false,
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];
    if (this.data.useTextInput)
      inputs.push({ id: 'text' as PortId, title: 'Text', dataType: 'string', required: true });
    if (this.data.useDocumentIdInput)
      inputs.push({ id: 'document-id' as PortId, title: 'Document ID', dataType: 'string' });
    if (this.data.useTitleInput) inputs.push({ id: 'title' as PortId, title: 'Title', dataType: 'string' });
    if (this.data.useMetadataInput) inputs.push({ id: 'metadata' as PortId, title: 'Metadata', dataType: 'object' });
    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [{ id: 'document' as PortId, title: 'Document', dataType: 'knowledge-document' }];
  }

  getEditors(): EditorDefinition<KnowledgeDocumentNode>[] {
    return [
      {
        type: 'code',
        language: 'text',
        dataKey: 'text',
        useInputToggleDataKey: 'useTextInput',
        label: 'Text',
        height: 160,
      },
      { type: 'string', dataKey: 'documentId', useInputToggleDataKey: 'useDocumentIdInput', label: 'Document ID' },
      { type: 'string', dataKey: 'title', useInputToggleDataKey: 'useTitleInput', label: 'Title' },
      {
        type: 'jsonObject',
        dataKey: 'metadata',
        useInputToggleDataKey: 'useMetadataInput',
        label: 'Metadata',
        helperMessage: 'Enter a flat JSON object, or leave {} when the document has no metadata.',
      },
    ];
  }

  getBody(): string {
    return dedent`
      ${this.data.useTextInput ? 'Text from input' : `${this.data.text.length} characters`}
      ${this.data.useDocumentIdInput ? 'ID from input' : this.data.documentId ? `ID: ${this.data.documentId}` : 'ID generated from content'}
    `;
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Knowledge Document',
      infoBoxTitle: 'Knowledge Document Node',
      infoBoxBody: 'Creates a typed text document with a stable ID, title, and portable searchable metadata.',
      group: 'Knowledge',
    };
  }

  async process(inputs: Inputs, _context: InternalProcessContext): Promise<Outputs> {
    const text = this.data.useTextInput ? coerceType(inputs['text' as PortId], 'string') : this.data.text;
    const id = (
      this.data.useDocumentIdInput ? coerceType(inputs['document-id' as PortId], 'string') : this.data.documentId
    ).trim();
    const title = (this.data.useTitleInput ? coerceType(inputs['title' as PortId], 'string') : this.data.title).trim();
    const metadataRaw = this.data.useMetadataInput
      ? coerceType(inputs['metadata' as PortId], 'object')
      : this.data.metadata;
    const metadata = normalizeKnowledgeMetadata(metadataRaw);
    const document = normalizeKnowledgeDocument({ text, ...(id ? { id } : {}), ...(title ? { title } : {}), metadata });
    return { ['document' as PortId]: { type: 'knowledge-document', value: document } };
  }
}

export const knowledgeDocumentNode = nodeDefinition(KnowledgeDocumentNodeImpl, 'Knowledge Document');
