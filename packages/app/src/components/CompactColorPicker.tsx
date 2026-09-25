import { css } from '@emotion/react';
import Popup from '@atlaskit/popup';
import { useState, type CSSProperties, type FC } from 'react';
import type { ColorResult } from 'react-color';
import { PopupMenuContainer, popupMenuSurfaceStyles } from './PopupMenu.js';
import { TripleBarColorPicker } from './TripleBarColorPicker.js';

type RgbaColor = { r: number; g: number; b: number; a: number };

const triggerStyles = css`
  display: block;
  width: 40px;
  height: 32px;
  padding: 4px;
  border: 1px solid var(--grey-darkish);
  border-radius: 6px;
  background: var(--grey-darker);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--grey-light);
  }

  &:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  > span {
    display: block;
    position: relative;
    overflow: hidden;
    width: 100%;
    height: 100%;
    border-radius: 2px;
    background: conic-gradient(#aaa 25%, #fff 0 50%, #aaa 0 75%, #fff 0) 0 0 / 8px 8px;

    &::after {
      content: '';
      position: absolute;
      inset: 0;
      background-color: var(--selected-color);
    }
  }
`;

const pickerStyles = css`
  ${popupMenuSurfaceStyles};
  width: min(260px, calc(100vw - 32px));
  padding: 10px;
`;

export const CompactColorPicker: FC<{
  label: string;
  color: RgbaColor;
  onChange: (color: ColorResult) => void;
}> = ({ label, color, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectedColor = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`;

  return (
    <Popup
      popupComponent={PopupMenuContainer}
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      placement="bottom-start"
      zIndex={1000}
      content={() => (
        <div css={pickerStyles} aria-label={label} role="group">
          <TripleBarColorPicker color={color} onChange={onChange} />
        </div>
      )}
      trigger={(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          css={triggerStyles}
          aria-label={label}
          aria-expanded={isOpen}
          title={label}
          onClick={() => setIsOpen((open) => !open)}
        >
          <span style={{ '--selected-color': selectedColor } as CSSProperties} />
        </button>
      )}
    />
  );
};
