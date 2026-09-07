import {
  type ChartNode,
  type NodeId,
  type NodeInputDefinition,
  type NodeOutputDefinition,
  type PortId,
} from '../NodeBase.js';
import { nanoid } from 'nanoid/non-secure';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { type EditorDefinition, type NodeBodySpec } from '../../index.js';
import { dedent } from 'ts-dedent';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import { nodeDefinition } from '../NodeDefinition.js';
import {
  buildJSFilterWrapper,
  getJSListEditors,
  getJSListInputDefinitions,
  getJSListNodeBody,
  runJSListNodeCode,
} from './jsListCallbackHelpers.js';

export type JSFilterNode = ChartNode<'jsFilter', JSFilterNodeData>;

export type JSFilterNodeData = {
  callbackBody: string;
};

const DEFAULT_CALLBACK_BODY = 'return item != null;';

export class JSFilterNodeImpl extends NodeImpl<JSFilterNode> {
  static create(): JSFilterNode {
    const chartNode: JSFilterNode = {
      type: 'jsFilter',
      title: 'JS Filter',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 220,
      },
      data: {
        callbackBody: DEFAULT_CALLBACK_BODY,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return getJSListInputDefinitions(this.data.callbackBody);
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: 'filtered' as PortId,
        title: 'Filtered',
        dataType: 'any[]',
      },
    ];
  }

  getEditors(): EditorDefinition<JSFilterNode>[] {
    return getJSListEditors<JSFilterNode>();
  }

  getBody(): NodeBodySpec {
    return getJSListNodeBody(this.data.callbackBody);
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Filters an input array using the body of a JavaScript callback.

        Available callback parameters are <code>item</code>, <code>index</code>, and <code>array</code>.
        Write only the callback body and still use <code>return</code> to decide whether each item is included.
        Use <code>{{var}}</code> to add input ports that evaluate as connected values. A path such as
        <code>{{config.limit.max}}</code> creates only <code>config</code>; <code>{{item.name}}</code> and
        <code>{{array[0]}}</code> use callback locals and do not add ports.
      `,
      infoBoxTitle: 'JS Filter Node',
      contextMenuTitle: 'JS Filter',
      group: ['Lists'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    return runJSListNodeCode({
      buildWrapper: buildJSFilterWrapper,
      callbackBody: this.data.callbackBody,
      context,
      inputs,
      nodeName: 'JS Filter',
      outputId: 'filtered',
    });
  }
}

export const jsFilterNode = nodeDefinition(JSFilterNodeImpl, 'JS Filter');
