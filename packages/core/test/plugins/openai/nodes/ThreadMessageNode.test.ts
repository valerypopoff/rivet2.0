import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { ThreadMessageNodeImpl } from '../../../../src/plugins/openai/nodes/ThreadMessageNode.js';
import type { InternalProcessContext } from '../../../../src/model/ProcessContext.js';

describe('ThreadMessageNodeImpl', () => {
  it('discovers later valid interpolation inputs even when an earlier opener is broken', () => {
    const data = {
      ...ThreadMessageNodeImpl.create().data,
      text: ['{{foo}}', '{{bar', '{{somevar}}'].join('\n'),
    };

    assert.deepStrictEqual(
      ThreadMessageNodeImpl.getInputDefinitions(data, [], {} as any, {} as any).map((definition) => definition.id),
      ['foo', 'somevar'],
    );
  });

  it('uses one any input for nested JSONPath and preserves bare interpolation coercion', async () => {
    const data = {
      ...ThreadMessageNodeImpl.create().data,
      text: '{{payload.content.text}} / {{payload}}',
    };

    assert.deepStrictEqual(
      ThreadMessageNodeImpl.getInputDefinitions(data, [], {} as any, {} as any).map(({ id, dataType }) => ({
        id,
        dataType,
      })),
      [{ id: 'payload', dataType: 'any' }],
    );

    const result = await ThreadMessageNodeImpl.process(data, {
      payload: {
        type: 'object',
        value: { content: { text: 'Hello' } },
      },
    } as any);

    assert.deepStrictEqual(result.message?.value, {
      role: 'user',
      content: 'Hello / {"content":{"text":"Hello"}}',
      file_ids: [],
      metadata: {},
    });
  });

  it('reuses the metadata input for a metadata JSONPath instead of adding a duplicate port', async () => {
    const data = {
      ...ThreadMessageNodeImpl.create().data,
      text: '{{metadata.subject}}',
      useMetadataInput: true,
    };

    assert.deepStrictEqual(
      ThreadMessageNodeImpl.getInputDefinitions(data, [], {} as any, {} as any).map(({ id, dataType }) => ({
        id,
        dataType,
      })),
      [{ id: 'metadata', dataType: 'object' }],
    );

    const result = await ThreadMessageNodeImpl.process(data, {
      metadata: {
        type: 'object',
        value: { subject: 'Hello' },
      },
    } as any);

    assert.equal(result.message?.value.content, 'Hello');
  });

  it('resolves graph and context JSONPath expressions in message text', async () => {
    const data = {
      ...ThreadMessageNodeImpl.create().data,
      text: '{{@graphInputs.payload.user.name}} / {{@context.settings.labels[0]}}',
    };

    const result = await ThreadMessageNodeImpl.process(data, {}, {
      graphInputNodeValues: {
        payload: { type: 'object', value: { user: { name: 'Ada' } } },
      },
      contextValues: {
        settings: { type: 'object', value: { labels: ['Primary'] } },
      },
    } as InternalProcessContext);

    assert.equal(result.message?.value.content, 'Ada / Primary');
  });
});
