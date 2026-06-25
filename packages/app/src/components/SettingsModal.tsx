import { type FC, useState } from 'react';
import { atom, useAtom } from 'jotai';
import Modal, { ModalTransition, ModalBody } from '@atlaskit/modal-dialog';
import { Global, css } from '@emotion/react';
import { P, match } from 'ts-pattern';
import { useDependsOnPlugins } from '../hooks/useDependsOnPlugins';
import {
  CustomPluginsSettingsPage,
  GeneralSettingsPage,
  GraphsSettingsPage,
  OpenAiSettingsPage,
  PluginsCatalogPage,
  PluginsSettingsPage,
  UiSettingsPage,
  UpdatesSettingsPage,
} from './settings/SettingsPages';
import { AppModalHeader } from './AppModalHeader';

interface SettingsModalProps {}

export const settingsModalOpenState = atom(false);

const SETTINGS_MODAL_HEIGHT = 'calc(100vh - 48px)';

const settingsModalScrollContainerOverrides = css`
  [data-testid='settings-modal--scrollable'] {
    min-height: 0;
    overflow: hidden;
  }

  [data-testid='settings-modal--body'] {
    display: flex;
    min-height: 0;
    min-width: 0;
  }
`;

const modalBody = css`
  flex: 1 1 auto;
  height: 100%;
  min-height: 300px;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  min-width: 0;
  overflow: hidden;

  .settings-modal-sidebar {
    align-self: stretch;
    background-color: var(--modal-sidebar-bg);
    border-right: 1px solid var(--modal-border);
    max-height: 100%;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 8px;
  }

  .settings-modal-nav {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  main {
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 0 30px 30px 30px;
  }

  main:not(.fill-page) > * {
    width: 100%;
    max-width: 850px;
  }

  main.fill-page {
    display: flex;
    flex-direction: column;
    overflow: hidden;

    > * {
      flex: 1 1 auto;
      min-height: 0;
    }
  }
`;

type DefaultPages = 'general' | 'graphs' | 'ui' | 'openai' | 'plugins' | 'pluginsSettings' | 'updates';
type Pages = DefaultPages | string;

const settingsNavButtonStyles = css`
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: calc(32px * var(--ui-font-scale));
  align-items: center;
  justify-content: flex-start;
  border: 0;
  border-radius: var(--ui-button-radius-sm);
  background: transparent;
  color: var(--foreground);
  cursor: pointer;
  font-family: var(--font-family);
  font-size: var(--ui-font-size-base);
  line-height: 1.25;
  padding: 0 calc(10px * var(--ui-font-scale));
  text-align: left;

  > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover,
  &:focus-visible {
    background: color-mix(in srgb, var(--primary) 8%, transparent);
    color: var(--foreground-bright);
    outline: none;
  }

  &[aria-current='page'] {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary);
  }

  &[aria-current='page']:hover,
  &[aria-current='page']:focus-visible {
    background: color-mix(in srgb, var(--primary) 16%, transparent);
  }
`;

const SettingsNavButton: FC<{
  isSelected: boolean;
  onClick: () => void;
  children: string;
}> = ({ isSelected, onClick, children }) => (
  <button type="button" css={settingsNavButtonStyles} aria-current={isSelected ? 'page' : undefined} onClick={onClick}>
    <span>{children}</span>
  </button>
);

export const SettingsModal: FC<SettingsModalProps> = () => {
  const [isOpen, setIsOpen] = useAtom(settingsModalOpenState);
  const [page, setPage] = useState<Pages>('general');
  const plugins = useDependsOnPlugins();

  const pluginsWithCustomPages = plugins.filter((plugin) => plugin.configPage !== undefined);
  const customPluginsPages = Object.fromEntries(
    pluginsWithCustomPages.map((plugin) => [
      plugin.id,
      <CustomPluginsSettingsPage key={plugin.id} pluginId={plugin.id} />,
    ]),
  );

  return (
    <ModalTransition>
      {isOpen && (
        <Modal onClose={() => setIsOpen(false)} width="80%" height={SETTINGS_MODAL_HEIGHT} testId="settings-modal">
          <Global styles={settingsModalScrollContainerOverrides} />
          <AppModalHeader title="Settings" onClose={() => setIsOpen(false)} />
          <ModalBody>
            <div css={modalBody}>
              <aside className="settings-modal-sidebar">
                <nav className="settings-modal-nav" aria-label="Settings">
                  <SettingsNavButton isSelected={page === 'general'} onClick={() => setPage('general')}>
                    General
                  </SettingsNavButton>
                  <SettingsNavButton isSelected={page === 'graphs'} onClick={() => setPage('graphs')}>
                    Graphs
                  </SettingsNavButton>
                  <SettingsNavButton isSelected={page === 'ui'} onClick={() => setPage('ui')}>
                    UI
                  </SettingsNavButton>
                  <SettingsNavButton isSelected={page === 'openai'} onClick={() => setPage('openai')}>
                    OpenAI
                  </SettingsNavButton>
                  <SettingsNavButton isSelected={page === 'plugins'} onClick={() => setPage('plugins')}>
                    Plugins
                  </SettingsNavButton>
                  <SettingsNavButton isSelected={page === 'pluginsSettings'} onClick={() => setPage('pluginsSettings')}>
                    Plugins settings
                  </SettingsNavButton>
                  <SettingsNavButton isSelected={page === 'updates'} onClick={() => setPage('updates')}>
                    Updates
                  </SettingsNavButton>
                  {pluginsWithCustomPages.map((plugin) => (
                    <SettingsNavButton key={plugin.id} isSelected={page === plugin.id} onClick={() => setPage(plugin.id)}>
                      {plugin.configPage!.label}
                    </SettingsNavButton>
                  ))}
                </nav>
              </aside>
              <main className={page === 'plugins' ? 'fill-page' : undefined}>
                {match(page)
                  .with('general', () => <GeneralSettingsPage />)
                  .with('graphs', () => <GraphsSettingsPage />)
                  .with('ui', () => <UiSettingsPage />)
                  .with('openai', () => <OpenAiSettingsPage />)
                  .with('plugins', () => <PluginsCatalogPage />)
                  .with('pluginsSettings', () => <PluginsSettingsPage />)
                  .with('updates', () => <UpdatesSettingsPage />)
                  .with(P.string, (id) => customPluginsPages[id])
                  .exhaustive()}
              </main>
            </div>
          </ModalBody>
        </Modal>
      )}
    </ModalTransition>
  );
};
