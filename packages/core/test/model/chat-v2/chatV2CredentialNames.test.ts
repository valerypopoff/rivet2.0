import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  getNonDefaultChatV2CredentialNames,
  isChatV2BuiltInProvider,
} from '../../../src/model/chat-v2/chatV2CredentialNames.js';

describe('chat v2 credential names', () => {
  it('recognizes only supported built-in providers at runtime', () => {
    assert.equal(isChatV2BuiltInProvider('openai'), true);
    assert.equal(isChatV2BuiltInProvider('anthropic'), true);
    assert.equal(isChatV2BuiltInProvider('google'), true);
    assert.equal(isChatV2BuiltInProvider('custom'), false);
    assert.equal(isChatV2BuiltInProvider('future-provider' as never), false);
  });

  it('ignores credential summaries for malformed provider values', () => {
    assert.equal(
      getNonDefaultChatV2CredentialNames('future-provider' as never, {
        openai: {
          programmaticName: 'billingOpenAiKey',
          environmentVariableName: 'BILLING_OPENAI_KEY',
        },
      }),
      undefined,
    );
  });
});
