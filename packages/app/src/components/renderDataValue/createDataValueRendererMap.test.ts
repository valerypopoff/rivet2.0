import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DataValue } from '@valerypopoff/rivet2-core';

import { createDataValueRendererMap } from './createDataValueRendererMap.js';
import type { createScalarRenderers } from './createScalarRenderers.js';

const rendererMap = createDataValueRendererMap({
  scalarRenderers: {} as ReturnType<typeof createScalarRenderers>,
  renderValue: ({ value }) => createElement('span', { className: 'nested-value' }, value?.type ?? 'undefined'),
});

test('array-like data values share the common multi-output item presentation', () => {
  const stringArrayMarkup = renderDataValue({
    type: 'string[]',
    value: ['foo', 'bar'],
  });
  const chatMessageArrayMarkup = renderDataValue({
    type: 'chat-message[]',
    value: [
      { type: 'user', message: 'Say hi' },
      { type: 'assistant', message: 'Hi!', function_call: undefined, function_calls: undefined },
    ],
  } satisfies DataValue);

  assert.equal(countOccurrences(stringArrayMarkup, 'class="multi-output-item"'), 2);
  assert.equal(countOccurrences(chatMessageArrayMarkup, 'class="multi-output-item"'), 2);
  assert.doesNotMatch(chatMessageArrayMarkup, /chat-message-list/);
});

test('array-like renderers tolerate malformed array payloads', () => {
  const malformedArrayMarkup = renderDataValue({
    type: 'string[]',
    value: undefined,
  } as unknown as DataValue);

  assert.match(malformedArrayMarkup, /Invalid array value/);
  assert.equal(countOccurrences(malformedArrayMarkup, 'class="multi-output-item"'), 0);
});

test('function renderers preserve array return types in their labels', () => {
  const markup = renderDataValue({ type: 'fn<string[]>', value: () => ['value'] });

  assert.match(markup, /Function&lt;string\[\]&gt;/);
});

function renderDataValue(value: DataValue): string {
  const Renderer = rendererMap[value.type];

  return renderToStaticMarkup(createElement(Renderer, { value }));
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
