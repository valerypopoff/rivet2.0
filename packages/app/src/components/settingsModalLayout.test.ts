import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('SettingsModal uses independent viewport-capped column scrolling', () => {
  const source = readFileSync(join(componentsDir, 'SettingsModal.tsx'), 'utf8');
  const appModalHeaderSource = readFileSync(join(componentsDir, 'AppModalHeader.tsx'), 'utf8');

  assert.match(source, /const SETTINGS_MODAL_HEIGHT = 'calc\(100vh - 48px\)'/);
  assert.match(source, /height=\{SETTINGS_MODAL_HEIGHT\}/);
  assert.match(source, /testId="settings-modal"/);
  assert.doesNotMatch(source, /height="80%"/);
  assert.match(source, /\[data-testid='settings-modal--scrollable'\] \{[\s\S]*overflow: hidden;/);
  assert.match(source, /\[data-testid='settings-modal--body'\] \{[\s\S]*display: flex;[\s\S]*min-height: 0;/);
  assert.match(source, /const settingsModalScrollContainerOverrides = css`/);
  assert.match(source, /<Global styles=\{settingsModalScrollContainerOverrides\} \/>/);
  assert.match(source, /const modalBody = css`[\s\S]*flex: 1 1 auto;[\s\S]*height: 100%;/);
  assert.match(source, /\.settings-modal-sidebar \{[\s\S]*background-color: var\(--modal-sidebar-bg\);/);
  assert.match(source, /\.settings-modal-sidebar \{[\s\S]*border-right: 1px solid var\(--modal-border\);/);
  assert.match(source, /\.settings-modal-sidebar \{[\s\S]*max-height: 100%;[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/);
  assert.match(source, /\.settings-modal-nav \{[\s\S]*display: flex;[\s\S]*gap: 2px;/);
  assert.match(source, /<aside className="settings-modal-sidebar">[\s\S]*<nav className="settings-modal-nav" aria-label="Settings">/);
  assert.doesNotMatch(source, /@atlaskit\/side-navigation/);
  assert.doesNotMatch(source, /<SideNavigation|<NavigationContent|<ButtonItem/);
  assert.match(source, /const SettingsNavButton: FC/);
  assert.match(source, /aria-current=\{isSelected \? 'page' : undefined\}/);
  assert.match(source, /&\[aria-current='page'\] \{[\s\S]*color: var\(--primary\);/);
  assert.match(source, /> span \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
  assert.match(source, /main \{[\s\S]*height: 100%;[\s\S]*overflow: auto;/);
  assert.match(source, /main:not\(\.fill-page\) > \* \{[\s\S]*max-width: 850px;/);
  assert.match(source, /overflow: hidden;/);
  assert.doesNotMatch(appModalHeaderSource, /@atlaskit\/button/);
  assert.doesNotMatch(appModalHeaderSource, /appearance="link"/);
  assert.match(
    appModalHeaderSource,
    /<button type="button" css=\{modalHeaderCloseButtonStyles\} aria-label="Close modal" onClick=\{onClose\}>/,
  );
  assert.match(appModalHeaderSource, /const modalHeaderCloseButtonStyles = css`[\s\S]*color: var\(--primary\);/);
  assert.match(appModalHeaderSource, /&:hover,[\s\S]*&:focus-visible \{[\s\S]*color: var\(--primary-light\);/);
  assert.match(appModalHeaderSource, /<CrossIcon label="Close Modal" primaryColor="currentColor" \/>/);
});
