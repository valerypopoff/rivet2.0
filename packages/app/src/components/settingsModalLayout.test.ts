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
  assert.match(
    source,
    /\.settings-modal-sidebar \{[\s\S]*max-height: 100%;[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/,
  );
  assert.match(source, /\.settings-modal-nav \{[\s\S]*display: flex;[\s\S]*gap: 2px;/);
  assert.match(
    source,
    /<aside className="settings-modal-sidebar">[\s\S]*<nav className="settings-modal-nav" aria-label="Settings">/,
  );
  assert.doesNotMatch(source, /@atlaskit\/side-navigation/);
  assert.doesNotMatch(source, /<SideNavigation|<NavigationContent|<ButtonItem/);
  assert.match(source, /const SettingsNavButton: FC/);
  assert.match(
    source,
    /<SettingsNavButton isSelected=\{page === 'llm'\} onClick=\{\(\) => setPage\('llm'\)\}>[\s\S]*LLM/,
  );
  assert.match(source, /\.with\('llm', \(\) => <LlmSettingsPage \/>/);
  assert.doesNotMatch(source, /OpenAiSettingsPage/);
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

test('LLM settings page explains where provider keys are used', () => {
  const source = readFileSync(join(componentsDir, 'settings/pages/LlmSettingsPage.tsx'), 'utf8');

  assert.match(source, /className="settings-section-heading">Generate using AI/);
  assert.match(source, /Choose the provider and model used by the &quot;Generate using AI&quot; feature/);
  assert.match(source, /label="Drafting provider"/);
  assert.match(source, /options=\{aiAssistProviderOptions\}/);
  assert.match(source, /label="Drafting model"/);
  assert.match(source, /options=\{assistModelOptions\}/);
  assert.match(source, /className="ai-assist-model-control"/);
  assert.match(source, /Re-fetch Model List/);
  assert.doesNotMatch(source, /\.ai-assist-refresh-models \{[\s\S]*min-height:/);
  assert.match(source, /chatV2ModelCatalogService\.refresh/);
  assert.match(source, /modelCatalogSession\.status/);
  assert.match(source, /ai-assist-refresh-status/);
  assert.match(source, /selectedAssistProvider === 'custom'/);
  assert.match(source, /Custom provider API URL/);
  assert.match(source, /Custom provider model/);
  assert.match(source, /className="settings-section-heading">LLM credentials/);
  assert.match(source, /These credentials can be used by LLM-powered nodes and the Rivet editor/);
  assert.match(source, /They are not saved into project YAML/);
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /ANTHROPIC_API_KEY/);
  assert.match(source, /GOOGLE_GENERATIVE_AI_API_KEY/);
  assert.match(source, /CUSTOM_PROVIDER_API_KEY/);
  assert.match(source, /OPENAI_ORG_ID/);
  assert.match(source, /matching runtime keys\s+when running projects programmatically/);
  assert.match(source, /<Field name="openai-api-key" label="OpenAI API Key">[\s\S]*value=\{settings\.openAiApiKey \|\| settings\.openAiKey \|\| ''\}/);
  assert.match(source, /<Field name="anthropic-api-key" label="Anthropic API Key">/);
  assert.match(source, /<Field name="google-api-key" label="Google API Key">/);
  assert.match(source, /<Field name="custom-provider-api-key" label="Custom provider API Key">/);
  assert.match(source, /<Field name="openai-organization" label="OpenAI Organization">/);
  assert.doesNotMatch(source, /CUSTOM_AI_API_KEY/);
  assert.doesNotMatch(source, /LLM timeout \(ms\)/);
  assert.doesNotMatch(source, /OpenAI-compatible endpoint/);
  assert.doesNotMatch(source, /Chat node headers/);
  assert.doesNotMatch(source, /Configure For LM Studio/);
});
