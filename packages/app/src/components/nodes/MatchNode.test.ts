import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MatchCaseNodeImpl,
  MatchNodeImpl,
  type MatchCaseNode,
  type MatchNode,
} from '@valerypopoff/rivet2-core';
import { matchCaseNodeDescriptor, matchNodeDescriptor } from './MatchNode.js';

function renderMatchCaseBody(node: MatchCaseNode): string {
  const Body = matchCaseNodeDescriptor.Body;
  assert.ok(Body, 'Match case nodes must provide a custom canvas body');
  return renderToStaticMarkup(createElement(Body, { node }));
}

function renderLegacyMatchBody(node: MatchNode): string {
  const Body = matchNodeDescriptor.Body;
  assert.ok(Body, 'Legacy Regex Match nodes must provide a custom canvas body');
  return renderToStaticMarkup(createElement(Body, { node }));
}

test('Match case body applies runtime defaults and shows case sensitivity only for Plain text', () => {
  const created = MatchCaseNodeImpl.create();
  const missingOptionalSettings: MatchCaseNode = {
    ...created,
    data: {
      cases: created.data.cases,
      casePortIds: created.data.casePortIds,
      valueInputMode: created.data.valueInputMode,
    },
  };

  const plainTextHtml = renderMatchCaseBody(missingOptionalSettings);
  assert.match(plainTextHtml, /Match mode:<\/span> Plain text/);
  assert.match(plainTextHtml, /Case sensitive:<\/span> Yes/);
  assert.match(plainTextHtml, /Trigger:<\/span> First matching case/);
  assert.match(plainTextHtml, /Output value:<\/span> <code class="llm-node-body-code-value">true<\/code>/);
  assert.equal((plainTextHtml.match(/class="llm-node-body-section"/g) ?? []).length, 3);
  assert.doesNotMatch(plainTextHtml, /Custom case values:/);

  const regexHtml = renderMatchCaseBody({
    ...missingOptionalSettings,
    data: { ...missingOptionalSettings.data, matchMode: 'regex', caseSensitive: false },
  });
  assert.match(regexHtml, /Match mode:<\/span> Regular expression/);
  assert.doesNotMatch(regexHtml, /Case sensitive:/);
  assert.match(regexHtml, /Output value:<\/span> <code class="llm-node-body-code-value">true<\/code>/);
  assert.equal((regexHtml.match(/class="llm-node-body-section"/g) ?? []).length, 3);
});

test('Match case body omits custom-value routing details in Custom return mode', () => {
  const created = MatchCaseNodeImpl.create();
  const html = renderMatchCaseBody({
    ...created,
    data: {
      ...created.data,
      returnValue: 'custom',
      valueInputMode: 'per-output',
    },
  });

  assert.match(html, /Output value:<\/span> Custom/);
  assert.doesNotMatch(html, /Custom case values:/);
});

test('Regex Match legacy body retains its all-matches default', () => {
  const created = MatchNodeImpl.create();
  const defaultHtml = renderLegacyMatchBody({
    ...created,
    data: { ...created.data, exclusive: undefined },
  });
  const firstMatchHtml = renderLegacyMatchBody({
    ...created,
    data: { ...created.data, exclusive: true },
  });

  assert.match(defaultHtml, /Trigger:<\/span> All matching cases/);
  assert.match(firstMatchHtml, /Trigger:<\/span> First matching case only/);
});
