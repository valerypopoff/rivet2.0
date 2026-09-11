import { dedent } from 'ts-dedent';
import type { Inputs } from '../GraphProcessor.js';
import type { NodeInputDefinition } from '../NodeBase.js';
import { createInterpolationInputDefinition } from '../interpolationInputDefinition.js';
import { getError } from '../../utils/errors.js';
import type { CodeRunnerOptions } from '../../integrations/CodeRunnerOptions.js';
import {
  extractInterpolationVariables,
  parseInterpolationTemplate,
  replaceInterpolationTokens,
  resolveInterpolationExpressionRawValue,
} from '../../utils/interpolation.js';

type JsValueInterpolationOptions = {
  localIdentifiers?: ReadonlySet<string>;
  trim?: boolean;
};

export type JsValueInterpolationRuntimeContext = {
  inputNames: string[];
  inputsIdentifier: string;
  interpolationHelperIdentifier: string;
  cloneCacheIdentifier: string;
  graphInputsIdentifier: string;
  contextIdentifier: string;
  /** Collision-safe runner argument containing the selected global snapshot. */
  globalValuesIdentifier: string;
  /** Collision-safe local clone of the selected global snapshot. */
  globalValuesCloneIdentifier: string;
  /** True when generated source needs a runner-provided path/special resolver. */
  requiresInterpolationHelper: boolean;
  /** True when the resolver also needs the selected global-value snapshot. */
  requiresGlobalValues: boolean;
};

const MISSING_INTERPOLATION_HELPER_MESSAGE =
  'This CodeRunner must honor CodeRunnerOptions.interpolationHelperIdentifier to resolve JSONPath or @graphInputs/@context/@globals interpolation.';
const MISSING_GLOBAL_VALUES_MESSAGE =
  'This CodeRunner must honor CodeRunnerOptions.globalValuesIdentifier to resolve @globals interpolation.';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(identifier)}($|[^A-Za-z0-9_$])`).test(source);
}

export function getSafeJsValueInterpolationIdentifier(source: string, baseIdentifier: string): string {
  let index = 0;
  let candidate = baseIdentifier;

  while (containsIdentifier(source, candidate)) {
    index += 1;
    candidate = `${baseIdentifier}_${index}`;
  }

  return candidate;
}

export function buildJsValuePreview(source: string, maxLines: number): string {
  return source.split('\n').slice(0, maxLines).join('\n').trim();
}

function isSimpleIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function getUserFacingInputName(inputName: string): string {
  return isSimpleIdentifier(inputName) ? inputName : `{{${inputName}}}`;
}

function buildJsValueReference(
  token: {
    tokenName: string | undefined;
    reference: { baseName: string; jsonPath?: string; source: string } | undefined;
  },
  interpolationContext: JsValueInterpolationRuntimeContext,
  options: JsValueInterpolationOptions,
): string {
  if (!token.tokenName || !token.reference) {
    return 'undefined';
  }

  const isBareVariableReference = token.reference.source === 'variable' && token.reference.jsonPath === undefined;
  if (isBareVariableReference) {
    return options.localIdentifiers?.has(token.reference.baseName)
      ? token.reference.baseName
      : `${interpolationContext.inputsIdentifier}[${JSON.stringify(token.reference.baseName)}].value`;
  }

  const isLocalReference =
    token.reference.source === 'variable' && options.localIdentifiers?.has(token.reference.baseName);
  const sourceInputs = isLocalReference
    ? `{ ${JSON.stringify(token.reference.baseName)}: { type: 'any', value: ${token.reference.baseName} } }`
    : interpolationContext.inputsIdentifier;

  const resolveExpression = `${interpolationContext.interpolationHelperIdentifier}(${sourceInputs}, ${JSON.stringify(
    token.tokenName,
  )}, ${interpolationContext.graphInputsIdentifier}, ${interpolationContext.contextIdentifier}, ${interpolationContext.globalValuesCloneIdentifier})`;

  return `(typeof ${interpolationContext.interpolationHelperIdentifier} === 'function'
    ? ${resolveExpression}
    : (() => { throw new Error(${JSON.stringify(MISSING_INTERPOLATION_HELPER_MESSAGE)}); })())`;
}

function formatJsValuePreviewValue(
  token: {
    tokenName: string | undefined;
    reference: { baseName: string; jsonPath?: string; source: string } | undefined;
  },
  inputs: Inputs,
  options: JsValueInterpolationOptions,
): string {
  if (!token.tokenName || !token.reference || token.reference.source !== 'variable') {
    return 'undefined';
  }

  if (options.localIdentifiers?.has(token.reference.baseName)) {
    return token.reference.jsonPath ? `{{${token.tokenName}}}` : token.reference.baseName;
  }

  const value = resolveInterpolationExpressionRawValue(token.tokenName, { variables: inputs });

  if (value === undefined) {
    return 'undefined';
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return getUserFacingInputName(token.tokenName);
}

export function getJsValueInterpolationInputNames(
  template: string,
  options: JsValueInterpolationOptions = {},
): string[] {
  return extractInterpolationVariables(template).filter((inputName) => !options.localIdentifiers?.has(inputName));
}

export function getJsValueInterpolationInputDefinitions(
  template: string,
  options: JsValueInterpolationOptions = {},
): NodeInputDefinition[] {
  return getJsValueInterpolationInputNames(template, options).map((inputName) =>
    createInterpolationInputDefinition({
      interpolationName: inputName,
      dataType: 'any',
      required: false,
    }),
  );
}

export function getJsValueInterpolationRuntimeContext(
  template: string,
  baseInputsIdentifier: string,
  options: JsValueInterpolationOptions = {},
): JsValueInterpolationRuntimeContext {
  const inputsIdentifier = getSafeJsValueInterpolationIdentifier(template, baseInputsIdentifier);
  const interpolationHelperIdentifier = getSafeJsValueInterpolationIdentifier(
    `${template}\n${inputsIdentifier}`,
    `${baseInputsIdentifier}ResolveInterpolation`,
  );
  const cloneCacheIdentifier = getSafeJsValueInterpolationIdentifier(
    `${template}\n${inputsIdentifier}\n${interpolationHelperIdentifier}`,
    `${baseInputsIdentifier}CloneCache`,
  );
  const graphInputsIdentifier = getSafeJsValueInterpolationIdentifier(
    `${template}\n${inputsIdentifier}\n${interpolationHelperIdentifier}\n${cloneCacheIdentifier}`,
    `${baseInputsIdentifier}GraphInputs`,
  );
  const contextIdentifier = getSafeJsValueInterpolationIdentifier(
    `${template}\n${inputsIdentifier}\n${interpolationHelperIdentifier}\n${cloneCacheIdentifier}\n${graphInputsIdentifier}`,
    `${baseInputsIdentifier}Context`,
  );
  const globalValuesIdentifier = getSafeJsValueInterpolationIdentifier(
    `${template}\n${inputsIdentifier}\n${interpolationHelperIdentifier}\n${cloneCacheIdentifier}\n${graphInputsIdentifier}\n${contextIdentifier}`,
    `${baseInputsIdentifier}Globals`,
  );
  const globalValuesCloneIdentifier = getSafeJsValueInterpolationIdentifier(
    `${template}\n${inputsIdentifier}\n${interpolationHelperIdentifier}\n${cloneCacheIdentifier}\n${graphInputsIdentifier}\n${contextIdentifier}\n${globalValuesIdentifier}`,
    `${baseInputsIdentifier}GlobalValues`,
  );

  const parsedTemplate = parseInterpolationTemplate(template);
  return {
    inputNames: getJsValueInterpolationInputNames(template, options),
    inputsIdentifier,
    interpolationHelperIdentifier,
    cloneCacheIdentifier,
    graphInputsIdentifier,
    contextIdentifier,
    globalValuesIdentifier,
    globalValuesCloneIdentifier,
    requiresInterpolationHelper: parsedTemplate.tokens.some(
      (token) =>
        token.reference !== undefined &&
        (token.reference.source !== 'variable' || token.reference.jsonPath !== undefined),
    ),
    requiresGlobalValues: parsedTemplate.tokens.some((token) => token.reference?.source === 'globals'),
  };
}

export function buildJsValueInterpolatedSource(
  template: string,
  interpolationContext: JsValueInterpolationRuntimeContext,
  options: JsValueInterpolationOptions = {},
): string {
  return replaceInterpolationTokens(template, (token) => buildJsValueReference(token, interpolationContext, options), {
    trim: options.trim ?? true,
  });
}

export function interpolateJsValuePreviewSource(
  template: string,
  inputs: Inputs,
  options: JsValueInterpolationOptions = {},
): string {
  return replaceInterpolationTokens(template, (token) => formatJsValuePreviewValue(token, inputs, options), {
    trim: options.trim ?? true,
  });
}

export function buildCloneJsInputValueFunction(): string {
  return dedent`
    const cloneJsInputValue = (value, seen = new WeakMap()) => {
      if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
        return value;
      }

      if (seen.has(value)) {
        return seen.get(value);
      }

      if (typeof value === 'function') {
        const clone = function (...args) {
          return value.apply(this, args);
        };
        seen.set(value, clone);
        for (const key of Reflect.ownKeys(value)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor?.enumerable && 'value' in descriptor) {
            clone[key] = cloneJsInputValue(descriptor.value, seen);
          }
        }
        return clone;
      }

      if (typeof structuredClone === 'function') {
        try {
          const clone = structuredClone(value);
          seen.set(value, clone);
          return clone;
        } catch {
          // Fall through to the smaller clone path for values structuredClone cannot copy.
        }
      }

      if (Array.isArray(value)) {
        const clone = [];
        seen.set(value, clone);
        for (const item of value) {
          clone.push(cloneJsInputValue(item, seen));
        }
        return clone;
      }

      if (value instanceof Date) {
        return new Date(value.getTime());
      }

      if (value instanceof Map) {
        const clone = new Map();
        seen.set(value, clone);
        for (const [key, mapValue] of value.entries()) {
          clone.set(cloneJsInputValue(key, seen), cloneJsInputValue(mapValue, seen));
        }
        return clone;
      }

      if (value instanceof Set) {
        const clone = new Set();
        seen.set(value, clone);
        for (const item of value.values()) {
          clone.add(cloneJsInputValue(item, seen));
        }
        return clone;
      }

      if (value instanceof ArrayBuffer) {
        return value.slice(0);
      }

      if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
          return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        }

        return new value.constructor(value);
      }

      const clone = Object.create(Object.getPrototypeOf(value));
      seen.set(value, clone);
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor?.enumerable && 'value' in descriptor) {
          clone[key] = cloneJsInputValue(descriptor.value, seen);
        }
      }
      return clone;
    };
  `;
}

export function buildClonedInputValueAssignments(
  inputNames: string[],
  targetIdentifier: string,
  cacheIdentifier: string,
): string {
  return inputNames
    .map(
      (inputName) =>
        `${targetIdentifier}[${JSON.stringify(inputName)}] = (() => {
          const sourceDataValue = inputs[${JSON.stringify(inputName)}];
          return sourceDataValue == null
            ? { type: 'any', value: undefined }
            : { ...sourceDataValue, value: cloneJsInputValue(sourceDataValue.value, ${cacheIdentifier}) };
        })();`,
    )
    .join('\n');
}

export function buildJsValueInputClonePreamble({
  cacheIdentifier,
  contextIdentifier,
  graphInputsIdentifier,
  globalValuesCloneIdentifier,
  globalValuesIdentifier,
  usesGlobalValues,
  inputsIdentifier,
}: {
  cacheIdentifier: string;
  contextIdentifier: string;
  graphInputsIdentifier: string;
  globalValuesCloneIdentifier: string;
  globalValuesIdentifier: string;
  usesGlobalValues: boolean;
  inputsIdentifier: string;
}): string {
  return dedent`
    ${buildCloneJsInputValueFunction()}
    const ${inputsIdentifier} = Object.create(null);
    const ${cacheIdentifier} = new WeakMap();
    const ${graphInputsIdentifier} = typeof graphInputs === 'undefined'
      ? Object.create(null)
      : cloneJsInputValue(graphInputs, ${cacheIdentifier});
    const ${contextIdentifier} = typeof context === 'undefined'
      ? Object.create(null)
      : cloneJsInputValue(context, ${cacheIdentifier});
    const ${globalValuesCloneIdentifier} = ${
      usesGlobalValues
        ? `typeof ${globalValuesIdentifier} === 'undefined'
      ? (() => { throw new Error(${JSON.stringify(MISSING_GLOBAL_VALUES_MESSAGE)}); })()
      : cloneJsInputValue(${globalValuesIdentifier}, ${cacheIdentifier})`
        : 'Object.create(null)'
    };
  `;
}

export function buildJsValueInputsInitializer({
  interpolationContext,
}: {
  interpolationContext: JsValueInterpolationRuntimeContext;
}): string {
  const {
    cloneCacheIdentifier,
    contextIdentifier,
    globalValuesCloneIdentifier,
    globalValuesIdentifier,
    graphInputsIdentifier,
    inputNames,
    inputsIdentifier,
  } =
    interpolationContext;

  return dedent`
    ${buildJsValueInputClonePreamble({
      cacheIdentifier: cloneCacheIdentifier,
      contextIdentifier,
      graphInputsIdentifier,
      globalValuesCloneIdentifier,
      globalValuesIdentifier,
      usesGlobalValues: interpolationContext.requiresGlobalValues,
      inputsIdentifier,
    })}
    ${buildClonedInputValueAssignments(inputNames, inputsIdentifier, cloneCacheIdentifier)}
  `;
}

export function getJsValueInterpolationCodeRunnerOptions(
  options: CodeRunnerOptions,
  interpolationContext: JsValueInterpolationRuntimeContext,
): CodeRunnerOptions {
  if (!interpolationContext.requiresInterpolationHelper) {
    return options;
  }

  return {
    ...options,
    interpolationHelperIdentifier: interpolationContext.interpolationHelperIdentifier,
    ...(interpolationContext.requiresGlobalValues
      ? { globalValuesIdentifier: interpolationContext.globalValuesIdentifier }
      : {}),
  };
}

export function sanitizeGeneratedJsValueText(
  text: string | undefined,
  inputNames: string[],
  targetIdentifier: string,
  fallbackLabel: string,
  generatedIdentifiers: readonly string[] = [],
): string | undefined {
  if (!text) {
    return text;
  }

  let sanitized = text;
  const generatedFallbackLabel =
    inputNames.length === 1 ? `${fallbackLabel} ${getUserFacingInputName(inputNames[0]!)}` : fallbackLabel;

  for (const inputName of inputNames) {
    const userFacingInputName = getUserFacingInputName(inputName);
    sanitized = sanitized
      .replaceAll(`${targetIdentifier}[${JSON.stringify(inputName)}]`, userFacingInputName)
      .replaceAll(`${targetIdentifier}.${inputName}`, userFacingInputName);
  }

  // Several generated identifiers intentionally share the input identifier as
  // a prefix. Replace the longer names first so errors never leak fragments
  // such as "code inputResolveInterpolation".
  for (const identifier of [...generatedIdentifiers].sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.replaceAll(identifier, generatedFallbackLabel);
  }

  sanitized = sanitized.replaceAll(targetIdentifier, fallbackLabel);

  return sanitized;
}

export function sanitizeGeneratedJsValueError(
  error: unknown,
  inputNames: string[],
  targetIdentifier: string,
  fallbackLabel: string,
  generatedIdentifiers: readonly string[] = [],
): Error {
  const jsValueError = getError(error);
  jsValueError.message =
    sanitizeGeneratedJsValueText(
      jsValueError.message,
      inputNames,
      targetIdentifier,
      fallbackLabel,
      generatedIdentifiers,
    ) ?? jsValueError.message;
  jsValueError.stack = sanitizeGeneratedJsValueText(
    jsValueError.stack,
    inputNames,
    targetIdentifier,
    fallbackLabel,
    generatedIdentifiers,
  );

  return jsValueError;
}
