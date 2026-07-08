import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const settingsDir = dirname(fileURLToPath(import.meta.url));

test('settings section field spacing is bottom-owned', () => {
  const source = readFileSync(join(settingsDir, 'settingsPageStyles.ts'), 'utf8');

  assert.match(source, /--settings-section-gap: calc\(24px \* var\(--ui-font-scale\)\);/);
  assert.match(source, /display: flex;[\s\S]*flex-direction: column;[\s\S]*gap: var\(--settings-field-gap\);/);
  assert.match(source, /\.settings-section \+ \.settings-section \{[\s\S]*margin-top: var\(--settings-section-gap\);/);
  assert.match(source, /\.settings-section-fields \{[\s\S]*gap: 0;/);
  assert.match(source, /\.settings-section-fields > \* \{[\s\S]*margin-top: 0 !important;[\s\S]*margin-bottom: var\(--settings-field-gap\);/);
  assert.match(source, /\.settings-section-fields > :last-child \{[\s\S]*margin-bottom: 0;/);
});

test('settings range fields use theme-owned dark range tokens', () => {
  const source = readFileSync(join(settingsDir, 'settingsPageStyles.ts'), 'utf8');
  const uiSettingsPageSource = readFileSync(join(settingsDir, 'pages', 'UiSettingsPage.tsx'), 'utf8');

  assert.match(source, /\.settings-range-field \{[\s\S]*--ds-background-neutral: var\(--settings-range-track-bg\);/);
  assert.match(
    source,
    /\.settings-range-field \{[\s\S]*--ds-background-neutral-bold: var\(--settings-range-fill-bg\);/,
  );
  assert.equal(uiSettingsPageSource.match(/className="toggle-field settings-range-field"/g)?.length, 3);
});
