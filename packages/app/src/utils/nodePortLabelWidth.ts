import {
  isBuiltInInputDefinition,
  type NodeInputDefinition,
  type NodeOutputDefinition,
} from '@valerypopoff/rivet2-core';

import { MIN_NODE_WIDTH } from './nodeResize.js';

// The canvas needs a deterministic resize clamp before layout has measured the
// port DOM. These constants match the current compact monospace label styling
// closely enough to avoid over-wide nodes while still giving long labels room.
const PORT_LABEL_CHARACTER_WIDTH_PX = 7.2;
const PORT_LABEL_HORIZONTAL_MARGIN_PX = 8;
const PORT_LABEL_UPPERCASE_LETTER_SPACING_PX = 1;
const PORT_CIRCLE_VISIBLE_WIDTH_PX = 8;
const PORT_COLUMN_GAP_PX = 12;

export type NodePortLabelWidthOptions = {
  inputDefinitions: readonly NodeInputDefinition[];
  outputDefinitions: readonly NodeOutputDefinition[];
  preservePortCase: boolean;
  uiFontScale?: number;
};

export function getRenderedPortLabel(title: unknown, preservePortCase: boolean) {
  // Persisted projects and third-party plugins are untrusted at this UI boundary.
  // Keep the port visible with no label instead of allowing malformed data to crash the canvas.
  const normalizedTitle = typeof title === 'string' ? title : '';
  return preservePortCase ? normalizedTitle : normalizedTitle.toUpperCase();
}

export function estimatePortLabelWidth(title: unknown, preservePortCase: boolean, uiFontScale = 1) {
  const renderedLabel = getRenderedPortLabel(title, preservePortCase).trim();

  if (!renderedLabel) {
    return 0;
  }

  const uppercaseLetterSpacingWidth = preservePortCase
    ? 0
    : Math.max(0, renderedLabel.length - 1) * PORT_LABEL_UPPERCASE_LETTER_SPACING_PX;

  return Math.ceil(
    renderedLabel.length * PORT_LABEL_CHARACTER_WIDTH_PX * uiFontScale +
      uppercaseLetterSpacingWidth +
      PORT_LABEL_HORIZONTAL_MARGIN_PX,
  );
}

function estimatePortRowWidth(title: unknown, preservePortCase: boolean, uiFontScale: number) {
  const labelWidth = estimatePortLabelWidth(title, preservePortCase, uiFontScale);

  if (labelWidth === 0) {
    return PORT_CIRCLE_VISIBLE_WIDTH_PX;
  }

  return labelWidth + PORT_CIRCLE_VISIBLE_WIDTH_PX;
}

function getMaxPortRowWidth(portTitles: readonly unknown[], preservePortCase: boolean, uiFontScale: number) {
  return portTitles.reduce<number>((maxWidth, title) => {
    return Math.max(maxWidth, estimatePortRowWidth(title, preservePortCase, uiFontScale));
  }, 0);
}

export function getMinimumNodeWidthForPortLabels({
  inputDefinitions,
  outputDefinitions,
  preservePortCase,
  uiFontScale = 1,
}: NodePortLabelWidthOptions) {
  const inputTitles = inputDefinitions
    .filter((inputDefinition) => !isBuiltInInputDefinition(inputDefinition))
    .map((inputDefinition) => inputDefinition.title);

  const outputTitles = outputDefinitions.map((outputDefinition) => outputDefinition.title);

  const inputWidth = getMaxPortRowWidth(inputTitles, preservePortCase, uiFontScale);
  const outputWidth = getMaxPortRowWidth(outputTitles, preservePortCase, uiFontScale);
  const columnGap = inputWidth > 0 && outputWidth > 0 ? PORT_COLUMN_GAP_PX : 0;

  return Math.max(MIN_NODE_WIDTH, Math.ceil(inputWidth + outputWidth + columnGap));
}
