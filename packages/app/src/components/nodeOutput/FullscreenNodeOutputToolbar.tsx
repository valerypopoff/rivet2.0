import { css } from '@emotion/react';
import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import EyeIcon from 'majesticons/line/eye-line.svg?react';
import FlaskIcon from 'majesticons/line/flask-line.svg?react';
import { type FC, type KeyboardEventHandler, type Ref } from 'react';
import { LabeledToggle } from '../LabeledToggle.js';

const fullscreenOutputToolbarCss = css`
  --fullscreen-output-toolbar-control-height: calc(28px * var(--ui-font-scale));
  --fullscreen-output-toolbar-icon-size: calc(24px * var(--ui-font-scale));

  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;

  border: 1px solid var(--grey-darkish);
  background: var(--grey-darker);
  border-radius: 8px;
  corner-shape: squircle;
  @supports not (corner-shape: squircle) {
    border-radius: 4px;
  }
  box-shadow: none;
  margin-bottom: 8px;
  padding: 8px 12px;

  .toolbar-icon {
    width: var(--fullscreen-output-toolbar-icon-size);
    height: var(--fullscreen-output-toolbar-icon-size);
    font-size: var(--ui-font-size-2xl);
    color: var(--foreground);
    opacity: var(--node-output-action-opacity);
    cursor: pointer;
    transition: opacity 0.2s;
    z-index: 1;
  }

  .toolbar-icon:hover {
    opacity: 1;
  }

  .copy-json-button {
    color: var(--foreground);
    opacity: var(--node-output-action-opacity);
    cursor: pointer;
    user-select: none;
    text-transform: uppercase;
    font-size: var(--ui-font-size-2xs);
    line-height: 1;
    transition: opacity 0.2s;
    z-index: 1;
    height: var(--fullscreen-output-toolbar-control-height);
    padding: 0 calc(6px * var(--ui-font-scale));
    display: inline-flex;
    align-items: center;

    &:hover {
      opacity: 1;
    }
  }

  .output-format-toggle {
    display: flex;
    align-items: center;
    user-select: none;
    color: var(--foreground);
  }

  .search-group {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 280px;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    border-right: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0 8px;
  }

  .search-input {
    width: 100%;
    min-width: 140px;
    border: 1px solid var(--grey);
    background: rgba(255, 255, 255, 0.05);
    color: var(--foreground);
    border-radius: var(--ui-button-radius-sm);
    corner-shape: squircle;
    height: var(--fullscreen-output-toolbar-control-height);
    padding: 4px 8px;
    font: inherit;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--primary);
  }

  .search-match-controls {
    display: inline-flex;
    align-items: center;
    gap: calc(4px * var(--ui-font-scale));
    color: var(--grey-lighter);
    white-space: nowrap;
  }

  .search-nav-button {
    cursor: pointer;
    border: 1px solid var(--grey);
    background: rgba(255, 255, 255, 0.05);
    color: inherit;
    border-radius: var(--ui-button-radius-sm);
    corner-shape: squircle;
    min-width: var(--fullscreen-output-toolbar-control-height);
    height: var(--fullscreen-output-toolbar-control-height);
    padding: 0 6px;
    font: inherit;
    line-height: 1;

    &:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  }

  .search-nav-button:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .search-count {
    font-size: var(--ui-font-size-sm);
    min-width: max-content;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
`;

export type FullscreenNodeOutputToolbarProps = {
  wrapLines: boolean;
  renderMarkdown: boolean;
  onToggleWrapLines: () => void;
  onToggleRenderMarkdown: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  currentMatchIndex: number;
  totalMatchCount: number;
  onPreviousMatch: () => void;
  onNextMatch: () => void;
  searchInputRef: Ref<HTMLInputElement>;
  onSearchInputKeyDown: KeyboardEventHandler<HTMLInputElement>;
  onCopyValue: () => void;
  onCopyJson: () => void;
  onOpenPromptDesigner?: () => void;
  onInspectResponse?: () => void;
};

export const FullscreenNodeOutputToolbar: FC<FullscreenNodeOutputToolbarProps> = ({
  wrapLines,
  renderMarkdown,
  onToggleWrapLines,
  onToggleRenderMarkdown,
  query,
  onQueryChange,
  currentMatchIndex,
  totalMatchCount,
  onPreviousMatch,
  onNextMatch,
  searchInputRef,
  onSearchInputKeyDown,
  onCopyValue,
  onCopyJson,
  onOpenPromptDesigner,
  onInspectResponse,
}) => {
  return (
    <div css={fullscreenOutputToolbarCss}>
      <LabeledToggle
        id="fullscreen-output-wrap-lines"
        isChecked={wrapLines}
        isDisabled={renderMarkdown}
        onChange={onToggleWrapLines}
        label="Wrap lines"
        className="output-format-toggle"
      />
      <LabeledToggle
        id="fullscreen-output-render-markdown"
        isChecked={renderMarkdown}
        onChange={onToggleRenderMarkdown}
        label="Render Markdown"
        className="output-format-toggle"
      />
      <div className="search-group">
        <input
          ref={searchInputRef}
          className="search-input"
          placeholder="Search output"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onSearchInputKeyDown}
        />
        {totalMatchCount > 0 && (
          <div className="search-match-controls">
            <button className="search-nav-button" onClick={onPreviousMatch} title="Previous match">
              {'<'}
            </button>
            <span className="search-count">
              {`${Math.min(currentMatchIndex + 1, totalMatchCount)} / ${totalMatchCount}`}
            </span>
            <button className="search-nav-button" onClick={onNextMatch} title="Next match">
              {'>'}
            </button>
          </div>
        )}
      </div>
      <div className="toolbar-icon copy-button" onClick={onCopyValue} title="Copy Value">
        <CopyIcon />
      </div>
      <div className="copy-json-button" onClick={onCopyJson} title="Copy as JSON">
        JSON
      </div>
      {onInspectResponse && (
        <div className="toolbar-icon response-inspector-button" onClick={onInspectResponse} title="Inspect response">
          <EyeIcon />
        </div>
      )}
      {onOpenPromptDesigner && (
        <div className="toolbar-icon prompt-designer-button" onClick={onOpenPromptDesigner}>
          <FlaskIcon />
        </div>
      )}
    </div>
  );
};
