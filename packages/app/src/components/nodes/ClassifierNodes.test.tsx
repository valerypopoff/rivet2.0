import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ClassifierEvaluateNodeImpl, ClassifierQuestionNodeImpl } from '@valerypopoff/rivet2-core';
import { classifierEvaluateNodeDescriptor, classifierQuestionNodeDescriptor } from './ClassifierNodes.js';

function renderQuestionBody(data: Partial<ClassifierQuestionNodeImpl['data']> = {}) {
  const chartNode = ClassifierQuestionNodeImpl.create();
  const Body = classifierQuestionNodeDescriptor.Body;
  assert.ok(Body, 'Classifier Question must provide a custom canvas body');
  return renderToStaticMarkup(createElement(Body, { node: { ...chartNode, data: { ...chartNode.data, ...data } } }));
}

function renderEvaluateBody(data: Partial<ClassifierEvaluateNodeImpl['data']> = {}) {
  const chartNode = ClassifierEvaluateNodeImpl.create();
  const Body = classifierEvaluateNodeDescriptor.Body;
  assert.ok(Body, 'Classifier Evaluate must provide a custom canvas body');
  return renderToStaticMarkup(createElement(Body, { node: { ...chartNode, data: { ...chartNode.data, ...data } } }));
}

test('Classifier Question uses the LLM card section layout without escaping authored text', () => {
  const html = renderQuestionBody({ questionId: 'route', instructions: 'Route {{subject}}' });

  assert.equal((html.match(/class="llm-node-body-section"/g) ?? []).length, 3);
  assert.equal((html.match(/class="llm-node-body-field"/g) ?? []).length, 3);
  assert.match(html, /Type:<\/span> Choice/);
  assert.match(html, /ID:<\/span> route/);
  assert.match(html, /class="llm-node-body-summary">Route \{\{subject\}\}<\/div>/);
  assert.match(html, /Criteria:<\/span> 2 choices/);
  assert.doesNotMatch(html, /\\\{\{|rivet-node-body/);
});

test('Classifier Evaluate uses the exact LLM card fields and sections', () => {
  const html = renderEvaluateBody({ retryOnNon200: true, retryOnNon200RepeatTimes: 2, retryOnNon200CooldownMs: 25 });

  assert.equal((html.match(/class="llm-node-body-section"/g) ?? []).length, 2);
  assert.equal((html.match(/class="llm-node-body-field"/g) ?? []).length, 5);
  assert.match(html, /Provider:<\/span> Jev/);
  assert.match(html, /Model:<\/span> jev-latest/);
  assert.match(html, /Retry on non-200:<\/span> Enabled/);
  assert.match(html, /Cooldown, ms:<\/span> 25/);
});
