import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyUiGraphStatePatch,
  getUiGraphActionState,
  getUiGraphComponentRenderModel,
  getUiGraphJsonOutputFilename,
  getUiGraphOutputRenderModel,
  type UiGraphComponent,
  type UiGraphRunGraphAction,
  type UiComponentId,
} from '../../src/index.js';

const componentId = 'component' as UiComponentId;

describe('UiGraphRuntimeModel', () => {
  it('creates one render model for every supported component kind', () => {
    const state = { answer: { value: 42 }, prompt: 'Hello' };
    const components: UiGraphComponent[] = [
      { id: componentId, text: 'Static text', type: 'text' },
      { id: componentId, markdown: '**Markdown**', type: 'markdown' },
      { id: componentId, label: 'Prompt', stateKey: 'prompt', type: 'input' },
      { id: componentId, label: '', stateKey: 'prompt', type: 'textarea' },
      { id: componentId, label: 'Run', action: { type: 'runGraph' }, type: 'button' },
      { id: componentId, label: 'Answer', stateKey: 'answer', renderAs: 'json', type: 'output' },
    ];

    const models = components.map((component) => getUiGraphComponentRenderModel(component, state));

    assert.deepEqual(models.map((model) => model.type), ['text', 'markdown', 'input', 'textarea', 'button', 'output']);
    assert.equal(models[2]?.type === 'input' && models[2].value, 'Hello');
    assert.equal(models[3]?.type === 'textarea' && models[3].label, 'prompt');
    assert.equal(models[5]?.type === 'output' && models[5].output.renderedValue, '{\n  "value": 42\n}');
  });

  it('keeps empty output blocks empty until the action stores a value', () => {
    const output = getUiGraphOutputRenderModel({}, 'result', 'text');

    assert.equal(output.hasValue, false);
    assert.equal(output.renderedValue, '');
    assert.equal(output.jsonDownloadValue, undefined);
  });

  it('makes JSON output download and display use the same serialized value', () => {
    const output = getUiGraphOutputRenderModel({ result: { nested: ['value'] } }, 'result', 'json');

    assert.equal(output.hasValue, true);
    assert.equal(output.renderedValue, '{\n  "nested": [\n    "value"\n  ]\n}');
    assert.equal(output.jsonDownloadValue, output.renderedValue);
  });

  it('applies an action state patch without rebuilding state when no patch was returned', () => {
    const state = { answer: 'before' };

    assert.equal(applyUiGraphStatePatch(state, undefined), state);
    assert.deepEqual(applyUiGraphStatePatch(state, { answer: 'after', extra: true }), {
      answer: 'after',
      extra: true,
    });
  });

  it('selects only state keys explicitly mapped to a graph action', () => {
    const state = { genre: 'fantasy', prompt: 'Write a story', previousResult: 'old', unrelated: true };
    const action: UiGraphRunGraphAction = {
      type: 'runGraph',
      inputMappings: [
        { inputKey: 'question', stateKey: 'prompt' },
        { inputKey: 'category', stateKey: 'genre' },
      ],
    };

    assert.deepEqual(getUiGraphActionState(action, state), { genre: 'fantasy', prompt: 'Write a story' });
    assert.deepEqual(
      getUiGraphActionState(
        { type: 'runGraph', inputs: { fixed: { type: 'literal', value: 'fixed' }, question: { type: 'state', key: 'prompt' } } },
        state,
      ),
      { prompt: 'Write a story' },
    );
  });

  it('creates portable JSON download filenames from the app name and current time', () => {
    const filename = getUiGraphJsonOutputFilename(' Test: app / result ', new Date(2026, 6, 10, 9, 8, 7));

    assert.equal(filename, 'Test- app - result 2026-07-10 09-08-07.json');
  });
});
