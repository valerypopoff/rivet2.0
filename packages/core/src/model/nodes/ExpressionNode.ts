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
  buildJsValueInterpolatedSource,
  buildJsValueInputsInitializer,
  buildJsValuePreview,
  getJsValueInterpolationInputDefinitions,
  getJsValueInterpolationRuntimeContext,
  interpolateJsValuePreviewSource,
  sanitizeGeneratedJsValueError,
  type JsValueInterpolationRuntimeContext,
} from './jsValueInterpolation.js';
import { ALL_CODE_RUNNER_OPTIONS } from '../../integrations/CodeRunner.js';

export type ExpressionNode = ChartNode<'expression', ExpressionNodeData>;

export type ExpressionNodeData = {
  expression: string;
};

const CODE_RUNTIME_HELPER_MESSAGE =
  'Node execution also provides "require" and "process". Browser execution provides "fetch", "console", and "Rivet".';

const DEFAULT_EXPRESSION = '{{a}} == "123" ? {{b}} : {{c}}';
const MAX_BODY_PREVIEW_LINES = 15;
const EXPRESSION_INPUTS_IDENTIFIER = '__expressionInputs';
const EXPRESSION_INPUT_CLONE_CACHE_IDENTIFIER = 'expressionInputCloneCache';
export const EXPRESSION_OUTPUT_PORT_ID = 'output' as PortId;

function buildExpressionPreview(expression: string): string {
  return buildJsValuePreview(expression, MAX_BODY_PREVIEW_LINES);
}

function buildExpressionRuntimeSource(expression: string, inputsIdentifier: string): string {
  return buildJsValueInterpolatedSource(expression, inputsIdentifier);
}

function buildExpressionInputsInitializer(inputNames: string[], inputsIdentifier: string): string {
  return buildJsValueInputsInitializer({
    cacheIdentifier: EXPRESSION_INPUT_CLONE_CACHE_IDENTIFIER,
    inputNames,
    inputsIdentifier,
  });
}

export function interpolateExpressionSource(expression: string, inputs: Inputs): string {
  return interpolateJsValuePreviewSource(expression, inputs);
}

function sanitizeExpressionError(error: unknown, inputNames: string[], inputsIdentifier: string): Error {
  return sanitizeGeneratedJsValueError(error, inputNames, inputsIdentifier, 'expression input');
}

function buildExpressionWrapper(expression: string, interpolationContext: JsValueInterpolationRuntimeContext): string {
  const { inputNames, inputsIdentifier } = interpolationContext;
  const expressionSource = buildExpressionRuntimeSource(expression, inputsIdentifier);

  return dedent`
    ${buildExpressionInputsInitializer(inputNames, inputsIdentifier)}

    return {
      output: {
        type: 'any',
        value: (${expressionSource}),
      },
    };
  `;
}

export class ExpressionNodeImpl extends NodeImpl<ExpressionNode> {
  static create(): ExpressionNode {
    const chartNode: ExpressionNode = {
      type: 'expression',
      title: 'Expression',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 260,
      },
      data: {
        expression: DEFAULT_EXPRESSION,
      },
    };

    return chartNode;
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return getJsValueInterpolationInputDefinitions(this.data.expression);
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: EXPRESSION_OUTPUT_PORT_ID,
        title: 'Output',
        dataType: 'any',
      },
    ];
  }

  getEditors(): EditorDefinition<ExpressionNode>[] {
    return [
      {
        type: 'code',
        label: 'Expression',
        helperMessage:
          'Use {{var}} to create input ports. Interpolated variables evaluate as the connected values. ' +
          CODE_RUNTIME_HELPER_MESSAGE,
        dataKey: 'expression',
        language: 'javascript',
        interpolationSyntax: 'js-value',
        enableFolding: true,
      },
    ];
  }

  getBody(): NodeBodySpec {
    return {
      type: 'colorized',
      text: buildExpressionPreview(this.data.expression),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    };
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Evaluates a single JavaScript expression and returns the resulting value.

        <code>{{interpolation}}</code> creates dynamic input ports. Interpolated variables evaluate as connected values, so arrays, objects, strings, numbers, and booleans can be used directly.
      `,
      infoBoxTitle: 'Expression Node',
      contextMenuTitle: 'Expression',
      group: ['Advanced'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const interpolationContext = getJsValueInterpolationRuntimeContext(
      this.data.expression,
      EXPRESSION_INPUTS_IDENTIFIER,
    );
    const { inputNames, inputsIdentifier } = interpolationContext;
    const source = buildExpressionWrapper(this.data.expression, interpolationContext);

    try {
      return await context.codeRunner.runCode(
        source,
        inputs,
        ALL_CODE_RUNNER_OPTIONS,
        context.graphInputNodeValues,
        context.contextValues,
      );
    } catch (error) {
      throw sanitizeExpressionError(error, inputNames, inputsIdentifier);
    }
  }
}

export const expressionNode = nodeDefinition(ExpressionNodeImpl, 'Expression');
