import Popup, { type PopupComponentProps } from '@atlaskit/popup';
import { css, type SerializedStyles } from '@emotion/react';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ComponentType,
  type CSSProperties,
  type HTMLAttributes,
  type SVGProps,
} from 'react';
import clsx from 'clsx';

export const popupMenuSurfaceStyles = css`
  background-color: var(--popup-menu-bg);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  border-radius: 18px;
  corner-shape: squircle;
  @supports not (corner-shape: squircle) {
    border-radius: 9px;
  }
  border: 1px solid var(--popup-menu-border);
  /*box-shadow: 3px 1px 10px rgba(0, 0, 0, 0.5);*/
  color: var(--grey-lighter);
  font-family: var(--font-family);
  font-size: var(--ui-font-size-base);
  padding: 0.25em;
  user-select: none;

  &:focus,
  &:focus-visible {
    outline: none;
  }
`;

export const popupMenuListStyles = css`
  ${popupMenuSurfaceStyles};
  display: flex;
  flex-direction: column;
  min-width: 220px;

  * {
    font-family: var(--font-family);
  }
`;

export const popupMenuIconSlotStyles = css`
  display: block;
  flex: 0 0 calc(17px * var(--ui-font-scale));
  width: calc(17px * var(--ui-font-scale));
  height: calc(17px * var(--ui-font-scale));
  transform: translateY(-0.02em);
`;

export const popupMenuLabelStyles = css`
  display: inline-block;
`;

export const popupMenuSeparatorStyles = css`
  flex: 0 0 auto;
  height: 1px;
  margin: 0.35em 0.75em;
  background-color: var(--popup-menu-separator);
`;

export const popupMenuSeparatedRowStyles = css`
  margin-top: 0.7em;

  &::before {
    content: '';
    position: absolute;
    left: 0.75em;
    right: 0.75em;
    top: -0.35em;
    height: 1px;
    background-color: var(--popup-menu-separator);
    pointer-events: none;
  }
`;

export const popupMenuRowStyles = css`
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.8em;
  padding: 0em 1em 0em 1em;
  margin: 0;
  border-radius: var(--ui-button-radius);
  corner-shape: squircle;
  background-color: transparent;
  border: none;
  color: var(--grey-lighter);
  cursor: pointer;
  font-size: var(--ui-font-size-base);
  line-height: 1.2;
  transition:
    background-color 0.1s ease-out,
    color 0.1s ease-out;

  &:hover,
  &:focus-visible,
  &.active {
    background-color: var(--popup-menu-row-hover-bg);
    outline: none;
  }

  &.danger {
    color: var(--error);
  }

  &.danger:hover,
  &.danger:focus-visible,
  &.danger.active {
    background-color: var(--popup-menu-row-hover-bg);
    color: var(--error-light);
  }
`;

export const popupMenuButtonItemStyles = css`
  ${popupMenuRowStyles};
  width: 100%;
  justify-content: flex-start;
  text-align: left;

  > svg {
    ${popupMenuIconSlotStyles};
  }

  .menu-item-label {
    ${popupMenuLabelStyles};
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

export const transparentPopupContainerStyles = css`
  display: block;
  overflow: visible;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  outline: none;

  &:focus,
  &:focus-visible {
    outline: none;
  }
`;

export const PopupMenuContainer = forwardRef<HTMLDivElement, PopupComponentProps>(
  ({ children, shouldRenderToParent: _shouldRenderToParent, ...props }, ref) => (
    <div {...props} ref={ref} css={transparentPopupContainerStyles}>
      {children}
    </div>
  ),
);
PopupMenuContainer.displayName = 'PopupMenuContainer';

export type PopupMenuProps = HTMLAttributes<HTMLDivElement> & {
  minWidth?: CSSProperties['minWidth'];
  extraCss?: SerializedStyles;
};

export const PopupMenu = forwardRef<HTMLDivElement, PopupMenuProps>(
  ({ children, className, extraCss, minWidth, style, ...props }, ref) => (
    <div
      {...props}
      ref={ref}
      className={className}
      css={[popupMenuListStyles, extraCss]}
      style={{ minWidth, ...style }}
    >
      {children}
    </div>
  ),
);
PopupMenu.displayName = 'PopupMenu';

export type PopupMenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  separatorBefore?: boolean;
  tone?: 'default' | 'danger';
};

export const PopupMenuItem = forwardRef<HTMLButtonElement, PopupMenuItemProps>(
  ({ children, className, icon: Icon, separatorBefore = false, tone = 'default', type = 'button', ...props }, ref) => (
    <button
      {...props}
      ref={ref}
      type={type}
      className={clsx(className, { danger: tone === 'danger' })}
      css={[popupMenuButtonItemStyles, separatorBefore && popupMenuSeparatedRowStyles]}
    >
      {Icon && <Icon />}
      <span className="menu-item-label">{children}</span>
    </button>
  ),
);
PopupMenuItem.displayName = 'PopupMenuItem';

export { Popup };
