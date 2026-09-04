import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DataValue } from '@valerypopoff/rivet2-core';

import { createDataValueRendererMap } from './createDataValueRendererMap.js';
import type { createScalarRenderers } from './createScalarRenderers.js';
import { OUTPUT_NAVIGATION_ITEM_ATTRIBUTE } from './outputNavigationItems.js';

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
  assert.equal(countOccurrences(stringArrayMarkup, `${OUTPUT_NAVIGATION_ITEM_ATTRIBUTE}=""`), 2);
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

test('renders mixed Any arrays as individually inferred values instead of inferring every item from the first', () => {
  const markup = renderDataValue({
    type: 'any',
    value: [[403, 403], 200],
  });

  assert.doesNotMatch(markup, /Invalid array value/);
  assert.equal(countOccurrences(markup, 'class="multi-output-item"'), 2);
  assert.equal(countOccurrences(markup, 'class="nested-value">any</span>'), 2);
});

test('split-run nested array types receive a renderer instead of mounting an undefined component', () => {
  const nestedMessagesMarkup = renderDataValue({
    type: 'chat-message[][]',
    value: [
      [{ type: 'system', message: 'System A' }],
      [
        { type: 'system', message: 'System B' },
        { type: 'user', message: 'User B' },
      ],
    ],
  } as unknown as DataValue);

  assert.equal(countOccurrences(nestedMessagesMarkup, 'class="multi-output-item"'), 2);
  assert.equal(countOccurrences(nestedMessagesMarkup, 'chat-message[]'), 2);
});

test('unknown runtime value types render a diagnostic instead of mounting an undefined component', () => {
  const markup = renderDataValue({
    type: 'unexpected-runtime-type',
    value: { answer: 42 },
  } as unknown as DataValue);

  assert.match(markup, /ERROR: UNKNOWN TYPE/);
  assert.match(markup, /unexpected-runtime-type/);
});

test('function renderers preserve array return types in their labels', () => {
  const markup = renderDataValue({ type: 'fn<string[]>', value: () => ['value'] });

  assert.match(markup, /Function&lt;string\[\]&gt;/);
});

function renderDataValue(value: DataValue): string {
  const Renderer = rendererMap.get(value.type);

  return renderToStaticMarkup(createElement(Renderer, { value }));
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}
