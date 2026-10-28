import { nanoid } from 'nanoid/non-secure';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { NodeImpl, type NodeRunActivityDescriptor, type NodeUIData } from '../NodeImpl.js';
import { nodeDefinition } from '../NodeDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import type { DataValue } from '../DataValue.js';
import type { RunCostSnapshot } from '../RunCostLedger.js';
import { addWarning } from '../../utils/outputs.js';

export type AICostNode = ChartNode<'aiCost', Record<string, never>>;

export class AICostNodeImpl extends NodeImpl<AICostNode> {
  static create(): AICostNode {
    return {
      type: 'aiCost',
      title: 'AI Cost',
      id: nanoid() as NodeId,
      visualData: { x: 0, y: 0, width: 250 },
      data: {},
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return [];
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      { id: 'llmCost' as PortId, title: 'LLM cost', dataType: 'number' },
      { id: 'decisionAICost' as PortId, title: 'Decision AI cost', dataType: 'number' },
      { id: 'totalCost' as PortId, title: 'Sum cost', dataType: 'number' },
    ];
  }

  static getUIData(): NodeUIData {
    return {
      contextMenuTitle: 'AI Cost',
      infoBoxTitle: 'AI Cost',
      group: ['Debug'],
      infoBoxBody:
        'Returns observed AI cost estimates in USD for the current project invocation and projects it calls, excluding callers and sibling invocations. Uses the same accounting as Run statistics. Enable Conditional node to control when it runs; use Did Run to wait for multiple branches. In-flight and future calls are not yet included; unknown prices are not free.',
    };
  }

  getBody(): string {
    return 'Observed AI estimates (USD)\nCurrent project subtree';
  }

  getRunActivityDescriptor(): NodeRunActivityDescriptor {
    return { primaryOutputPortId: 'totalCost' as PortId };
  }

  async process(_inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    if (!context.getRunCostBreakdown)
      throw new Error('AI Cost accounting is unavailable in this execution environment.');
    const costs = context.getRunCostBreakdown();
    const value = (cost: RunCostSnapshot): DataValue =>
      cost.knownCostUsd === null
        ? { type: 'control-flow-excluded', value: undefined }
        : { type: 'number', value: cost.knownCostUsd };
    const outputs: Outputs = {
      ['llmCost' as PortId]: value(costs.llm),
      ['decisionAICost' as PortId]: value(costs.decisionAI),
      ['totalCost' as PortId]: value(costs.total),
    };
    if (costs.total.status !== 'complete')
      addWarning(
        outputs,
        'Some observed AI costs are unknown. Numeric outputs are known subtotals; unavailable amounts are not zero.',
      );
    return outputs;
  }
}

export const aiCostNode = nodeDefinition(AICostNodeImpl, 'AI Cost');
