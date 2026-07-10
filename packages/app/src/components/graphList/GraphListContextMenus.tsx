import Portal from '@atlaskit/portal';
import { css } from '@emotion/react';
import type { CSSProperties, FC, RefCallback } from 'react';
import { PopupMenuItem, popupMenuListStyles } from '../PopupMenu.js';
import type { GraphListContextMenuItem } from './graphListContextMenu.js';

const contextMenuStyles = css`
  ${popupMenuListStyles};
  z-index: 1;

  .context-menu-items {
    display: flex;
    flex-direction: column;
  }
`;

type MenuDefinition = {
  className: string;
  items: GraphListContextMenuItem[];
  onSelected(id: string): void;
  visible: boolean;
};

export const GraphListContextMenus: FC<{
  floatingStyles: CSSProperties;
  menus: MenuDefinition[];
  setFloatingMenu: RefCallback<HTMLElement> | null;
}> = ({ floatingStyles, menus, setFloatingMenu }) => (
  <Portal>
    {menus.map(
      (menu, index) =>
        menu.visible && (
          <div
            key={`${menu.className}-${index}`}
            className={menu.className}
            css={contextMenuStyles}
            style={{ ...floatingStyles, zIndex: 500 }}
            ref={setFloatingMenu}
          >
            <div className="context-menu-items">
              {menu.items.map((item, index) => (
                <PopupMenuItem
                  key={item.id}
                  icon={item.icon}
                  separatorBefore={index > 0 && item.separatorBefore === true}
                  tone={item.tone}
                  onClick={() => menu.onSelected(item.id)}
                >
                  {item.label}
                </PopupMenuItem>
              ))}
            </div>
          </div>
        ),
    )}
  </Portal>
);
