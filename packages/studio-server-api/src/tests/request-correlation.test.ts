import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import test from 'node:test';

import { getExpectedProxyAuthToken } from '../auth.js';
import {
  getRequestCorrelationId,
  normalizeRivetCorrelationId,
} from '../request-correlation.js';

function incomingRequest(headers: IncomingHttpHeaders): IncomingMessage {
  return { headers } as IncomingMessage;
}

test('correlation IDs trust only the authenticated proxy and remain bounded', () => {
  const previousKey = process.env.RIVET_KEY;
  process.env.RIVET_KEY = 'request-correlation-test-key';

  try {
    const forwardedCorrelationId = 'rvt-proxy-forwarded-12345';
    const trustedProxyRequest = incomingRequest({
      'x-rivet-correlation-id': forwardedCorrelationId,
      'x-rivet-proxy-auth': getExpectedProxyAuthToken(),
    });
    assert.equal(getRequestCorrelationId(trustedProxyRequest), forwardedCorrelationId);
    assert.equal(getRequestCorrelationId(trustedProxyRequest), forwardedCorrelationId);

    const directRequest = incomingRequest({
      'x-rivet-correlation-id': forwardedCorrelationId,
      'x-rivet-proxy-auth': 'client-selected-proxy-auth',
    });
    const generatedCorrelationId = getRequestCorrelationId(directRequest);
    assert.match(generatedCorrelationId, /^rvt-[a-f0-9-]{36}$/);
    assert.notEqual(generatedCorrelationId, forwardedCorrelationId);

    assert.equal(normalizeRivetCorrelationId('rvt-valid-value-12345'), 'rvt-valid-value-12345');
    assert.equal(normalizeRivetCorrelationId('rvt-invalid\nvalue-12345'), null);
    assert.equal(normalizeRivetCorrelationId('too-short'), null);
    assert.equal(normalizeRivetCorrelationId('x'.repeat(97)), null);
  } finally {
    if (previousKey == null) {
      delete process.env.RIVET_KEY;
    } else {
      process.env.RIVET_KEY = previousKey;
    }
  }
});
