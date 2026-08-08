import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import { type FC, type MouseEvent } from 'react';
import { useOpenUrl } from '../hooks/useOpenUrl';
import RivetIcon from '../rivet-2-logo-no-background.svg';
import { useSetAtom } from 'jotai';
import { newProjectModalOpenState } from '../state/ui';
import { settingsModalOpenState } from './SettingsModal';
import { useLoadProjectWithFileBrowser } from '../hooks/useLoadProjectWithFileBrowser';
import { wrapAsync } from '../utils/errorHandling';

const styles = css`
  background: var(--grey-darker);
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  padding: calc(var(--project-selector-height) + 48px) 32px 48px;
  display: flex;
  align-items: center;
  justify-content: center;

  .inner {
    transform: translateY(-3em);
    color: var(--grey-light);
    width: min(680px, 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    text-align: center;
  }

  h1 {
    margin: 0;
    color: var(--grey-lightest);
    font-size: calc(var(--ui-font-size-2xl) + 4px);
    line-height: 1.1;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    margin: 12px 0 18px;
  }

  .inner > ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;

    > li {
      min-height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;

      p {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        margin: 0;
      }

      a {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
    }
  }

  .logo {
    filter: var(--rivet-logo-filter);
    width: 92px;
    margin-bottom: 6px;
  }
`;

export const NoProject: FC = () => {
  const openDocumentation = useOpenUrl('https://valerypopoff.github.io/rivet2.0/user-guide');
  const setNewProjectModalOpen = useSetAtom(newProjectModalOpenState);
  const setSettingsModalOpen = useSetAtom(settingsModalOpenState);
  const openProject = useLoadProjectWithFileBrowser();

  const openSettings = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setSettingsModalOpen(true);
  };

  return (
    <div css={styles}>
      <div className="inner">
        <img src={RivetIcon} alt="Rivet Logo" className="logo" />
        <h1>Welcome to Rivet 2</h1>

        <div className="actions">
          <Button appearance="default" onClick={wrapAsync(openProject, 'Open project')}>
            Open project
          </Button>
          <Button appearance="primary" onClick={() => setNewProjectModalOpen(true)}>
            Create new project
          </Button>
        </div>

        <ul>
          <li>
            <p>
              Check out the{' '}
              <a href="#" onClick={openDocumentation}>
                Rivet 2 documentation
              </a>
            </p>
          </li>
          <li>
            <p>
              Open{' '}
              <a href="#" onClick={openSettings}>
                Settings
              </a>{' '}
              to configure providers, plugins, and UI preferences
            </p>
          </li>
        </ul>
      </div>
    </div>
  );
};
