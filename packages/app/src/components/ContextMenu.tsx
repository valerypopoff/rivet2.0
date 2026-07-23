import { css } from '@emotion/react';
import styled from '@emotion/styled';
import { type FC, forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { CSSTransition } from 'react-transition-group';
import { useStableCallback } from '../hooks/useStableCallback.js';
import { useFloating, useMergeRefs, autoUpdate, shift, flip } from '@floating-ui/react';
import {
  type ContextMenuConfiguration,
  useContextMenuConfiguration,
  type ContextMenuItem as ContextMenuConfigItem,
} from '../hooks/useContextMenuConfiguration';
import { useFuseSearch } from '../hooks/useFuseSearch.js';
import { uniqBy } from 'lodash-es';
import clsx from 'clsx';
import { useMarkdown } from '../hooks/useMarkdown.js';
import { getContextMenuSearchPresentation } from './contextMenuSearchGrouping.js';
import {
  popupMenuIconSlotStyles,
  popupMenuLabelStyles,
  popupMenuListStyles,
  popupMenuRowStyles,
  popupMenuSeparatedRowStyles,
  popupMenuSurfaceStyles,
} from './PopupMenu.js';

const menuReferenceStyles = css`
  position: absolute;
  z-index: 3000;
  &.disabled {
    display: none;
  }
`;

export const menuStyles = css`
  ${popupMenuListStyles};
  z-index: 1;

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .context-menu-search {
    input {
      background-color: transparent !important;
      border: 0 !important;
      border-width: 0 !important;
      box-shadow: none !important;
      outline: 0 !important;
      padding: 8px;
      font-size: var(--ui-font-size-base);
      line-height: 14px;
    }
  }

  .context-menu-search-section-header {
    padding: 10px 12px 6px;
    margin-top: 4px;
    border-top: 1px solid var(--popup-menu-separator);
    color: var(--grey-lightish);
    font-size: var(--ui-font-size-sm);
    line-height: 1;
  }
`;

export type ContextMenuContext = {
  [P in keyof ContextMenuConfiguration['contexts']]: {
    type: P;
    data: ContextMenuConfiguration['contexts'][P]['contextType'];
  };
}[keyof ContextMenuConfiguration['contexts']];

export interface ContextMenuProps {
  x: number;
  y: number;
  displayOffset?: { x: number; y: number };
  context: ContextMenuContext;
  disabled?: boolean;
  onMenuItemSelected?: (id: string, data: unknown, context: ContextMenuContext, meta: { x: number; y: number }) => void;
}

const isHiddenUntilSearched = <T extends object>(item: T & { hiddenUntilSearched?: boolean }) =>
  item.hiddenUntilSearched === true;

const isContextMenuItemVisible = <T extends object>(
  item: T & { conditional?: (context: unknown) => boolean },
  contextData: unknown,
) => !item.conditional || item.conditional(contextData);

const isContextMenuItemDisabled = (item: ContextMenuConfigItem, contextData: unknown) =>
  typeof item.disabled === 'function' ? item.disabled(contextData) : item.disabled === true;

const getContextMenuItemDisabledReason = (item: ContextMenuConfigItem, contextData: unknown) =>
  typeof item.disabledReason === 'function' ? item.disabledReason(contextData) : item.disabledReason;

export const ContextMenu = forwardRef<HTMLDivElement, ContextMenuProps>(
  ({ x, y, displayOffset = { x: 0, y: 0 }, context, disabled, onMenuItemSelected }, ref) => {
    const canSearch = context.type !== 'node';
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedResultIndex, setSelectedResultIndex] = useState(0);

    const { refs, floatingStyles, update } = useFloating({
      placement: 'bottom-start',
      whileElementsMounted: autoUpdate,
      middleware: [shift({ crossAxis: true })],
    });

    const anchorRef = useMergeRefs([ref, refs.setReference]);

    const { contexts, commands } = useContextMenuConfiguration();
    const { items } = contexts[context.type];
    const searchPlaceholder = context.type === 'blankArea' ? 'Type in node name...' : 'Search...';

    // Flatten the items into a single array
    const searchItems = useMemo(() => {
      if (disabled || !canSearch) {
        return [];
      }

      const flattenItems = (
        items: readonly ContextMenuConfigItem[],
        path: string[] = [],
      ): (ContextMenuConfigItem & { path: string[] })[] => {
        const allItems = items.reduce(
          (acc, item) => {
            const newPath = [...path, item.label];
            return acc.concat({ ...item, path: newPath }, ...flattenItems(item.items || [], newPath));
          },
          [] as (ContextMenuConfigItem & { path: string[] })[],
        );

        const onlyLeaves = allItems.filter((item) => !item.items?.length);

        const allSearchItems = [...onlyLeaves, ...commands.map((command) => ({ ...command, path: [command.label] }))];

        return uniqBy(allSearchItems, 'id');
      };

      return flattenItems(items);
    }, [items, commands, disabled, canSearch]);

    const searchRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      update();
      if (canSearch) {
        searchRef.current?.focus();
      }
    }, [canSearch, displayOffset.x, displayOffset.y, update, x, y]);

    const handleMenuItemSelected = useStableCallback((id: string, data: unknown) => {
      onMenuItemSelected?.(id, data, context, { x, y });
    });

    const isSearching = canSearch && searchTerm.trim().length > 0;

    const searchResults = useFuseSearch(searchItems, searchTerm, ['label', 'subLabel'], { max: 5 });
    const searchResultsItems = useMemo(() => searchResults.map((r) => r.item), [searchResults]);

    const shownItemsNotSearching = useMemo(() => items.filter((item) => !isHiddenUntilSearched(item)), [items]);

    const visibleSearchItems = useMemo(
      () => searchResultsItems.filter((item) => isContextMenuItemVisible(item, context.data)),
      [context.data, searchResultsItems],
    );

    const searchPresentation = useMemo(
      () => (isSearching ? getContextMenuSearchPresentation(visibleSearchItems) : null),
      [isSearching, visibleSearchItems],
    );

    const visibleShownItems = useMemo(
      () =>
        isSearching
          ? [...(searchPresentation?.primaryItems ?? []), ...(searchPresentation?.graphItems ?? [])]
          : shownItemsNotSearching.filter((item) => isContextMenuItemVisible(item, context.data)),
      [context.data, isSearching, searchPresentation, shownItemsNotSearching],
    );

    const visibleShownItemIndexes = useMemo(
      () => new Map(visibleShownItems.map((item, index) => [item.id, index])),
      [visibleShownItems],
    );

    useEffect(() => {
      if (isSearching && visibleShownItems.length > 0 && selectedResultIndex >= visibleShownItems.length) {
        setSelectedResultIndex(0);
      }
    }, [isSearching, selectedResultIndex, visibleShownItems.length]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
          if (visibleShownItems.length > 0) {
            setSelectedResultIndex((prevIndex) => (prevIndex > 0 ? prevIndex - 1 : visibleShownItems.length - 1));
            e.preventDefault();
          }
          break;
        case 'ArrowDown':
          if (visibleShownItems.length > 0) {
            setSelectedResultIndex((prevIndex) => (prevIndex < visibleShownItems.length - 1 ? prevIndex + 1 : 0));
            e.preventDefault();
          }
          break;
        case 'Enter':
          e.preventDefault();
          {
            const selectedSearchItem = visibleShownItems[selectedResultIndex] as ContextMenuConfigItem | undefined;
            if (selectedSearchItem && !isContextMenuItemDisabled(selectedSearchItem, context.data)) {
              handleMenuItemSelected(selectedSearchItem.id, selectedSearchItem.data);
            }
          }
          break;
        default:
          break;
      }
    };
    useEffect(() => {
      if (disabled) {
        setSearchTerm('');
        setSelectedResultIndex(0);
        searchRef.current?.blur();
      } else if (canSearch) {
        searchRef.current?.focus();
      }
    }, [canSearch, disabled]);

    return (
      <div
        ref={anchorRef}
        css={menuReferenceStyles}
        style={{ top: y - displayOffset.y + 4, left: x - displayOffset.x - 16 }}
        className={clsx({ disabled })}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={floatingStyles} css={menuStyles} ref={refs.setFloating}>
          {canSearch && (
            <div className="context-menu-search">
              <input
                autoComplete="off"
                spellCheck={false}
                ref={searchRef}
                autoFocus
                placeholder={searchPlaceholder}
                value={searchTerm}
                onChange={(e) => setSearchTerm((e.target as HTMLInputElement).value)}
                onKeyDown={handleKeyDown}
                disabled={disabled}
              />
            </div>
          )}
          <div className="context-menu-items">
            {isSearching && searchPresentation ? (
              <>
                {searchPresentation.primaryItems.map((item, index) => (
                  <ContextMenuItem
                    key={item.id}
                    config={item}
                    showSeparator={index > 0 && (item as ContextMenuConfigItem).separatorBefore === true}
                    onMenuItemSelected={handleMenuItemSelected}
                    onHover={() => setSelectedResultIndex(visibleShownItemIndexes.get(item.id) ?? 0)}
                    context={context.data}
                    active={visibleShownItems[selectedResultIndex]?.id === item.id}
                  />
                ))}
                {searchPresentation.graphItems.length > 0 && (
                  <div className="context-menu-search-section-header">Go to graphs</div>
                )}
                {searchPresentation.graphItems.map((item) => (
                  <ContextMenuItem
                    key={item.id}
                    config={item}
                    showSeparator={false}
                    onMenuItemSelected={handleMenuItemSelected}
                    onHover={() => setSelectedResultIndex(visibleShownItemIndexes.get(item.id) ?? 0)}
                    context={context.data}
                    active={visibleShownItems[selectedResultIndex]?.id === item.id}
                  />
                ))}
              </>
            ) : (
              visibleShownItems.map((item, index) => (
                <ContextMenuItem
                  key={item.id}
                  config={item}
                  showSeparator={index > 0 && (item as ContextMenuConfigItem).separatorBefore === true}
                  onMenuItemSelected={handleMenuItemSelected}
                  onHover={() => setSelectedResultIndex(index)}
                  context={context.data}
                  active={isSearching && visibleShownItems[selectedResultIndex]?.id === item.id}
                />
              ))
            )}
          </div>
        </div>
      </div>
    );
  },
);

ContextMenu.displayName = 'ContextMenu';

export const submenuStyles = css`
  ${popupMenuListStyles};
  position: absolute;
  top: 0;
  left: 95%;
  margin-left: 4px;
  margin-top: -4px;
  z-index: 1;

  &.submenu-enter {
    opacity: 0;
  }

  &.submenu-enter-active {
    opacity: 1;
    transition: opacity 100ms ease-out;
  }

  &.submenu-exit {
    opacity: 1;
  }

  &.submenu-exit-active {
    opacity: 0;
    transition: opacity 100ms ease-out;
  }
`;

const infoBoxTransitionStyles = css`
  &.info-box-enter {
    opacity: 0;
  }

  &.info-box-enter-active {
    opacity: 1;
    transition: opacity 100ms ease-out;
  }

  &.info-box-exit {
    opacity: 1;
  }

  &.info-box-exit-active {
    opacity: 0;
    transition: opacity 100ms ease-out;
  }
`;

export const ContextMenuItemDiv = styled.div<{
  hasSubmenu?: boolean;
  tone?: 'default' | 'danger';
  isDisabled?: boolean;
  showSeparator?: boolean;
}>`
  position: relative;
  ${popupMenuRowStyles};
  justify-content: space-between;
  white-space: nowrap;
  transition:
    background-color 0.1s ease-out,
    border-color 0.1s ease-out,
    color 0.1s ease-out;

  ${(props) =>
    props.showSeparator &&
    css`
      ${popupMenuSeparatedRowStyles};
    `}

  .label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    user-select: none;
  }

  .label > svg {
    ${popupMenuIconSlotStyles};
  }

  .context-menu-label-text {
    ${popupMenuLabelStyles};
  }

  .label-area.has-sublabel {
    padding-block: calc((2.8em - 1.2em) / 2);
  }

  .sublabel {
    font-size: var(--ui-font-size-sm);
    color: var(--grey-lightish);
    line-height: 1.25;
    margin-top: 0.55em;
    max-width: calc(280px * var(--ui-font-scale));
    white-space: normal;
  }

  ${(props) =>
    props.tone === 'danger' &&
    css`
      color: var(--error);

      .sublabel {
        color: var(--error-light);
      }
    `}

  &:hover,
  &.active {
    background-color: var(--popup-menu-row-hover-bg);
    color: var(--grey-lightest);
  }

  ${(props) =>
    props.isDisabled &&
    css`
      cursor: not-allowed;
      opacity: 0.6;

      &:hover,
      &.active {
        background-color: transparent;
        color: inherit;
      }
    `}

  ${(props) =>
    props.tone === 'danger' &&
    css`
      &:hover,
      &.active {
        background-color: var(--popup-menu-row-hover-bg);
        color: var(--error-light);
      }
    `}

  ${(props) =>
    props.isDisabled &&
    props.tone === 'danger' &&
    css`
      &:hover,
      &.active {
        color: var(--error);
      }
    `}

  ${(props) =>
    props.hasSubmenu &&
    css`
      &::after {
        content: '';
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        width: 0;
        height: 0;
        border-style: solid;
        border-width: 7px 0 7px 7px;
        border-color: transparent transparent transparent var(--grey-darkish);
      }

      &:hover::after {
        border-color: transparent transparent transparent var(--primary);
      }
    `}

  ${(props) =>
    props.isDisabled &&
    props.hasSubmenu &&
    css`
      &:hover::after {
        border-color: transparent transparent transparent var(--grey-darkish);
      }
    `}
`;

export interface ContextMenuItemProps {
  config: ContextMenuConfigItem;
  context: unknown;
  active?: boolean;
  showSeparator?: boolean;
  onMenuItemSelected?: (id: string, data: unknown) => void;
  onHover?: () => void;
}

export const ContextMenuItem: FC<ContextMenuItemProps> = ({
  config,
  context,
  active,
  showSeparator,
  onMenuItemSelected,
  onHover,
}) => {
  const [isSubMenuVisible, setIsSubMenuVisible] = useState(false);
  const [isInfoVisible, setIsInfoVisible] = useState(false);
  const hasSubMenu = (config.items?.length ?? 0) > 0;
  const isDisabled = isContextMenuItemDisabled(config, context);
  const subLabel = config.subLabel ?? (isDisabled ? getContextMenuItemDisabledReason(config, context) : undefined);
  const submenuFloating = useFloating({
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [flip()],
  });

  const infoBoxFloating = useFloating({
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [flip()],
  });

  const handleMouseEnter = useStableCallback(() => {
    if (hasSubMenu && !isDisabled) {
      setIsSubMenuVisible(true);
    }
    setIsInfoVisible(!isDisabled);
    onHover?.();
  });

  const handleMouseLeave = useStableCallback(() => {
    if (hasSubMenu) {
      setIsSubMenuVisible(false);
    }
    setIsInfoVisible(false);
  });

  const handleClick = () => {
    if (hasSubMenu || isDisabled) {
      return;
    }

    onMenuItemSelected?.(config.id, config.data);
  };

  const mainRef = useMergeRefs([submenuFloating.refs.setReference, infoBoxFloating.refs.setReference]);

  if (config.conditional && !config.conditional(context)) {
    return null;
  }

  return (
    <ContextMenuItemDiv
      hasSubmenu={hasSubMenu}
      tone={config.tone}
      isDisabled={isDisabled}
      showSeparator={showSeparator}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      ref={mainRef}
      className={clsx({ active: active && !isDisabled, disabled: isDisabled })}
    >
      <div className={clsx('label-area', { 'has-sublabel': subLabel })}>
        <div className="label">
          {config.icon && <config.icon />}
          <span className="context-menu-label-text">{config.label}</span>
        </div>
        {subLabel && <div className="sublabel">{subLabel}</div>}
      </div>

      <CSSTransition
        nodeRef={submenuFloating.refs.floating}
        in={isSubMenuVisible}
        timeout={100}
        classNames="submenu"
        unmountOnExit
      >
        <div ref={submenuFloating.refs.setFloating} css={submenuStyles} style={submenuFloating.floatingStyles}>
          {hasSubMenu &&
            config.items!.map((subItem, index) => (
              <ContextMenuItem
                key={subItem.id}
                config={subItem}
                showSeparator={index > 0 && (subItem as ContextMenuConfigItem).separatorBefore === true}
                onMenuItemSelected={onMenuItemSelected}
                context={context}
              />
            ))}
        </div>
      </CSSTransition>
      {config.infoBox && (
        <CSSTransition
          nodeRef={infoBoxFloating.refs.floating}
          in={isInfoVisible || active}
          timeout={100}
          classNames="info-box"
          unmountOnExit
        >
          <div
            ref={infoBoxFloating.refs.setFloating}
            css={infoBoxTransitionStyles}
            style={infoBoxFloating.floatingStyles}
          >
            <ContextMenuInfoBox info={config.infoBox} />
          </div>
        </CSSTransition>
      )}
    </ContextMenuItemDiv>
  );
};

const contextMenuInfoBoxStyles = css`
  ${popupMenuSurfaceStyles};
  z-index: 1;
  padding: 16px 16px;
  width: 500px;
  font-family: var(--font-family);
  white-space: normal;

  img {
    float: right;
    max-width: 250px;
    margin: 8px;
  }

  h1 {
    font-size: var(--ui-font-size-lg);
    margin-top: 0;
  }

  p {
    font-size: var(--ui-font-size-compact);
  }
`;

const ContextMenuInfoBox: FC<{ info: NonNullable<ContextMenuConfigItem['infoBox']> }> = ({ info }) => {
  const markdownDescription = useMarkdown(info.description);
  return (
    <div css={contextMenuInfoBoxStyles}>
      {info.image && <img src={info.image} alt="" />}
      <h1>{info.title}</h1>
      <p dangerouslySetInnerHTML={markdownDescription} />
      <div style={{ clear: 'right' }} />
    </div>
  );
};
