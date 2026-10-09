import { nanoid } from 'nanoid/non-secure';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { EditorDefinition } from '../EditorDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { resolveClassifierProfile, type ClassifierProfileConfiguration } from '../classifier/profile.js';
import { getClassifierModelEditor, getClassifierEvaluateBodySections } from './ClassifierEvaluateNode.js';
import { formatNodeBodyMarkdownField } from '../nodeBodyMarkdown.js';

export type ClassifierProfileNode = ChartNode<'classifierProfile', ClassifierProfileConfiguration>;
export class ClassifierProfileNodeImpl extends NodeImpl<ClassifierProfileNode> {
  static create(): ClassifierProfileNode {
    return {
      type: 'classifierProfile',
      title: 'Classifier Profile',
      id: nanoid() as NodeId,
      visualData: { x: 0, y: 0, width: 260 },
      data: { provider: 'jev', responseTimeoutMs: 30_000 },
    };
  }
  getInputDefinitions(): NodeInputDefinition[] {
    return [
      ...(this.data.useModelInput
        ? [{ id: 'model' as PortId, title: 'Model', dataType: 'string' as const, required: true }]
        : []),
      ...(this.data.apiKeySource === 'input'
        ? [{ id: 'apiKey' as PortId, title: 'API Key', dataType: 'string' as const, required: false }]
        : []),
    ];
  }
  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'profile' as PortId,
        title: 'Profile',
        dataType: 'classifier-config',
        description: 'Sensitive resolved classifier configuration. Combine profiles with Array for ordered fallback.',
      },
    ];
  }
  getEditors(): EditorDefinition<ClassifierProfileNode>[] {
    return [
      getClassifierModelEditor(this.data) as EditorDefinition<ClassifierProfileNode>,
      {
        type: 'number',
        label: 'Response timeout (seconds)',
        dataKey: 'responseTimeoutMs',
        defaultValue: 30,
        storageMultiplier: 1000,
        min: 1,
        max: 600,
      },
      {
        type: 'group',
        label: 'Classifier profile suspension',
        editors: [
          {
            type: 'toggle',
            label: 'Automatic suspension',
            dataKey: 'enableCircuitBreaker',
            helperMessage:
              'Studio Server shares suspension across runs. Other hosts must supply a profile health store.',
          },
          {
            type: 'number',
            label: 'Failures before suspension',
            dataKey: 'circuitBreakerFailureThreshold',
            defaultValue: 3,
            min: 1,
            max: 1000,
            hideIf: (data) => !data.enableCircuitBreaker,
          },
          {
            type: 'number',
            label: 'Failure window (seconds)',
            dataKey: 'circuitBreakerFailureWindowMs',
            defaultValue: 300,
            storageMultiplier: 1000,
            min: 1,
            max: 86400,
            hideIf: (data) => !data.enableCircuitBreaker,
          },
          {
            type: 'number',
            label: 'Suspension duration (seconds)',
            dataKey: 'circuitBreakerOpenDurationMs',
            defaultValue: 300,
            storageMultiplier: 1000,
            min: 1,
            max: 86400,
            hideIf: (data) => !data.enableCircuitBreaker,
          },
        ],
      },
    ];
  }
  getBody() {
    return {
      type: 'markdown' as const,
      text:
        getClassifierEvaluateBodySections(this.data)
          .filter((section) => section.id === 'configuration')
          .flatMap((section) => section.fields)
          .map((field) => formatNodeBodyMarkdownField(field.label, field.value))
          .join('') +
        formatNodeBodyMarkdownField('Automatic suspension', this.data.enableCircuitBreaker ? 'Enabled' : 'Disabled'),
    };
  }
  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'Classifier Profile',
      infoBoxTitle: 'Classifier Profile',
      infoBoxBody:
        'Reusable classifier provider/model/credential configuration. Combine profiles with Array for ordered fallback.',
      group: ['Classifier'],
    };
  }
  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    context.signal.throwIfAborted();
    return {
      ['profile' as PortId]: { type: 'classifier-config', value: resolveClassifierProfile(this.data, inputs, context) },
    };
  }
}
export const classifierProfileNode = nodeDefinition(ClassifierProfileNodeImpl, 'Classifier Profile');
