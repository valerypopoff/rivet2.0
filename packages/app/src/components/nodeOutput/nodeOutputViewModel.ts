import type { ChartNode, NodeOutputDefinition } from '@valerypopoff/rivet2-core';
import type { DataRefReader } from '../../providers/ProvidersContext.js';
import type {
  DataValueWithRefs,
  InputsOrOutputsWithRefs,
  NodeRunDataWithRefs,
  PageValue,
  ProcessDataForNode,
} from '../../state/dataFlow.js';
import { getSelectedProcessData } from '../../state/selectors/executionSelectors.js';
import {
  type NodeOutputCopyValueProjector,
  serializeDisplayedOutputs,
} from '../../utils/executionDataCopyValue.js';
import { getStoredOutputWarnings, restoreDisplayedNodeOutputs } from '../../utils/executionDataReaders.js';
import {
  hasVisibleStoredPortMapValues,
  hasVisibleStoredSplitOutputValues,
  isVisibleOutputPort,
} from '../../utils/outputPortVisibility.js';
import { keys } from '../../utils/typeSafety.js';
import { getSortedRenderableSplitOutputEntries } from './splitOutputEntries.js';
import {
  getSelectedVisibleOutputProcess,
  nodeRunDataHasVisibleOutput,
  shouldUseCodeErrorOutput,
  shouldUseCustomNodeErrorOutput,
} from './nodeOutputVisibility.js';

export type NodeOutputCopySource = Pick<NodeRunDataWithRefs, 'outputData' | 'splitOutputData'> & {
  errorMessage?: string;
};

export type NodeOutputContentViewModel =
  | {
      kind: 'empty';
    }
  | {
      kind: 'code-error';
      contentKeyKind: 'code-error';
      copySource: NodeOutputCopySource;
    }
  | {
      kind: 'generic-error';
      contentKeyKind: 'error';
      copySource: NodeOutputCopySource;
      error: string;
    }
  | {
      kind: 'output' | 'custom-error';
      contentKeyKind: 'output' | 'custom-error';
      errorMessage?: string;
      warnings: string[] | undefined;
      copySource: NodeOutputCopySource;
    };

export type NodeOutputBodyViewModel =
  | {
      kind: 'custom-fullscreen-renderer';
    }
  | {
      kind: 'custom-renderer';
    }
  | {
      kind: 'split-outputs';
      splitOutputs: Array<[string, InputsOrOutputsWithRefs]>;
    }
  | {
      kind: 'outputs';
      outputs: InputsOrOutputsWithRefs;
    }
  | {
      kind: 'empty';
    };

export type NodeOutputSectionHeaderMode = 'hidden' | 'standard' | 'large';

export type NodeOutputSectionViewModel = {
  headerMode: NodeOutputSectionHeaderMode;
  label: string;
  portId: string;
  value: DataValueWithRefs;
};

export type FullscreenNodeOutputViewModel =
  | {
      kind: 'empty';
      processId: undefined;
      data: undefined;
      content: { kind: 'empty' };
      totalPages: number;
    }
  | {
      kind: 'content';
      processId: ProcessDataForNode['processId'];
      data: NodeRunDataWithRefs;
      content: Exclude<NodeOutputContentViewModel, { kind: 'empty' }>;
      totalPages: number;
    };

export function createNodeOutputContentViewModel(options: {
  nodeType: ChartNode['type'];
  data: NodeRunDataWithRefs;
  dataRefs: DataRefReader;
  showNodeRunDuration?: boolean;
}): NodeOutputContentViewModel {
  const { nodeType, data, dataRefs, showNodeRunDuration = false } = options;
  const errorMessage = data.status?.type === 'error' ? data.status.error : undefined;
  const hasVisibleOutputs = hasVisibleStoredPortMapValues(data.outputData) || hasVisibleStoredSplitOutputValues(data.splitOutputData);
  const shouldUseCustomErrorOutput = shouldUseCustomNodeErrorOutput(nodeType, data);

  if (errorMessage && shouldUseCodeErrorOutput(nodeType, data) && !hasVisibleOutputs) {
    return {
      kind: 'code-error',
      contentKeyKind: 'code-error',
      copySource: createNodeOutputCopySource(data, errorMessage),
    };
  }

  if (errorMessage && !shouldUseCustomErrorOutput && !hasVisibleOutputs) {
    return {
      kind: 'generic-error',
      contentKeyKind: 'error',
      copySource: createNodeOutputCopySource(data, errorMessage),
      error: errorMessage,
    };
  }

  if (!nodeRunDataHasVisibleOutput(nodeType, data, { showNodeRunDuration })) {
    return {
      kind: 'empty',
    };
  }

  return {
    kind: shouldUseCustomErrorOutput ? 'custom-error' : 'output',
    contentKeyKind: shouldUseCustomErrorOutput ? 'custom-error' : 'output',
    errorMessage,
    warnings: getStoredOutputWarnings(data, dataRefs),
    copySource: createNodeOutputCopySource(data, errorMessage),
  };
}

function createNodeOutputCopySource(
  data: Pick<NodeRunDataWithRefs, 'outputData' | 'splitOutputData'>,
  errorMessage: string | undefined,
): NodeOutputCopySource {
  return errorMessage ? { ...data, errorMessage } : data;
}

export function createNodeOutputBodyViewModel(options: {
  data: NodeRunDataWithRefs;
  hasFullscreenOutputRenderer?: boolean;
  hasOutputRenderer?: boolean;
}): NodeOutputBodyViewModel {
  const { data, hasFullscreenOutputRenderer = false, hasOutputRenderer = false } = options;

  if (hasFullscreenOutputRenderer) {
    return { kind: 'custom-fullscreen-renderer' };
  }

  if (hasOutputRenderer) {
    return { kind: 'custom-renderer' };
  }

  const splitOutputs = getSortedRenderableSplitOutputEntries(data.splitOutputData);
  if (splitOutputs.length > 0) {
    return {
      kind: 'split-outputs',
      splitOutputs,
    };
  }

  if (hasVisibleStoredPortMapValues(data.outputData)) {
    return {
      kind: 'outputs',
      outputs: data.outputData,
    };
  }

  return { kind: 'empty' };
}

export function createNodeOutputSectionsViewModel(options: {
  definitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[];
  outputs: InputsOrOutputsWithRefs;
  isCompact: boolean;
  showLargeHeaders?: boolean;
}): NodeOutputSectionViewModel[] {
  const { definitions, outputs, isCompact, showLargeHeaders = false } = options;
  const visibleOutputPorts = keys(outputs).filter((portId) => isVisibleOutputPort(portId) && outputs[portId] != null);
  const outputPorts = isCompact ? visibleOutputPorts.slice(0, 1) : visibleOutputPorts;

  if (outputPorts.length === 0) {
    return [];
  }

  const hasMultipleOutputs = outputPorts.length > 1;
  const headerMode: NodeOutputSectionHeaderMode = showLargeHeaders
    ? 'large'
    : hasMultipleOutputs
      ? 'standard'
      : 'hidden';

  return outputPorts.map((portId) => {
    const fallbackLabel = !hasMultipleOutputs && showLargeHeaders ? 'Output' : undefined;

    return {
      headerMode,
      label: getNodeOutputPortDisplayLabel(definitions, portId, fallbackLabel),
      portId: String(portId),
      value: outputs[portId]!,
    };
  });
}

function getNodeOutputPortDisplayLabel(
  definitions: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[] | undefined,
  portId: string,
  fallbackLabel?: string,
): string {
  const title = definitions?.find((definition) => definition.id === portId)?.title?.trim();
  return title || fallbackLabel || portId;
}

export function createFullscreenNodeOutputViewModel(options: {
  nodeType: ChartNode['type'];
  processData: ProcessDataForNode[] | undefined;
  selectedPage: PageValue;
  dataRefs: DataRefReader;
  showNodeRunDuration?: boolean;
}): FullscreenNodeOutputViewModel {
  const { nodeType, processData, selectedPage, dataRefs, showNodeRunDuration = false } = options;
  const selectedProcess = getSelectedVisibleOutputProcess(nodeType, processData, selectedPage, {
    showNodeRunDuration,
  });
  const content =
    selectedProcess &&
    createNodeOutputContentViewModel({
      nodeType,
      data: selectedProcess.data,
      dataRefs,
      showNodeRunDuration,
    });

  if (!selectedProcess || !content || content.kind === 'empty') {
    return {
      kind: 'empty',
      processId: undefined,
      data: undefined,
      content: { kind: 'empty' },
      totalPages: processData?.length ?? 0,
    };
  }

  return {
    kind: 'content',
    processId: selectedProcess.processId,
    data: selectedProcess.data,
    content,
    totalPages: processData?.length ?? 0,
  };
}

export function getSelectedNodeOutputProcess(
  processData: ProcessDataForNode[],
  selectedPage: PageValue,
): ProcessDataForNode | undefined {
  return getSelectedProcessData(processData, selectedPage);
}

export function getNodeOutputCopySource(content: NodeOutputContentViewModel): NodeOutputCopySource | undefined {
  return content.kind === 'empty' ? undefined : content.copySource;
}

export function serializeNodeOutputDisplayCopy(
  copySource: NodeOutputCopySource | undefined,
  dataRefs: DataRefReader,
  options?: {
    getCopyValueData?: NodeOutputCopyValueProjector;
    outputDefinitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[];
  },
): string | undefined {
  if (!copySource) {
    return undefined;
  }

  const serializedOutputs = serializeDisplayedOutputs(copySource, dataRefs, options);
  const { errorMessage } = copySource;

  if (!errorMessage) {
    return serializedOutputs;
  }

  if (serializedOutputs == null) {
    return errorMessage;
  }

  return `Error\n${errorMessage}\n\n${serializedOutputs}`;
}

export function serializeNodeOutputJsonCopy(
  copySource: NodeOutputCopySource | undefined,
  dataRefs: DataRefReader,
): string | undefined {
  if (!copySource) {
    return undefined;
  }

  const restoredOutputData = restoreDisplayedNodeOutputs(copySource, dataRefs);
  if (!restoredOutputData) {
    return undefined;
  }

  return JSON.stringify(restoredOutputData, null, 2);
}
