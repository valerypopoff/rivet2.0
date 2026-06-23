import { css } from '@emotion/react';

export const renderDataValueStyles = css`
  .chat-message.user header em {
    color: var(--text-color-accent-3);
  }

  .chat-message.assistant header em {
    color: var(--text-color-accent-2);
  }

  .chat-message.function header em {
    color: var(--grey-light);
  }

  .chat-message.system header em {
    color: var(--grey-light);
  }

  .message-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .chat-message-url-image {
    max-width: 300px;
    object-fit: contain;
  }
`;

export const outputSectionLabelStyles = css`
  color: var(--primary);
  font-family: var(--font-family-monospace);
  font-size: var(--ui-font-size-sm);
  font-style: normal;
  font-weight: 700;
  line-height: 1.25;
`;

export const outputSectionFullscreenLabelStyles = css`
  font-size: var(--ui-font-size-lg);
`;

export const outputSectionHeaderMetaStyles = css`
  color: var(--grey-light);
  display: inline-flex;
  flex-wrap: wrap;
  gap: calc(12px * var(--ui-font-scale));
  font-family: var(--font-family-monospace);
  font-size: var(--ui-font-size-sm);
  font-style: normal;
  font-weight: 500;
  line-height: 1.25;
`;

export const outputSectionGroupGap = 'calc(18px * var(--ui-font-scale))';
export const outputSectionFullscreenGroupGap = 'calc(28px * var(--ui-font-scale))';

export const renderedDataOutputsStyles = css`
  display: block;

  &.large-output-sections {
    --output-section-group-gap: ${outputSectionFullscreenGroupGap};
  }

  .port-value + .port-value {
    margin-top: var(--output-section-group-gap, ${outputSectionGroupGap});
  }

  .port-value {
    display: block;
  }

  .output-section-header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: calc(10px * var(--ui-font-scale));
  }

  .port-value > * + * {
    margin-top: 4px;
  }
`;

export const multiOutputStyles = css`
  display: flex;
  flex-direction: column;
  gap: calc(10px * var(--ui-font-scale));

  .multi-output-item {
    position: relative;
    padding-left: calc(10px * var(--ui-font-scale));
    border-radius: calc(4px * var(--ui-font-scale));
    transition: background-color 120ms ease;

    .pre-wrap {
      margin: 0;
    }

    &:hover {
      background-color: var(--grey-light-seethrougher);
    }

    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: calc(2px * var(--ui-font-scale));
      border-radius: 999px;
      background: var(--grey-lightish);
    }
  }

  .array-info {
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
  }
`;
