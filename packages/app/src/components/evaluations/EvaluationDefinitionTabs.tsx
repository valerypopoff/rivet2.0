import { css } from '@emotion/react';
import { type FC, useRef } from 'react';

export type EvaluationDefinitionTabId = 'deterministic-checks' | 'evaluator-graphs' | 'thresholds';

export type EvaluationDefinitionTab = {
  id: EvaluationDefinitionTabId;
  label: string;
  count: number;
};

const styles = css`
  display: flex;
  align-items: end;
  gap: 22px;
  margin-top: 24px;

  button {
    position: relative;
    border: 0;
    background: transparent;
    color: var(--grey-light);
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    padding: 8px 1px 9px;
  }

  button:hover,
  button:focus-visible,
  button[aria-selected='true'] {
    color: var(--foreground);
  }

  button:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  button[aria-selected='true']::after {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    background: var(--primary);
    content: '';
  }
`;

export const EvaluationDefinitionTabs: FC<{
  tabs: readonly EvaluationDefinitionTab[];
  activeTab: EvaluationDefinitionTabId;
  onSelect: (tab: EvaluationDefinitionTabId) => void;
}> = ({ tabs, activeTab, onSelect }) => {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moveFocus = (currentIndex: number, direction: -1 | 1) => {
    const index = (currentIndex + direction + tabs.length) % tabs.length;
    buttonRefs.current[index]?.focus();
  };

  return (
    <div css={styles} role="tablist" aria-label="Evaluation definition editors">
      {tabs.map((tab, index) => (
        <button
          type="button"
          role="tab"
          id={`evaluation-definition-tab-${tab.id}`}
          aria-controls={`evaluation-definition-panel-${tab.id}`}
          aria-selected={activeTab === tab.id}
          key={tab.id}
          ref={(button) => {
            buttonRefs.current[index] = button;
          }}
          tabIndex={activeTab === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              moveFocus(index, -1);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              moveFocus(index, 1);
            } else if (event.key === 'Home') {
              event.preventDefault();
              buttonRefs.current[0]?.focus();
            } else if (event.key === 'End') {
              event.preventDefault();
              buttonRefs.current[tabs.length - 1]?.focus();
            }
          }}
        >
          {tab.label} ({tab.count})
        </button>
      ))}
    </div>
  );
};
