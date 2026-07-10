import { css } from '@emotion/react';

export const jsonStringPreviewAffordanceStyles = css`
  .json-string-preview-button {
    align-items: center;
    background: color-mix(in srgb, var(--modal-surface-bg) 86%, var(--primary) 14%);
    border: 1px solid var(--foldable-section-border);
    border-radius: 4px;
    color: var(--grey-lightest);
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-family);
    font-size: 10px;
    font-weight: 700;
    height: 18px;
    justify-content: center;
    opacity: 0.78;
    padding: 0 4px;
    pointer-events: auto;
    position: fixed;
    touch-action: none;
    z-index: 4000;
  }

  .json-string-preview-button-local {
    position: absolute;
  }

  .json-string-preview-button:hover,
  .json-string-preview-button:focus-visible {
    border-color: var(--primary);
    color: var(--primary);
    opacity: 1;
    outline: none;
  }

  .json-string-preview-popover {
    background: var(--modal-surface-bg);
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    color: var(--grey-lightest);
    max-width: calc(100vw - 24px);
    min-width: 260px;
    position: fixed;
    z-index: 4000;
  }

  .json-string-preview-popover-header {
    align-items: center;
    border-bottom: 1px solid var(--foldable-section-border);
    display: flex;
    gap: 8px;
    min-width: 0;
    padding: 10px 14px;
  }

  .json-string-preview-popover-header > span {
    color: var(--grey-light);
    flex: 1;
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    min-width: 0;
  }

  .json-string-preview-action-button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--grey-light);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--ui-font-size-sm);
    gap: 4px;
    padding: 2px 4px;
  }

  .json-string-preview-action-button:hover,
  .json-string-preview-action-button:focus-visible {
    color: var(--primary);
    outline: none;
  }

  .json-string-preview-action-button svg {
    height: 14px;
    width: 14px;
  }

  .json-string-preview-popover pre {
    color: var(--grey-lightest);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    margin: 0;
    overflow: auto;
    padding: 14px 16px 20px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-string-preview-resize-handle {
    background: transparent;
    border: 0;
    bottom: 0;
    cursor: nesw-resize;
    height: 18px;
    left: 0;
    padding: 0;
    position: absolute;
    width: 18px;
  }

  .json-string-preview-resize-handle::before,
  .json-string-preview-resize-handle::after {
    border-bottom: 2px solid color-mix(in srgb, var(--primary) 70%, transparent);
    border-left: 2px solid color-mix(in srgb, var(--primary) 70%, transparent);
    content: '';
    opacity: 0.42;
    position: absolute;
    transition: opacity 120ms ease-out;
  }

  .json-string-preview-resize-handle::before {
    bottom: 4px;
    height: 8px;
    left: 4px;
    width: 8px;
  }

  .json-string-preview-resize-handle::after {
    bottom: 8px;
    height: 4px;
    left: 8px;
    width: 4px;
  }

  .json-string-preview-resize-handle:hover::before,
  .json-string-preview-resize-handle:hover::after,
  .json-string-preview-resize-handle:focus-visible::before,
  .json-string-preview-resize-handle:focus-visible::after {
    opacity: 0.9;
  }

  .json-string-preview-resize-handle:focus-visible {
    outline: none;
  }

  .json-string-edit-modal-backdrop {
    align-items: center;
    background: color-mix(in srgb, var(--grey-dark) 64%, transparent);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 12px;
    position: fixed;
    z-index: 4100;
  }

  .json-string-edit-modal {
    background: var(--modal-surface-bg);
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
    color: var(--grey-lightest);
    display: grid;
    gap: 14px;
    grid-template-rows: auto minmax(320px, 1fr) auto;
    max-height: calc(100vh - 24px);
    max-width: calc(100vw - 24px);
    min-width: min(560px, calc(100vw - 24px));
    overflow: auto;
    padding: 22px;
    resize: both;
    width: min(960px, calc(100vw - 24px));
  }

  .json-string-edit-modal-header {
    display: grid;
    gap: 6px;
  }

  .json-string-edit-modal h2 {
    font-size: var(--ui-font-size-lg);
    line-height: 1.25;
    margin: 0;
  }

  .json-string-edit-modal textarea {
    background: var(--form-control-bg);
    border: 1px solid var(--form-control-border);
    border-radius: 8px;
    color: var(--foreground);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-base);
    height: 100%;
    line-height: 1.45;
    min-height: 0;
    padding: 12px 14px;
    resize: none;
    width: 100%;
  }

  .json-string-edit-modal textarea:focus {
    background: var(--form-control-bg);
    border-color: var(--form-control-border);
    outline: none;
  }

  .json-string-edit-modal-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .json-string-edit-secondary-button {
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 8px 14px;
  }

  .json-string-edit-secondary-button {
    background: transparent;
    border: 1px solid var(--foldable-section-border);
    color: var(--foreground);
  }

  .json-string-edit-primary-button {
    min-width: calc(84px * var(--ui-font-scale));
  }

  .json-string-edit-secondary-button:hover,
  .json-string-edit-secondary-button:focus-visible {
    outline: none;
  }
`;
