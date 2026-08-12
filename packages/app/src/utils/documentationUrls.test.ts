import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  getBuiltInPluginDocumentationUrl,
  TRIVET_DOCUMENTATION_URL,
  USER_GUIDE_URL,
} from './documentationUrls.js';

test('user-facing guide links use the published User Guide route', () => {
  assert.equal(USER_GUIDE_URL, 'https://valerypopoff.github.io/rivet2.0/user-guide');
  assert.equal(TRIVET_DOCUMENTATION_URL, 'https://valerypopoff.github.io/rivet2.0/user-guide/trivet-getting-started');
  assert.equal(
    getBuiltInPluginDocumentationUrl('assemblyai'),
    'https://valerypopoff.github.io/rivet2.0/user-guide/plugins/built-in/assemblyai',
  );
});
