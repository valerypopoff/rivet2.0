import { css } from '@emotion/react';
import { type CSSProperties, type FC } from 'react';
import SparklesIcon from '../assets/icons/ai-sparks-solid.svg?react';
import { showAiGraphCreatorInputState } from './AiGraphCreatorInput';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { sidebarOpenState } from '../state/graphBuilder';
import clsx from 'clsx';
import { leftSidebarLiveWidthState } from '../state/ui';
import { getLeftSidebarAttachedControlOffset } from '../utils/leftSidebarWidth';
import { getGraphBuilderEligibilityFromGetter } from '../features/graphBuilder/editorGateway.js';

const styles = css`
  position: absolute;
  left: 16px;
  bottom: 16px;

  &.sidebar-open {
    left: var(--ai-graph-creator-left);
  }

  button {
    width: 48px;
    height: 48px;
    background: var(--grey-darker);
    border-radius: calc(32px * var(--ui-font-scale));
    corner-shape: superellipse(1.15);
    @supports not (corner-shape: squircle) {
      border-radius: calc(16px * var(--ui-font-scale));
    }
    border: 1px solid var(--grey-dark);
    z-index: 50;
    /* box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.5); */
    cursor: pointer;
    color: var(--primary);

    svg {
      width: 24px;
      height: 24px;
    }

    &:hover {
      background: var(--grey-lightish);
      color: var(--grey-lightest);
    }

    &:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    &:disabled:hover {
      background: var(--grey-darker);
      color: var(--primary);
    }
  }
`;

export const AiGraphCreatorToggle: FC = () => {
  const store = useStore();
  const setShowAiGraphCreatorInput = useSetAtom(showAiGraphCreatorInputState);
  const isSidebarOpen = useAtomValue(sidebarOpenState);
  const aiGraphCreatorLeft = getLeftSidebarAttachedControlOffset(useAtomValue(leftSidebarLiveWidthState));
  const eligibility = getGraphBuilderEligibilityFromGetter((target) => store.get(target));

  const handleClick = () => {
    if (!eligibility.eligible) {
      return;
    }
    setShowAiGraphCreatorInput((prev) => !prev);
  };

  return (
    <div
      css={styles}
      className={clsx({ 'sidebar-open': isSidebarOpen })}
      style={{ '--ai-graph-creator-left': `${aiGraphCreatorLeft}px` } as CSSProperties}
    >
      <button
        aria-label="Open AI Graph Builder"
        disabled={!eligibility.eligible}
        onClick={handleClick}
        title={eligibility.eligible ? 'Build or edit this graph with AI' : eligibility.reason}
      >
        <SparklesIcon />
      </button>
    </div>
  );
};
