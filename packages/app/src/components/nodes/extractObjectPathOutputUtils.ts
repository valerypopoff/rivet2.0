import {
  type DataValue,
  type ExtractObjectPathNode,
  type Inputs,
  type PortId,
  extractInterpolationVariables,
  findInterpolationTokenSpans,
  getInterpolationTokenReference,
  interpolate,
  protectEscapedInterpolationTokens,
  restoreEscapedInterpolationTokens,
} from '@valerypopoff/rivet2-core';
import { type NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { hasDisplayableInterpolationInputs } from './parsedSourceDisplayUtils.js';

const RESERVED_INPUT_NAMES = new Set(['object']);

function buildExtractObjectPathInterpolationInputs(
  path: string,
  inputs: Inputs,
): Record<string, DataValue | string | undefined> {
  return Object.fromEntries(
    extractInterpolationVariables(path).map((inputName) => [
      inputName,
      RESERVED_INPUT_NAMES.has(inputName) ? '' : inputs[inputName as PortId],
    ]),
  ) as Record<string, DataValue | string | undefined>;
}

export function getExtractObjectPathPreviewSource(node: ExtractObjectPathNode, data: NodeRunDataWithRefs): string {
  return data.debugData?.extractObjectPathSource ?? node.data.path;
}

export function getExtractObjectPathUsePathInput(node: ExtractObjectPathNode, data: NodeRunDataWithRefs): boolean {
  return data.debugData?.extractObjectPathUsePathInput ?? node.data.usePathInput;
}

export function hasExtractObjectPathInterpolationInputs(pathSource: string): boolean {
  return hasDisplayableInterpolationInputs(pathSource, {
    reservedInputNames: RESERVED_INPUT_NAMES,
  });
}

export function getParsedExtractObjectPathPreviewSource(pathSource: string, inputs: Inputs): string {
  const protectedPath = protectEscapedInterpolationTokens(pathSource);
  const tokenSpans = findInterpolationTokenSpans(protectedPath);

  if (tokenSpans.length === 0) {
    return restoreEscapedInterpolationTokens(protectedPath).trim();
  }

  const interpolationInputs = buildExtractObjectPathInterpolationInputs(pathSource, inputs);
  let result = '';
  let cursor = 0;

  for (const tokenSpan of tokenSpans) {
    // Restore escaped syntax only from authored path segments. A recorded
    // input value may itself contain interpolation-looking text and must stay
    // literal in the stored-path preview.
    result += restoreEscapedInterpolationTokens(protectedPath.slice(cursor, tokenSpan.start));

    const tokenReference = getInterpolationTokenReference(tokenSpan.rawInner);

    // Namespace roots intentionally do not have connectable input ports, and
    // app-side history does not retain their source values. Use Core's parsed
    // reference rather than a dotted-prefix check so bracket-root JSONPath
    // forms remain visible too.
    if (tokenReference?.source === 'graphInputs' || tokenReference?.source === 'context') {
      result += protectedPath.slice(tokenSpan.start, tokenSpan.end);
    } else {
      result += interpolate(`{{${tokenSpan.rawInner}}}`, interpolationInputs);
    }

    cursor = tokenSpan.end;
  }

  result += restoreEscapedInterpolationTokens(protectedPath.slice(cursor));

  return result.trim();
}
