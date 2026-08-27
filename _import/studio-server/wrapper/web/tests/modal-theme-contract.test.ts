import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sharedModalTheme = readFileSync(new URL('../dashboard/WorkflowLibraryPanel.css', import.meta.url), 'utf8');

const hostedModals = [
  ['../dashboard/AppSettingsModal.tsx', 'app-settings-modal'],
  ['../dashboard/ProjectSettingsModal.tsx', 'workflow-project-settings-modal'],
  ['../dashboard/RunRecordingsModal.tsx', 'run-recordings-modal'],
  ['../dashboard/RunStatisticsModal.tsx', 'run-statistics-modal'],
  ['../dashboard/RuntimeLibrariesModal.tsx', 'runtime-libraries-modal'],
  ['../dashboard/WorkflowProjectVersionModal.tsx', 'workflow-project-version-modal'],
  ['../dashboard/WorkflowPublishedVersionHistoryModal.tsx', 'workflow-published-version-history-modal'],
] as const;

test('every hosted modal uses the shared dark overlay and dialog theme', () => {
  for (const [sourcePath, testId] of hostedModals) {
    const source = readFileSync(new URL(sourcePath, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`testId=["']${testId}["']`), `${sourcePath} should keep its stable ModalDialog test ID.`);

    for (const suffix of ['--blanket', '', '--header', '--body']) {
      assert.ok(
        sharedModalTheme.includes(`[data-testid='${testId}${suffix}']`),
        `${testId}${suffix} should use the shared hosted modal theme.`,
      );
    }
  }

  assert.match(sharedModalTheme, /background: rgba\(0, 0, 0, 0\.56\) !important;/);
  assert.match(sharedModalTheme, /backdrop-filter: blur\(2px\);/);
  assert.match(sharedModalTheme, /background: #1f1f22 !important;/);
});
