import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodeEditorCapabilities } from './editorCapabilityModel.js';

test('editor capabilities preserve existing defaults behind one model', () => {
  assert.deepEqual(
    resolveCodeEditorCapabilities({
      enableSpellcheckAction: true,
      interpolationSyntax: 'json-template',
      language: 'markdown',
    }),
    {
      commentHighlighting: true,
      definitionNavigation: true,
      interpolation: 'json-template',
      spellcheckAction: true,
      textTools: true,
    },
  );
});

test('editor capability overrides can disable features independently', () => {
  assert.deepEqual(
    resolveCodeEditorCapabilities({
      capabilities: {
        commentHighlighting: false,
        definitionNavigation: false,
        interpolation: false,
        spellcheckAction: false,
        textTools: false,
      },
      enableSpellcheckAction: true,
      interpolationSyntax: 'json-template',
      language: 'javascript',
    }),
    {
      commentHighlighting: false,
      definitionNavigation: false,
      interpolation: undefined,
      spellcheckAction: false,
      textTools: false,
    },
  );
});
