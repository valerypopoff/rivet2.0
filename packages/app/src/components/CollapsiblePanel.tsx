import { css } from '@emotion/react';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronUpIcon from 'majesticons/line/chevron-up-line.svg?react';
import { type FC, type HTMLAttributes, type ReactNode } from 'react';
import Collapsible from 'react-collapsible';

export const collapsiblePanelStyles = css`
  --collapsible-panel-radius: calc(16px * var(--ui-font-scale));
  --collapsible-panel-toggle-radius: calc(8px * var(--ui-font-scale));
  --collapsible-panel-padding-x: calc(16px * var(--ui-font-scale));
  --collapsible-panel-toggle-padding-y: calc(8px * var(--ui-font-scale));
  --collapsible-panel-toggle-icon-size: calc(24px * var(--ui-font-scale));

  @supports not (corner-shape: squircle) {
    --collapsible-panel-radius: calc(8px * var(--ui-font-scale));
    --collapsible-panel-toggle-radius: calc(4px * var(--ui-font-scale));
  }

  > .collapsible-panel-toggle-container,
  > .Collapsible .collapsible-panel-toggle-container {
    display: flex;
    flex-direction: column;
    padding-left: var(--collapsible-panel-padding-x);
    padding-right: var(--collapsible-panel-padding-x);
    border: 1px solid var(--settings-collapsible-border);
    border-radius: var(--collapsible-panel-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-header-bg);
  }

  > .collapsible-panel-toggle-container.open,
  > .Collapsible > .collapsible-panel-toggle-container.open {
    border-bottom: none;
    border-radius: var(--collapsible-panel-radius) var(--collapsible-panel-radius) 0 0;
    corner-shape: squircle;
  }

  > .collapsible-panel-toggle-container.open + .collapsible-panel-static-content,
  > .Collapsible > .collapsible-panel-toggle-container.open + .Collapsible__contentOuter {
    border: 1px solid var(--settings-collapsible-border);
    border-top: none;
    border-radius: 0 0 var(--collapsible-panel-radius) var(--collapsible-panel-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-body-bg);
  }

  .collapsible-panel-toggle-area {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .collapsible-panel-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--collapsible-panel-toggle-padding-y) var(--collapsible-panel-padding-x);
    margin: 0 calc(-1 * var(--collapsible-panel-padding-x));
    border: none;
    background: none;
    cursor: pointer;
    outline: none;
    font-size: var(--ui-font-size-base);
    line-height: 1.25;
    font-weight: var(--label-font-weight);
    border-radius: var(--collapsible-panel-toggle-radius);
    corner-shape: squircle;
    transition: background 0.2s ease-out;
    font-family: inherit;
    color: var(--label-color);

    .indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--collapsible-panel-toggle-icon-size);
      height: var(--collapsible-panel-toggle-icon-size);
      flex: 0 0 var(--collapsible-panel-toggle-icon-size);
    }

    &:hover {
      background: var(--settings-collapsible-hover-bg);
    }
  }
`;

const CollapsiblePanelToggle: FC<{
  ariaControls?: string;
  isOpen?: boolean;
  label: ReactNode;
  helper?: ReactNode;
  toggleClassName?: string;
}> = ({ ariaControls, isOpen, label, helper, toggleClassName }) => (
  <div className="collapsible-panel-toggle-area">
    <button
      type="button"
      className={['collapsible-panel-toggle', toggleClassName].filter(Boolean).join(' ')}
      aria-controls={ariaControls}
      aria-expanded={isOpen ?? false}
    >
      <span className="label">{label}</span>
      <span className="indicator">{isOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
    </button>
    {helper}
  </div>
);

export const CollapsiblePanel: FC<{
  ariaControls?: string;
  children: ReactNode;
  className?: string;
  helper?: ReactNode;
  label: ReactNode;
  onToggle: () => void;
  open: boolean;
  rootProps?: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'> &
    Record<`data-${string}`, string | undefined>;
  toggleClassName?: string;
}> = ({ ariaControls, children, className, helper, label, onToggle, open, rootProps, toggleClassName }) => (
  <div {...rootProps} className={className} css={collapsiblePanelStyles}>
    <Collapsible
      open={open}
      handleTriggerClick={onToggle}
      trigger={
        <CollapsiblePanelToggle
          ariaControls={ariaControls}
          label={label}
          helper={helper}
          toggleClassName={toggleClassName}
        />
      }
      triggerClassName="collapsible-panel-toggle-container"
      triggerOpenedClassName="collapsible-panel-toggle-container open"
      triggerWhenOpen={
        <CollapsiblePanelToggle
          ariaControls={ariaControls}
          label={label}
          helper={helper}
          isOpen
          toggleClassName={toggleClassName}
        />
      }
      transitionTime={150}
      easing="ease-out"
    >
      {children}
    </Collapsible>
  </div>
);
