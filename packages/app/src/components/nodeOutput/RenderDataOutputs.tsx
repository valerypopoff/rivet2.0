import { type NodeOutputDefinition } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { type InputsOrOutputsWithRefs } from '../../state/dataFlow.js';
import { RenderDataValue } from '../RenderDataValue.js';
import { OutputSectionHeader } from '../renderDataValue/OutputSectionHeader.js';
import type { OutputRenderMode } from '../renderDataValue/outputRenderTypes.js';
import { getOutputSectionStatsForValue, shouldShowOutputSectionStats } from '../renderDataValue/outputSectionStats.js';
import { renderedDataOutputsStyles } from '../renderDataValue/renderDataValueStyles.js';
import { serializeDisplayedPortValue } from '../../utils/executionDataCopyValue.js';
import { createNodeOutputSectionsViewModel } from './nodeOutputViewModel.js';

export const RenderDataOutputs: FC<{
  definitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[];
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown?: boolean;
  isCompact: boolean;
  mode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ definitions, outputs, renderMarkdown, isCompact, mode, allowLargeStoredValueActions, wrapLines }) => {
  const dataRefs = useDataRefs();
  const effectiveMode = mode ?? (isCompact ? 'compact' : 'full');
  const showSectionStats = shouldShowOutputSectionStats({
    mode: effectiveMode,
    allowLargeStoredValueActions,
  });
  const sections = createNodeOutputSectionsViewModel({
    definitions,
    outputs,
    isCompact,
    showLargeHeaders: showSectionStats,
  });

  if (sections.length === 0) {
    return null;
  }

  if (sections.length === 1 && sections[0]?.headerMode === 'hidden') {
    const section = sections[0]!;
    return (
      <div>
        <RenderDataValue
          value={section.value}
          renderMarkdown={renderMarkdown}
          isCompact={isCompact}
          mode={effectiveMode}
          allowLargeStoredValueActions={allowLargeStoredValueActions}
          wrapLines={wrapLines}
        />
      </div>
    );
  }

  return (
    <div
      css={renderedDataOutputsStyles}
      className={showSectionStats ? 'rendered-data-outputs large-output-sections' : 'rendered-data-outputs'}
    >
      {sections.map((section) => (
        <div className="port-value" key={section.portId}>
          <OutputSectionHeader
            getCopyValue={
              section.headerMode === 'large'
                ? () => serializeDisplayedPortValue(outputs, section.portId, dataRefs)
                : undefined
            }
            isLarge={section.headerMode === 'large'}
            label={section.label}
            stats={section.headerMode === 'large' ? getOutputSectionStatsForValue(section.value, dataRefs) : undefined}
          />
          <RenderDataValue
            value={section.value}
            renderMarkdown={renderMarkdown}
            isCompact={isCompact}
            mode={effectiveMode}
            allowLargeStoredValueActions={allowLargeStoredValueActions}
            wrapLines={wrapLines}
          />
        </div>
      ))}
    </div>
  );
};
