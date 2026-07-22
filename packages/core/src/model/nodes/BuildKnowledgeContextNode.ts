import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { RivetKnowledgeEvidence } from '../../integrations/KnowledgeStore.js';
import { normalizeKnowledgeEvidence } from '../../integrations/KnowledgeStoreValidation.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import type { InternalProcessContext } from '../ProcessContext.js';

export type BuildKnowledgeContextNode = ChartNode<'buildKnowledgeContext', BuildKnowledgeContextNodeData>;

export type BuildKnowledgeContextNodeData = {
  budgetUnit: 'characters' | 'tokens';
  budget: number;
  maxItems: number;
  citationPrefix: string;
  metadataFields: string[];
};

export class BuildKnowledgeContextNodeImpl extends NodeImpl<BuildKnowledgeContextNode> {
  static create(): BuildKnowledgeContextNode {
    return {
      id: nanoid() as NodeId,
      type: 'buildKnowledgeContext',
      title: 'Build Knowledge Context',
      visualData: { x: 0, y: 0, width: 280 },
      data: {
        budgetUnit: 'tokens',
        budget: 6000,
        maxItems: 20,
        citationPrefix: 'K',
        metadataFields: ['title'],
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [
      {
        id: 'evidence' as PortId,
        title: 'Evidence',
        dataType: ['knowledge-evidence', 'knowledge-evidence[]'],
        required: true,
      },
    ];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'context' as PortId, title: 'Context', dataType: 'string' },
      { id: 'included-evidence' as PortId, title: 'Included Evidence', dataType: 'knowledge-evidence[]' },
      { id: 'citation-map' as PortId, title: 'Citation Map', dataType: 'object' },
      { id: 'excluded-count' as PortId, title: 'Excluded Count', dataType: 'number' },
    ];
  }

  getEditors(): EditorDefinition<BuildKnowledgeContextNode>[] {
    return [
      {
        type: 'dropdown',
        dataKey: 'budgetUnit',
        label: 'Budget Unit',
        options: [
          { value: 'characters', label: 'Characters' },
          { value: 'tokens', label: 'Tokens' },
        ],
      },
      { type: 'number', dataKey: 'budget', label: 'Context Budget', min: 1, max: 1000000 },
      { type: 'number', dataKey: 'maxItems', label: 'Maximum Evidence Items', min: 1, max: 500 },
      { type: 'string', dataKey: 'citationPrefix', label: 'Citation Prefix', maxLength: 16 },
      {
        type: 'stringList',
        dataKey: 'metadataFields',
        label: 'Metadata Fields To Include',
        placeholder: 'chapter_title',
      },
    ];
  }

  getBody(): string {
    return dedent`
      ${this.data.budget} ${this.data.budgetUnit}
      Up to ${this.data.maxItems} items
      Citations: [${this.data.citationPrefix || 'K'}1]
    `;
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Build Knowledge Context',
      infoBoxTitle: 'Build Knowledge Context Node',
      infoBoxBody: 'Packs structured evidence into a bounded LLM context with stable citation labels.',
      group: 'Knowledge',
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const value = inputs['evidence' as PortId];
    const evidence =
      value?.type === 'knowledge-evidence[]'
        ? value.value.map(normalizeKnowledgeEvidence)
        : value?.type === 'knowledge-evidence'
          ? [normalizeKnowledgeEvidence(value.value)]
          : [];
    if (!value) throw new Error('Build Knowledge Context is missing its Evidence input.');
    if (value.type !== 'knowledge-evidence' && value.type !== 'knowledge-evidence[]') {
      throw new Error(`Build Knowledge Context cannot use ${value.type} as Evidence.`);
    }
    if (!Number.isInteger(this.data.budget) || this.data.budget < 1 || this.data.budget > 1_000_000) {
      throw new Error('Build Knowledge Context budget must be an integer between 1 and 1000000.');
    }
    if (!Number.isInteger(this.data.maxItems) || this.data.maxItems < 1 || this.data.maxItems > 500) {
      throw new Error('Build Knowledge Context maximum evidence items must be an integer between 1 and 500.');
    }
    if (this.data.budgetUnit !== 'characters' && this.data.budgetUnit !== 'tokens') {
      throw new Error('Build Knowledge Context budget unit must be characters or tokens.');
    }
    if (
      !Array.isArray(this.data.metadataFields) ||
      this.data.metadataFields.some((field) => typeof field !== 'string')
    ) {
      throw new Error('Build Knowledge Context metadata fields must be a string array.');
    }

    const included: RivetKnowledgeEvidence[] = [];
    const sections: string[] = [];
    const citationMap: Record<string, unknown> = {};
    if (typeof this.data.citationPrefix !== 'string') {
      throw new Error('Build Knowledge Context citation prefix must be a string.');
    }
    const prefix = this.data.citationPrefix.trim() || 'K';
    if (prefix.length > 16) throw new Error('Build Knowledge Context citation prefix cannot exceed 16 characters.');

    for (const item of evidence.slice(0, this.data.maxItems)) {
      const label = `${prefix}${included.length + 1}`;
      const metadata = buildMetadataLine(item, this.data.metadataFields);
      const section = `[${label}]${metadata ? ` ${metadata}` : ''}\n${item.text}`;
      const candidateContext = [...sections, section].join('\n\n---\n\n');
      const size =
        this.data.budgetUnit === 'tokens'
          ? await context.tokenizer.getTokenCountForString(candidateContext, { node: context.node })
          : candidateContext.length;
      if (size > this.data.budget) continue;
      included.push(item);
      sections.push(section);
      citationMap[label] = {
        evidenceId: item.id,
        source: item.source,
        documentId: item.documentId,
        ...(item.title ? { title: item.title } : {}),
        ...(item.chunkIndex == null ? {} : { chunkIndex: item.chunkIndex }),
        ...(item.metadata ? { metadata: item.metadata } : {}),
      };
    }

    return {
      ['context' as PortId]: { type: 'string', value: sections.join('\n\n---\n\n') },
      ['included-evidence' as PortId]: { type: 'knowledge-evidence[]', value: included },
      ['citation-map' as PortId]: { type: 'object', value: citationMap },
      ['excluded-count' as PortId]: { type: 'number', value: Math.max(0, evidence.length - included.length) },
    };
  }
}

function buildMetadataLine(evidence: RivetKnowledgeEvidence, fields: string[]): string {
  const values: string[] = [];
  for (const field of fields) {
    const normalizedField = field.trim();
    if (!normalizedField) continue;
    const value =
      normalizedField === 'title'
        ? evidence.title
        : evidence.metadata && Object.prototype.hasOwnProperty.call(evidence.metadata, normalizedField)
          ? evidence.metadata[normalizedField]
          : undefined;
    if (value == null || (Array.isArray(value) && value.length === 0)) continue;
    values.push(`${normalizedField}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  return values.join(' | ');
}

export const buildKnowledgeContextNode = nodeDefinition(BuildKnowledgeContextNodeImpl, 'Build Knowledge Context');
