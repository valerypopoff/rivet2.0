import assert from 'node:assert/strict';
import test from 'node:test';
import { isGeneratedClientFresh } from '../../packages/node/scripts/build-web-app-client.cjs';

const expected = '// Generated client\nexport const client = "first\\nsecond\\r\\nthird";\n';

test('generated client freshness accepts LF, CRLF and mixed physical line endings', () => {
  const crlf = expected.replaceAll('\n', '\r\n');
  const mixed = expected.replace('\n', '\r\n');
  for (const existing of [expected, crlf, mixed]) {
    assert.equal(isGeneratedClientFresh(existing, expected), true);
    assert.equal(isGeneratedClientFresh(expected, existing), true);
  }
});

test('generated client freshness still rejects real changes including escaped string newlines', () => {
  for (const existing of [
    expected.replace('second', 'changed'),
    expected.replace('\\r\\n', '\\n'),
    expected.replace('\\n', '\n'),
    expected.replace('\n', '\r'),
    expected.trimEnd(),
    '',
  ]) {
    assert.equal(isGeneratedClientFresh(existing, expected), false);
  }
});
