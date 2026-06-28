import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addUiAuthErrorToReturnTo,
  sanitizeUiAuthReturnTo,
} from '../routes/ui-auth.js';

test('UI auth return paths preserve local app routes', () => {
  assert.equal(sanitizeUiAuthReturnTo('/'), '/');
  assert.equal(sanitizeUiAuthReturnTo('/apps/test-web-app/'), '/apps/test-web-app/');
  assert.equal(
    sanitizeUiAuthReturnTo('/apps/test-web-app/?question=hello#result'),
    '/apps/test-web-app/?question=hello#result',
  );
});

test('UI auth return paths reject external or malformed redirects', () => {
  for (const candidate of [
    undefined,
    '',
    'apps/test-web-app/',
    '//evil.test/apps/test-web-app/',
    'https://evil.test/apps/test-web-app/',
    '/apps/test-web-app/\nSet-Cookie: bad=1',
    '/apps\\test-web-app',
  ]) {
    assert.equal(sanitizeUiAuthReturnTo(candidate), '/');
  }
});

test('UI auth form errors return to the original page with auth_error added', () => {
  assert.equal(
    addUiAuthErrorToReturnTo('/apps/test-web-app/?question=hello#result', 'invalid'),
    '/apps/test-web-app/?question=hello&auth_error=invalid#result',
  );
  assert.equal(addUiAuthErrorToReturnTo('/?editor', 'forbidden'), '/?editor=&auth_error=forbidden');
  assert.equal(addUiAuthErrorToReturnTo('https://evil.test/', 'invalid'), '/?auth_error=invalid');
});
