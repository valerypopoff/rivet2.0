import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import { type FC } from 'react';
import { useOpenUrl } from '../../../../rivet/packages/app/src/hooks/useOpenUrl';
import DiscordIcon from '../../../../rivet/packages/app/src/assets/vendor_logos/discord-mark-white.svg?react';
import GearIcon from 'majesticons/line/settings-cog-line.svg?react';
import RivetIcon from '../../../../rivet/packages/app/src/rivet-logo-1024-full.png';
import { useSetAtom } from 'jotai';
import { newProjectModalOpenState } from '../../../../rivet/packages/app/src/state/ui';
import { settingsModalOpenState } from '../../../../rivet/packages/app/src/components/SettingsModal';
import { useLoadProjectWithFileBrowser } from '../../../../rivet/packages/app/src/hooks/useLoadProjectWithFileBrowser';
import { syncWrapper } from '../../../../rivet/packages/app/src/utils/syncWrapper';

const styles = css`
  background: var(--grey-darker);
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  .inner {
    position: relative;
    background: var(--grey-dark);
    color: var(--grey-light);
    width: min(75vh, calc(100% - 80px));
    height: 50vh;
    padding: 50px;
    min-width: 600px;
    min-height: 400px;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  h1 {
    margin: 0;
  }

  .inner > ul {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 20px;

    > li {
      border-left: 4px solid var(--grey-light);
      padding-left: 8px;

      p {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      a {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
    }
  }

  .logo {
    position: absolute;
    right: 50px;
    top: 50px;
    width: 100px;
  }

  .open-settings {
    position: absolute;
    top: 0;
    right: 0;
    width: 64px;
    height: 64px;
    display: flex;
  }
`;

export const NoProject: FC = () => {
  const openDocumentation = useOpenUrl('https://github.com/valerypopoff/rivet2.0');
  const joinDiscord = useOpenUrl('https://discord.gg/qT8B2gv9Mg');
  const setNewProjectModalOpen = useSetAtom(newProjectModalOpenState);
  const setSettingsModalOpen = useSetAtom(settingsModalOpenState);
  const openProject = useLoadProjectWithFileBrowser();

  return (
    <div css={styles}>
      <div className="inner">
        <img src={RivetIcon} alt="Rivet Logo" className="logo" />
        <Button className="open-settings" onClick={() => setSettingsModalOpen(true)}>
          <GearIcon />
        </Button>
        <h1>Welcome to Rivet!</h1>
        <p>Select a workflow from the left panel, or you can:</p>

        <ul>
          <li>
            <Button appearance="primary" onClick={syncWrapper(openProject)}>
              Open
            </Button>{' '}
            an existing project by path
          </li>
          <li>
            <Button appearance="primary" onClick={() => setNewProjectModalOpen(true)}>
              Create
            </Button>{' '}
            a temporary scratch project
          </li>
          <li>
            <p>
              Check out the{' '}
              <a href="#" onClick={syncWrapper(openDocumentation)}>
                Rivet documentation
              </a>
            </p>
          </li>
          <li>
            <p>
              Need help? join the{' '}
              <a href="#" onClick={syncWrapper(joinDiscord)}>
                <DiscordIcon /> Discord Server
              </a>{' '}
              for ideas, support, and community
            </p>
          </li>
        </ul>
      </div>
    </div>
  );
};
