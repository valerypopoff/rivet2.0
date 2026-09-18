import { nanoid } from 'nanoid/non-secure';
import { dedent } from 'ts-dedent';
import type { ChartNode, NodeId, NodeInputDefinition, NodeOutputDefinition, PortId } from '../NodeBase.js';
import { type EditorDefinition } from '../EditorDefinition.js';
import type { Inputs, Outputs } from '../GraphProcessor.js';
import { nodeDefinition } from '../NodeDefinition.js';
import { NodeImpl, type NodeUIData } from '../NodeImpl.js';
import { type NodeBodySpec } from '../NodeBodySpec.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  appendCodeNodeSourceUrl,
  buildCodeNodeSourceUrl,
  enrichCodeNodeErrorWithLocation,
} from './codeNodeErrorDiagnostics.js';
import {
  buildJsValueInterpolatedSource,
  buildJsValueInputsInitializer,
  buildJsValuePreview,
  getJsValueInterpolationCodeRunnerOptions,
  getJsValueInterpolationInputDefinitions,
  getJsValueInterpolationRuntimeContext,
  getSafeJsValueInterpolationIdentifier,
  interpolateJsValuePreviewSource,
  sanitizeGeneratedJsValueError,
  type JsValueInterpolationRuntimeContext,
} from './jsValueInterpolation.js';
import { ALL_CODE_RUNNER_OPTIONS } from '../../integrations/CodeRunnerOptions.js';
import { getInterpolationGlobalValues } from '../../utils/interpolation.js';
import { getCodeOutputFields, type CodeOutputField } from './codeOutputInference.js';
export {
  analyzeCodeOutputs,
  getCodeOutputFields,
  getCodeOutputKeys,
  prepareCodeOutputEdit,
  type CodeOutputField,
} from './codeOutputInference.js';

export type CodeNewNode = ChartNode<'codeNew', CodeNewNodeData>;

export type CodeNewNodeData = {
  code: string;
  inferredOutputFields?: CodeOutputField[];
  inferredOutputKeys?: string[];
  inferredOutputRetiredFields?: CodeOutputField[];
  inferredOutputLastValidCode?: string;
};

const CODE_RUNTIME_HELPER_MESSAGE =
  'Node execution also provides "require" and "process". Browser execution provides "fetch", "console", and "Rivet".';

const DEFAULT_CODE_NEW = dedent`
  // This is a Code node. Write JavaScript here and return one value.
  // Interpolation tokens create input ports and evaluate as connected values.
  // Output carries the returned value; explicit object fields also get ports.
  const value = {{input}};
  return value;
`;
const MAX_BODY_PREVIEW_LINES = 15;
const CODE_NEW_INPUTS_IDENTIFIER = '__codeNewInputs';
export const CODE_NEW_OUTPUT_PORT_ID = 'output' as PortId;

function buildCodeNewPreview(code: string): string {
  return buildJsValuePreview(code, MAX_BODY_PREVIEW_LINES);
}

function buildCodeNewRuntimeSource(code: string, interpolationContext: JsValueInterpolationRuntimeContext): string {
  return buildJsValueInterpolatedSource(code, interpolationContext, { trim: false });
}

function buildCodeNewInputsInitializer(interpolationContext: JsValueInterpolationRuntimeContext): string {
  return buildJsValueInputsInitializer({
    interpolationContext,
  });
}

export function interpolateCodeNewSource(code: string, inputs: Inputs): string {
  return interpolateJsValuePreviewSource(code, inputs, { trim: false });
}

function sanitizeCodeNewError(error: unknown, interpolationContext: JsValueInterpolationRuntimeContext): Error {
  return sanitizeGeneratedJsValueError(
    error,
    interpolationContext.inputNames,
    interpolationContext.inputsIdentifier,
    'code input',
    [
      interpolationContext.cloneCacheIdentifier,
      interpolationContext.contextIdentifier,
      interpolationContext.globalValuesCloneIdentifier,
      interpolationContext.globalValuesIdentifier,
      interpolationContext.graphInputsIdentifier,
      interpolationContext.interpolationHelperIdentifier,
    ],
  );
}

function buildCodeNewWrapper(
  code: string,
  interpolationContext: JsValueInterpolationRuntimeContext,
  outputFields: readonly CodeOutputField[],
): {
  source: string;
  userCodeLineOffset: number;
} {
  const resultIdentifier = getSafeJsValueInterpolationIdentifier(code, '__codeNewResult');
  const outputsIdentifier = getSafeJsValueInterpolationIdentifier(code, '__codeNewOutputs');
  const beforeUserCodeLines = [
    ...buildCodeNewInputsInitializer(interpolationContext).split(/\r?\n/),
    '',
    `const ${resultIdentifier} = await (async () => {`,
  ];
  const afterUserCodeLines = [
    '})();',
    '',
    `const ${outputsIdentifier} = {`,
    '  output: {',
    "    type: 'any',",
    `    value: ${resultIdentifier},`,
    '  },',
    '};',
    `for (const { id, key } of ${JSON.stringify(outputFields)}) {`,
    `  const descriptor = ${resultIdentifier} !== null && typeof ${resultIdentifier} === "object" && !Array.isArray(${resultIdentifier})`,
    `    ? Object.getOwnPropertyDescriptor(${resultIdentifier}, key) : undefined;`,
    `  ${outputsIdentifier}[id] = descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor, "value")`,
    '    ? { type: "any", value: descriptor.value }',
    '    : { type: "control-flow-excluded", value: undefined };',
    '}',
    `return ${outputsIdentifier};`,
  ];

  return {
    source: [...beforeUserCodeLines, buildCodeNewRuntimeSource(code, interpolationContext), ...afterUserCodeLines].join(
      '\n',
    ),
    userCodeLineOffset: beforeUserCodeLines.length,
  };
}

function isDataValueLike(value: unknown): value is { type: string; value: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  );
}

function validateCodeNewRunnerOutputs(outputs: unknown, outputFields: readonly CodeOutputField[]): Outputs {
  if (outputs == null || typeof outputs !== 'object' || ('then' in outputs && typeof outputs.then === 'function')) {
    throw new Error('Code node runner must return an object containing the Output value.');
  }

  const output = (outputs as Outputs)[CODE_NEW_OUTPUT_PORT_ID];
  if (!isDataValueLike(output)) {
    throw new Error('Code node runner must return a DataValue for the Output port.');
  }

  if (output.type !== 'any') {
    throw new Error('Code node runner must return an any DataValue for the Output port.');
  }

  for (const { id, key } of outputFields) {
    const value = (outputs as Outputs)[id as PortId];
    if (!isDataValueLike(value) || (value.type !== 'any' && value.type !== 'control-flow-excluded')) {
      throw new Error(`Code node runner must return a DataValue for field ${JSON.stringify(key)}.`);
    }
  }
  return outputs as Outputs;
}

export class CodeNewNodeImpl extends NodeImpl<CodeNewNode> {
  static create(): CodeNewNode {
    return {
      type: 'codeNew',
      title: 'Code',
      id: nanoid() as NodeId,
      visualData: {
        x: 0,
        y: 0,
        width: 260,
      },
      data: {
        code: DEFAULT_CODE_NEW,
      },
    };
  }

  getInputDefinitions(): NodeInputDefinition[] {
    return getJsValueInterpolationInputDefinitions(this.data.code);
  }

  getOutputDefinitions(): NodeOutputDefinition[] {
    return [
      {
        id: CODE_NEW_OUTPUT_PORT_ID,
        title: 'Output',
        dataType: 'any',
      },
      ...getCodeOutputFields(this.data).map(({ id, key }) => ({
        id: id as PortId,
        title: key,
        dataType: 'any' as const,
      })),
    ];
  }

  getEditors(): EditorDefinition<CodeNewNode>[] {
    return [
      {
        type: 'code',
        label: 'Code',
        helperMessage:
          'Use {{var}} to create input ports. Interpolated variables evaluate as the connected values. ' +
          CODE_RUNTIME_HELPER_MESSAGE,
        dataKey: 'code',
        language: 'javascript',
        interpolationSyntax: 'js-value',
        enableFolding: true,
      },
    ];
  }

  getBody(): NodeBodySpec {
    return {
      type: 'colorized',
      text: buildCodeNewPreview(this.data.code),
      language: 'javascript',
      fontSize: 12,
      fontFamily: 'monospace',
    };
  }

  static getUIData(): NodeUIData {
    return {
      infoBoxBody: dedent`
        Runs JavaScript code that can use interpolation-created input ports and emits the returned value as the node output.
      `,
      infoBoxTitle: 'Code Node',
      contextMenuTitle: 'Code',
      group: ['Code'],
    };
  }

  async process(inputs: Inputs, context: InternalProcessContext): Promise<Outputs> {
    const sourceUrl = buildCodeNodeSourceUrl(this.chartNode.id);
    const interpolationContext = getJsValueInterpolationRuntimeContext(this.data.code, CODE_NEW_INPUTS_IDENTIFIER);
    const outputFields = getCodeOutputFields(this.data);
    const { source, userCodeLineOffset } = buildCodeNewWrapper(this.data.code, interpolationContext, outputFields);

    try {
      const outputs = await context.codeRunner.runCode(
        appendCodeNodeSourceUrl(source, sourceUrl),
        inputs,
        getJsValueInterpolationCodeRunnerOptions(ALL_CODE_RUNNER_OPTIONS, interpolationContext),
        context.graphInputNodeValues,
        context.contextValues,
        getInterpolationGlobalValues(this.data.code, context.getGlobal),
      );

      return validateCodeNewRunnerOutputs(outputs, outputFields);
    } catch (error) {
      const enrichedError = await enrichCodeNodeErrorWithLocation({
        code: this.data.code,
        diagnosticCode: source,
        error,
        locationLabel: 'Code node',
        sourceUrl,
        userCodeLineOffset,
      });

      throw sanitizeCodeNewError(enrichedError, interpolationContext);
    }
  }
}

export const codeNewNode = nodeDefinition(CodeNewNodeImpl, 'Code');
