import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolCallContinuationIndicator } from './ToolCallContinuationIndicator.js';
import { NodeTitleLabel } from './NodeTitleLabel.js';

function renderNodeTitle(type: string, title: string) {
  return renderToStaticMarkup(createElement(NodeTitleLabel, { node: { type, title } as any }));
}

test('NodeTitleLabel decorates Get Global canvas titles only in rendered markup', () => {
  const html = renderNodeTitle('getGlobal', 'Get Global');

  assert.match(html, /global-node-title-icon-get/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /d="M7 20h10"/);
  assert.doesNotMatch(html, /d="M7 4h10"/);
  assert.match(html, />Get Global<\/span>/);
});

test('NodeTitleLabel decorates Set Global canvas titles with the matching icon', () => {
  const html = renderNodeTitle('setGlobal', 'Set Global');

  assert.match(html, /global-node-title-icon-set/);
  assert.match(html, /d="M12 6v11"/);
  assert.doesNotMatch(html, /d="M12 4v13"/);
  assert.match(html, /d="M7 20h10"/);
  assert.match(html, />Set Global<\/span>/);
});

test('NodeTitleLabel uses the same directional cues for Stored Value nodes', () => {
  assert.match(renderNodeTitle('getStoredValue', 'Get Stored Value'), /global-node-title-icon-get/);
  assert.match(renderNodeTitle('setStoredValue', 'Set Stored Value'), /global-node-title-icon-set/);
});

test('NodeTitleLabel gives every Knowledge node a database icon', () => {
  for (const type of [
    'knowledgeSource',
    'knowledgeDocument',
    'syncKnowledgeSource',
    'getKnowledgeSourceStatus',
    'searchKnowledge',
    'buildKnowledgeContext',
  ]) {
    const html = renderNodeTitle(type, 'Knowledge node');
    assert.match(html, /knowledge-node-title-icon/);
    assert.match(html, /<ellipse/);
    assert.match(html, /aria-hidden="true"/);
  }
});

test('NodeTitleLabel gives Delegate Tool Call its lifecycle icon before the title', () => {
  const element = NodeTitleLabel({ node: { type: 'delegateFunctionCall', title: 'Delegate Tool Call' } as any });

  if (!isValidElement<{ children: ReactNode }>(element)) {
    assert.fail('Expected NodeTitleLabel to render an element.');
  }

  const [icon, title] = Children.toArray(element.props.children);

  assert.ok(isValidElement(icon));
  assert.equal(icon.type, ToolCallContinuationIndicator);
  assert.equal(title, 'Delegate Tool Call');
});

test('NodeTitleLabel leaves other node titles plain', () => {
  const html = renderNodeTitle('text', 'Text');

  assert.doesNotMatch(html, /global-node-title-icon/);
  assert.doesNotMatch(html, /knowledge-node-title-icon/);
  assert.match(html, /^<span class="title-text-label">Text<\/span>$/);
});
