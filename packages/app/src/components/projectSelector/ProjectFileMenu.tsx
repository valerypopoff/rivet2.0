import { Fragment, useEffect, useRef, useState, type FC } from 'react';

import clsx from 'clsx';

import RivetLogo from '../../rivet-2-logo-no-background.svg';
import { useRunMenuCommand } from '../../hooks/useMenuCommands.js';
import { useRivetAppHostUiConfig } from '../../providers/HostUiConfigContext.js';
import { getVisibleFileMenuGroups } from '../../utils/fileMenuConfiguration.js';

export const ProjectFileMenu: FC = () => {
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const runMenuCommandImpl = useRunMenuCommand();
  const hostUiConfig = useRivetAppHostUiConfig();
  const visibleFileMenuGroups = getVisibleFileMenuGroups(hostUiConfig.fileMenu);

  const runMenuCommand: typeof runMenuCommandImpl = (command) => {
    setFileMenuOpen(false);
    runMenuCommandImpl(command);
  };

  useEffect(() => {
    if (!fileMenuOpen) {
      return;
    }

    const handleWindowMouseDown = (event: MouseEvent) => {
      if (fileMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setFileMenuOpen(false);
    };

    window.addEventListener('mousedown', handleWindowMouseDown);

    return () => {
      window.removeEventListener('mousedown', handleWindowMouseDown);
    };
  }, [fileMenuOpen]);

  if (visibleFileMenuGroups.length === 0) {
    return null;
  }

  return (
    <div ref={fileMenuRef} className={clsx('file-menu', { open: fileMenuOpen })}>
      <button
        type="button"
        className="file-menu-button dropdown-item"
        aria-expanded={fileMenuOpen}
        aria-haspopup="menu"
        onClick={() => setFileMenuOpen((open) => !open)}
      >
        <img src={RivetLogo} alt="" aria-hidden="true" className="file-menu-logo" />
        Menu
      </button>
      <div className={clsx('file-dropdown', { open: fileMenuOpen })} role="menu">
        {visibleFileMenuGroups.map((group, groupIndex) => (
          <Fragment key={group.map((item) => item.id).join(':')}>
            {groupIndex > 0 && <div className="file-dropdown-separator" role="separator" />}
            {group.map((item) => (
              <button key={item.id} type="button" role="menuitem" onClick={() => runMenuCommand(item.id)}>
                {item.label}
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
};
