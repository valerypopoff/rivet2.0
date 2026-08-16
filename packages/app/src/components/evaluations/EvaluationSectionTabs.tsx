import { css } from '@emotion/react';
import { type FC, useRef } from 'react';
import type { EvaluationWorkspaceView } from './evaluationWorkspaceModel.js';

type EvaluationSuiteWorkspaceView = Exclude<EvaluationWorkspaceView, 'dataset'>;

const tabs: ReadonlyArray<{ id: EvaluationSuiteWorkspaceView; label: string }> = [
  { id: 'definition', label: 'Definition' },
  { id: 'runs', label: 'Runs' },
  { id: 'compare', label: 'Compare' },
];

const styles = css`
  display: flex;
  align-items: end;
  gap: 22px;
  border-bottom: 1px solid var(--grey-darkish);

  button {
    position: relative;
    border: 0;
    background: transparent;
    color: var(--grey-light);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 10px 1px 11px;
  }

  button:hover:not(:disabled) {
    color: var(--foreground);
  }

  button[aria-selected='true'] {
    color: var(--foreground);
  }

  button[aria-selected='true']::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 2px;
    background: var(--primary);
    content: '';
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }
`;

export const EvaluationSectionTabs: FC<{
  activeView: EvaluationSuiteWorkspaceView;
  compareAvailable: boolean;
  onSelect: (view: EvaluationSuiteWorkspaceView) => void;
}> = ({ activeView, compareAvailable, onSelect }) => {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const isDisabled = (view: EvaluationSuiteWorkspaceView) => view === 'compare' && !compareAvailable;
  const moveFocus = (currentIndex: number, direction: -1 | 1) => {
    for (let offset = 1; offset <= tabs.length; offset += 1) {
      const index = (currentIndex + direction * offset + tabs.length) % tabs.length;
      if (!isDisabled(tabs[index]!.id)) {
        buttonRefs.current[index]?.focus();
        return;
      }
    }
  };

  return (
    <div css={styles} role="tablist" aria-label="Evaluation suite sections">
      {tabs.map((tab, index) => {
        const disabled = isDisabled(tab.id);
        const title =
          tab.id === 'compare' && disabled
            ? 'Compare becomes available after a baseline or two completed runs exist.'
            : undefined;
        return (
          <button
            type="button"
            role="tab"
            id={`evaluation-tab-${tab.id}`}
            aria-controls={`evaluation-panel-${tab.id}`}
            key={tab.id}
            aria-selected={activeView === tab.id}
            disabled={disabled}
            tabIndex={activeView === tab.id ? 0 : -1}
            ref={(button) => {
              buttonRefs.current[index] = button;
            }}
            title={title}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                moveFocus(index, -1);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                moveFocus(index, 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                buttonRefs.current.find((button) => button != null && !button.disabled)?.focus();
              } else if (event.key === 'End') {
                event.preventDefault();
                [...buttonRefs.current]
                  .reverse()
                  .find((button) => button != null && !button.disabled)
                  ?.focus();
              }
            }}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
};
