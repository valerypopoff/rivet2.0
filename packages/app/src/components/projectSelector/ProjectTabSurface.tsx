import { type FC, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import { type SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import clsx from 'clsx';

export const ProjectTabSurface: FC<{
  active: boolean;
  className?: string;
  closeIcon: ReactNode;
  displayName?: string;
  leadingIcon?: ReactNode;
  dragListeners?: SyntheticListenerMap;
  hasUnsavedChanges?: boolean;
  preview?: boolean;
  unsaved?: boolean;
  onCloseProject?: () => void;
  onSelectProject?: () => void;
}> = ({
  active,
  className,
  closeIcon,
  displayName,
  leadingIcon,
  dragListeners,
  hasUnsavedChanges = false,
  onCloseProject,
  onSelectProject,
  preview = false,
  unsaved = false,
}) => {
  const closeProject = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onCloseProject?.();
  };

  return (
    <div
      className={clsx('project', className, { active, preview, unsaved, 'has-unsaved-changes': hasUnsavedChanges })}
      onClick={onSelectProject}
    >
      <div className="project-name" {...dragListeners}>
        {leadingIcon}
        <span>{displayName}</span>
      </div>
      {onCloseProject && (
        <div className="actions">
          <button
            aria-label={`Close ${displayName}`}
            className="close-project"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={closeProject}
          >
            {closeIcon}
          </button>
        </div>
      )}
    </div>
  );
};
