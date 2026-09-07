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
  buildJSMapWrapper,
  getJSListEditors,
  getJSListInputDefinitions,
  getJSListNodeBody,
  runJSListNodeCode,
} from './jsListCallbackHelpers.js';

export type JSMapNode = ChartNode<'jsMap', JSMapNodeData>;

export type JSMapNodeData = {
  callbackBody: string;
};

const DEFAULT_CALLBACK_BODY = 'return item;';

export class JSMapNodeImpl extends NodeImpl<JSMapNode> {
  static create(): JSMapNode {
    const chartNode: JSMapNode = {
      type: 'jsMap',
      title: 'JS Map',
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
        id: 'mapped' as PortId,
        title: 'Mapped',
        dataType: 'any[]',
      },
    ];
  }

  getEditors(): EditorDefinition<JSMapNode>[] {
    return getJSListEditors<JSMapNode>();
  }

  getBody(): NodeBodySpec {
    return getJSListNodeBody(this.data.callbackBody);
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Maps an input array using the body of a JavaScript callback.

        Available callback parameters are <code>item</code>, <code>index</code>, and <code>array</code>.
        Write only the callback body and still use <code>return</code> to produce each mapped item.
        Use <code>{{var}}</code> to add input ports that evaluate as connected values. A path such as
        <code>{{config.limit.max}}</code> creates only <code>config</code>; <code>{{item.name}}</code> and
        <code>{{array[0]}}</code> use callback locals and do not add ports.
      `,
      infoBoxTitle: 'JS Map Node',
      contextMenuTitle: 'JS Map',
      group: ['Lists'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    return runJSListNodeCode({
      buildWrapper: buildJSMapWrapper,
      callbackBody: this.data.callbackBody,
      context,
      inputs,
      nodeName: 'JS Map',
      outputId: 'mapped',
    });
  }
}

export const jsMapNode = nodeDefinition(JSMapNodeImpl, 'JS Map');
