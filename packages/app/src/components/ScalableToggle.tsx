import { css } from '@emotion/react';
import clsx from 'clsx';
import { type ChangeEventHandler, type FC } from 'react';

type ScalableToggleProps = {
  ariaLabel?: string;
  id?: string;
  isChecked?: boolean;
  isDisabled?: boolean;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  className?: string;
  size?: 'regular' | 'large';
  title?: string;
};

const scalableToggleStyles = css`
  --toggle-scale: var(--ui-font-scale, 1);
  --toggle-width: calc(32px * var(--toggle-scale));
  --toggle-height: calc(16px * var(--toggle-scale));
  --toggle-padding: calc(2px * var(--toggle-scale));
  --toggle-thumb-size: calc(12px * var(--toggle-scale));
  --toggle-icon-size: calc(10px * var(--toggle-scale));
  --toggle-checked-icon-color: var(--foreground-on-primary);

  position: relative;
  width: var(--toggle-width);
  height: var(--toggle-height);
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  cursor: pointer;

  &.is-large {
    --toggle-width: calc(40px * var(--toggle-scale));
    --toggle-height: calc(20px * var(--toggle-scale));
    --toggle-thumb-size: calc(16px * var(--toggle-scale));
    --toggle-icon-size: calc(12px * var(--toggle-scale));
  }

  &.is-disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .scalable-toggle-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }

  .scalable-toggle-track {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: 999px;
    corner-shape: superellipse(1.15);
    background-color: var(--ds-background-neutral-bold, #a5adba);
    transition: background-color 0.15s ease-out;
  }

  &.is-checked .scalable-toggle-track {
    background-color: var(--primary);
  }

  &:not(.is-disabled):hover:not(.is-checked) .scalable-toggle-track {
    background-color: var(--ds-background-neutral-bold-hovered, #505f79);
  }

  &:not(.is-disabled):hover.is-checked .scalable-toggle-track {
    --toggle-checked-icon-color: var(--foreground-on-primary-light);

    background-color: var(--primary-light);
  }

  .scalable-toggle-input:focus-visible + .scalable-toggle-track {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .scalable-toggle-thumb {
    position: absolute;
    top: var(--toggle-padding);
    left: var(--toggle-padding);
    width: var(--toggle-thumb-size);
    height: var(--toggle-thumb-size);
    border-radius: 999px;
    background-color: var(--ds-icon-inverse, #172b4d);
    transition: transform 0.15s ease-out;
  }

  &.is-checked .scalable-toggle-thumb {
    background-color: var(--toggle-checked-icon-color);
    transform: translateX(calc(var(--toggle-width) - var(--toggle-thumb-size) - (var(--toggle-padding) * 2)));
  }

  .scalable-toggle-icon {
    position: absolute;
    top: 0;
    bottom: 0;
    width: calc(var(--toggle-width) / 2);
    display: block;
    color: var(--ds-icon-inverse, #172b4d);
    transition: opacity 0.15s ease-out;
    pointer-events: none;
  }

  .scalable-toggle-icon-check {
    left: 0;
    opacity: 0;
  }

  .scalable-toggle-icon-cross {
    right: 0;
    opacity: 1;
  }

  .scalable-toggle-mark {
    display: block;
    position: absolute;
    top: 50%;
    left: 50%;
    width: var(--toggle-icon-size);
    height: var(--toggle-icon-size);
    overflow: visible;
    transform: translate(-50%, -50%);
  }

  &.is-checked .scalable-toggle-icon-check {
    color: var(--toggle-checked-icon-color);
    opacity: 1;
  }

  &.is-checked .scalable-toggle-icon-cross {
    opacity: 0;
  }
`;

export const ScalableToggle: FC<ScalableToggleProps> = ({
  ariaLabel,
  className,
  id,
  isChecked,
  isDisabled,
  onChange,
  size,
  title,
}) => (
  <label
    className={clsx(
      'scalable-toggle',
      isChecked && 'is-checked',
      isDisabled && 'is-disabled',
      size === 'large' && 'is-large',
      className,
    )}
    css={scalableToggleStyles}
  >
    <input
      aria-label={ariaLabel}
      id={id}
      checked={Boolean(isChecked)}
      className="scalable-toggle-input"
      disabled={isDisabled}
      onChange={onChange}
      readOnly={onChange == null}
      title={title}
      type="checkbox"
    />
    <span className="scalable-toggle-track" aria-hidden="true">
      <span className="scalable-toggle-icon scalable-toggle-icon-check">
        <svg
          className="scalable-toggle-mark scalable-toggle-check-mark"
          fill="none"
          focusable="false"
          shapeRendering="geometricPrecision"
          viewBox="0 0 12 12"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M3.1 6.1L5.1 8.1L8.9 3.9"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
        </svg>
      </span>
      <span className="scalable-toggle-icon scalable-toggle-icon-cross">
        <svg
          className="scalable-toggle-mark scalable-toggle-cross-mark"
          fill="none"
          focusable="false"
          shapeRendering="geometricPrecision"
          viewBox="0 0 12 12"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M3.5 3.5L8.5 8.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="M8.5 3.5L3.5 8.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      </span>
      <span className="scalable-toggle-thumb" />
    </span>
  </label>
);
