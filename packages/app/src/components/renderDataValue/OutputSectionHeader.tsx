import { type FC } from 'react';
import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import {
  outputSectionCopyButtonStyles,
  outputSectionFullscreenLabelStyles,
  outputSectionHeaderMetaStyles,
  outputSectionLabelStyles,
} from './renderDataValueStyles.js';
import type { TextEditorStats } from '../editors/textEditorStats.js';
import { Tooltip } from '../Tooltip.js';
import { copyToClipboard } from '../../utils/copyToClipboard.js';

export const OutputSectionHeader: FC<{
  getCopyValue?: () => string | undefined;
  isLarge?: boolean;
  label: string;
  stats?: TextEditorStats;
}> = ({ getCopyValue, isLarge, label, stats }) => (
  <div className="output-section-header">
    <em
      css={isLarge ? [outputSectionLabelStyles, outputSectionFullscreenLabelStyles] : outputSectionLabelStyles}
      className="port-id-label"
    >
      {label}
    </em>
    {stats && (
      <span css={outputSectionHeaderMetaStyles} className="output-section-header-meta">
        <span>Words: {stats.wordCount.toLocaleString()}</span>
        <span>Characters: {stats.characterCount.toLocaleString()}</span>
      </span>
    )}
    {getCopyValue !== undefined && (
      <Tooltip content="Copy value" tag="span">
        <button
          type="button"
          css={outputSectionCopyButtonStyles}
          className="output-section-copy-button"
          aria-label={`Copy ${label} value`}
          onClick={() => {
            const copyValue = getCopyValue();
            if (copyValue !== undefined) {
              void copyToClipboard(copyValue);
            }
          }}
        >
          <CopyIcon />
        </button>
      </Tooltip>
    )}
  </div>
);
