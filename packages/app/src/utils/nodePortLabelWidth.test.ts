import assert from 'node:assert/strict';
import test from 'node:test';

import type { NodeInputDefinition, NodeOutputDefinition } from '@valerypopoff/rivet2-core';

import { MIN_NODE_WIDTH } from './nodeResize.js';
import {
  estimatePortLabelWidth,
  getMinimumNodeWidthForPortLabels,
  getRenderedPortLabel,
} from './nodePortLabelWidth.js';

function inputDefinition(title: string): NodeInputDefinition {
  return {
    id: title,
    title,
    dataType: 'string',
  } as NodeInputDefinition;
}

function outputDefinition(title: string): NodeOutputDefinition {
  return {
    id: title,
    title,
    dataType: 'string',
  } as NodeOutputDefinition;
}

test('getRenderedPortLabel follows the port label case setting', () => {
  assert.equal(getRenderedPortLabel('Request error', false), 'REQUEST ERROR');
  assert.equal(getRenderedPortLabel('Request error', true), 'Request error');
});

test('treats a malformed port title as blank instead of crashing canvas layout', () => {
  assert.equal(getRenderedPortLabel(undefined, false), '');
  assert.equal(estimatePortLabelWidth(undefined, false), 0);
  assert.equal(
    getMinimumNodeWidthForPortLabels({
      inputDefinitions: [inputDefinition(undefined as never)],
      outputDefinitions: [],
      preservePortCase: false,
    }),
    MIN_NODE_WIDTH,
  );
});

test('estimatePortLabelWidth only includes letter spacing for capitalized labels', () => {
  assert.equal(estimatePortLabelWidth('Status', false), estimatePortLabelWidth('Status', true) + 'Status'.length - 1);
});

test('getMinimumNodeWidthForPortLabels keeps short-port nodes at the default minimum', () => {
  const minimumWidth = getMinimumNodeWidthForPortLabels({
    inputDefinitions: [inputDefinition('In')],
    outputDefinitions: [outputDefinition('Out')],
    preservePortCase: false,
  });

  assert.equal(minimumWidth, MIN_NODE_WIDTH);
});

test('getMinimumNodeWidthForPortLabels grows wide enough for the largest input and output labels', () => {
  const inputTitle = 'Very long input port label';
  const outputTitle = 'Very long output port label';
  const minimumWidth = getMinimumNodeWidthForPortLabels({
    inputDefinitions: [inputDefinition('Short'), inputDefinition(inputTitle)],
    outputDefinitions: [outputDefinition(outputTitle), outputDefinition('Short')],
    preservePortCase: false,
  });

  assert.equal(
    minimumWidth,
    estimatePortLabelWidth(inputTitle, false) + 8 + estimatePortLabelWidth(outputTitle, false) + 8 + 12,
  );
  assert.ok(minimumWidth > MIN_NODE_WIDTH);
});

test('getMinimumNodeWidthForPortLabels follows the UI font scale', () => {
  const title = 'scaled label';
  const normalWidth = getMinimumNodeWidthForPortLabels({
    inputDefinitions: [inputDefinition(title)],
    outputDefinitions: [outputDefinition(title)],
    preservePortCase: false,
  });
  const scaledWidth = getMinimumNodeWidthForPortLabels({
    inputDefinitions: [inputDefinition(title)],
    outputDefinitions: [outputDefinition(title)],
    preservePortCase: false,
    uiFontScale: 2,
  });

  assert.ok(scaledWidth > normalWidth);
});
