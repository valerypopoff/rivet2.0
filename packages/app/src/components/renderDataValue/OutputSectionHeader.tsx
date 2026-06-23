import { type FC } from 'react';
import {
  outputSectionFullscreenLabelStyles,
  outputSectionHeaderMetaStyles,
  outputSectionLabelStyles,
} from './renderDataValueStyles.js';
import type { TextEditorStats } from '../editors/textEditorStats.js';

export const OutputSectionHeader: FC<{
  isLarge?: boolean;
  label: string;
  stats?: TextEditorStats;
}> = ({ isLarge, label, stats }) => (
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
  </div>
);
