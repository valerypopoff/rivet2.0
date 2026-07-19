import { nanoid } from 'nanoid';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import type { GraphId } from '../NodeGraph.js';
import { NodeImpl, type NodeBody, type NodeUIData } from '../NodeImpl.js';
import { dedent } from 'ts-dedent';
import type { EditorDefinition } from '../EditorDefinition.js';
import type { RivetUIContext } from '../RivetUIContext.js';
import { nodeDefinition } from '../NodeDefinition.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import { coerceType } from '../../utils/coerceType.js';
import {
  buildDelegatedToolCallOutputs,
  delegateToolCall,
  isDelegatedToolCallRecord,
  type DelegatedToolCallRecord,
} from './toolCallDelegation.js';

export type DelegateFunctionCallNode = ChartNode<'delegateFunctionCall', DelegateFunctionCallNodeData>;

export type DelegateFunctionCallNodeData = {
  handlers: { key: string; value: GraphId }[];
  unknownHandler: GraphId | undefined;
  autoDelegate: boolean;
  fallBackToExternalCall?: boolean;
  passthroughErrors?: boolean;
};

export class DelegateFunctionCallNodeImpl extends NodeImpl<DelegateFunctionCallNode> {
  static create(): DelegateFunctionCallNode {
    const chartNode: DelegateFunctionCallNode = {
      type: 'delegateFunctionCall',
      title: 'Delegate Tool Call',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 325,
      },
      data: {
        handlers: [],
        unknownHandler: undefined,
        autoDelegate: true,
        fallBackToExternalCall: true,
        passthroughErrors: true,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    const inputs: NodeInputDefinition[] = [];

    inputs.push({
      id: 'function-call' as PortId,
      dataType: ['object', 'object[]'] as const,
      title: 'Tool Call',
      coerced: true,
      required: true,
      description: 'The tool call to delegate to a subgraph.',
    });

    return inputs;
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    const outputs: NodeOutputDefinition[] = [];

    outputs.push({
      id: 'output' as PortId,
      dataType: ['string', 'string[]'] as const,
      title: 'Output',
      description: 'The output of the tool call.',
    });

    outputs.push({
      id: 'message' as PortId,
      dataType: ['chat-message', 'chat-message[]', 'object', 'object[]'] as const,
      title: 'Tool Result Message',
      description: 'Maps the tool result into a chat message for a later LLM request.',
    });

    outputs.push({
      id: 'assistant-message' as PortId,
      dataType: 'string',
      title: 'Message (fires before the tool call is invoked)',
      description:
        'Nonblank text the assistant emitted alongside a connected tool-call round. This output fires before the tools are invoked.',
    });

    return outputs;
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Handles a tool call by delegating it to a different subgraph depending on the tool call.
      `,
      infoBoxTitle: 'Delegate Tool Call Node',
      contextMenuTitle: 'Delegate Tool Call',
      group: ['Advanced'],
    };
  }

  getEditors(): EditorDefinition<DelegateFunctionCallNode>[] {
    return [
      {
        type: 'toggle',
        label: 'Auto Delegate',
        dataKey: 'autoDelegate',
        helperMessage:
          'Prefers a subgraph whose name exactly matches the tool, then falls back to the first name containing it.',
      },
      {
        type: 'toggle',
        label: 'Fall Back To External Call',
        dataKey: 'fallBackToExternalCall',
        helperMessage:
          'If no matching subgraph is found, try calling external functions before falling back to the unknown handler.',
        hideIf: (data) => !data.autoDelegate,
      },
      {
        type: 'toggle',
        label: 'Passthrough Errors',
        dataKey: 'passthroughErrors',
        helperMessage: 'Return external function errors as string outputs instead of aborting the node.',
        hideIf: (data) => !data.autoDelegate || !data.fallBackToExternalCall,
      },
      {
        type: 'custom',
        customEditorId: 'ToolCallHandlers',
        label: 'Handlers',
        dataKey: 'handlers',
        hideIf: (data) => data.autoDelegate,
      },
      {
        type: 'graphSelector',
        dataKey: 'unknownHandler',
        label: 'Unknown Handler',
        helperMessage: 'The subgraph to delegate to if the tool call does not match any handlers.',
      },
    ];
  }

  getBody(context: RivetUIContext): NodeBody {
    if (this.data.autoDelegate) {
      let body = 'Auto Delegate To Subgraphs';
      if (this.data.fallBackToExternalCall) {
        body += '\n(+ External Call Fallback';
        if (this.data.passthroughErrors) {
          body += ', Passthrough Errors';
        }
        body += ')';
      }
      return body;
    }

    if (this.data.handlers.length === 0) {
      return 'No handlers defined';
    }

    const lines = ['Handlers:'];

    this.data.handlers.forEach(({ key, value }) => {
      const subgraphName = context.project.graphs[value]?.metadata!.name! ?? 'Unknown Subgraph';
      lines.push(`    ${key || '(MISSING!)'} -> ${subgraphName}`);
    });

    return lines.join('\n');
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const functionCallInput = coerceType(inputs['function-call' as PortId], 'object');
    const delegatedRecords = getDelegatedToolCallRecords(functionCallInput);

    if (delegatedRecords.length > 0) {
      return buildDelegatedToolCallOutputs(delegatedRecords);
    }

    const result = await delegateToolCall(functionCallInput, context, this.data);

    return buildDelegatedToolCallOutputs([result.record], undefined, result.cost);
  }
}

function getDelegatedToolCallRecords(input: object): DelegatedToolCallRecord[] {
  if (Array.isArray(input)) {
    return input.every(isDelegatedToolCallRecord) ? input : [];
  }

  return isDelegatedToolCallRecord(input) ? [input] : [];
}

export const delegateFunctionCallNode = nodeDefinition(DelegateFunctionCallNodeImpl, 'Delegate Tool Call');
