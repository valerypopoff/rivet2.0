import { Fragment, type ComponentType, type ReactNode } from 'react';
import { type InputsOrOutputsWithRefs, type NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { type ChartNode, type NodeOutputDefinition } from '@valerypopoff/rivet2-core';
import { RenderDataOutputs } from './RenderDataOutputs.js';
import { createNodeOutputBodyViewModel } from './nodeOutputViewModel.js';
import type {
  FullscreenNodeOutputRendererProps,
  FullscreenNodeOutputSimpleRendererProps,
  NodeOutputRendererProps,
  NodeOutputRenderPolicyProps,
  NodeOutputSimpleRendererProps,
} from './nodeOutputRendererTypes.js';

type RenderNodeOutputBodyOptions = NodeOutputRenderPolicyProps & {
  Output?: ComponentType<NodeOutputRendererProps>;
  OutputSimple?: ComponentType<NodeOutputSimpleRendererProps>;
  FullscreenOutput?: ComponentType<FullscreenNodeOutputRendererProps>;
  FullscreenOutputSimple?: ComponentType<FullscreenNodeOutputSimpleRendererProps>;
  node: ChartNode;
  data: NodeRunDataWithRefs;
  definitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[];
  isCompact: boolean;
  renderMarkdown?: boolean;
  /** Lets a node-specific display-only layer replace one split item's output view. */
  renderSplitOutput?: (options: { splitIndex: number; outputs: InputsOrOutputsWithRefs }) => ReactNode;
};

export function renderNodeOutputBody(options: RenderNodeOutputBodyOptions): ReactNode {
  const {
    Output,
    OutputSimple,
    FullscreenOutput,
    FullscreenOutputSimple,
    node,
    data,
    definitions,
    isCompact,
    renderMarkdown,
    renderSplitOutput,
    renderMode,
    allowLargeStoredValueActions,
    autoCollapseLlmChatDiagnosticOutputs,
    wrapLines,
  } = options;

  const bodyViewModel = createNodeOutputBodyViewModel({
    data,
    hasFullscreenOutputRenderer: FullscreenOutput != null,
    hasOutputRenderer: Output != null,
  });

  if (bodyViewModel.kind === 'custom-fullscreen-renderer' && FullscreenOutput) {
    return (
      <FullscreenOutput
        node={node}
        data={data}
        renderMarkdown={renderMarkdown}
        renderMode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  }

  if (bodyViewModel.kind === 'custom-renderer' && Output) {
    return (
      <Output
        node={node}
        data={data}
        isCompact={isCompact}
        renderMarkdown={renderMarkdown}
        renderMode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  }

  if (bodyViewModel.kind === 'split-outputs') {
    return (
      <div className="split-output">
        {bodyViewModel.splitOutputs.map(([key, value]) => {
          const splitIndex = Number(key);
          if (renderSplitOutput && Number.isInteger(splitIndex)) {
            return (
              <Fragment key={`outputs-${key}`}>
                {renderSplitOutput({ splitIndex, outputs: value as InputsOrOutputsWithRefs })}
              </Fragment>
            );
          }

          return FullscreenOutputSimple ? (
            <FullscreenOutputSimple
              key={`outputs-${key}`}
              outputs={value as InputsOrOutputsWithRefs}
              renderMarkdown={renderMarkdown ?? false}
              renderMode={renderMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          ) : OutputSimple ? (
            <OutputSimple
              key={`outputs-${key}`}
              outputs={value as InputsOrOutputsWithRefs}
              isCompact={isCompact}
              renderMarkdown={renderMarkdown}
              renderMode={renderMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          ) : (
            <RenderDataOutputs
              key={`outputs-${key}`}
              definitions={definitions}
              outputs={value as InputsOrOutputsWithRefs}
              renderMarkdown={renderMarkdown}
              isCompact={isCompact}
              mode={renderMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              autoCollapseLlmChatDiagnosticOutputs={autoCollapseLlmChatDiagnosticOutputs}
              wrapLines={wrapLines}
            />
          );
        })}
      </div>
    );
  }

  if (bodyViewModel.kind !== 'outputs') {
    return null;
  }

  if (FullscreenOutputSimple) {
    return (
      <FullscreenOutputSimple
        outputs={bodyViewModel.outputs}
        renderMarkdown={renderMarkdown ?? false}
        renderMode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  }

  if (OutputSimple) {
    return (
      <OutputSimple
        outputs={bodyViewModel.outputs}
        isCompact={isCompact}
        renderMarkdown={renderMarkdown}
        renderMode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  }

  return (
    <RenderDataOutputs
      definitions={definitions}
      outputs={bodyViewModel.outputs}
      renderMarkdown={renderMarkdown}
      isCompact={isCompact}
      mode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      autoCollapseLlmChatDiagnosticOutputs={autoCollapseLlmChatDiagnosticOutputs}
      wrapLines={wrapLines}
    />
  );
}
