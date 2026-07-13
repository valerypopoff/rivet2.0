import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyUiGraphStatePatch,
  createUiGraphActionExecutionController,
  createUiGraphInteractionController,
  getUiGraphActionState,
  getUiGraphComponentRenderModel,
  getUiGraphJsonOutputFilename,
  getUiGraphOutputRenderModel,
  type UiGraphComponent,
  type UiGraph,
  type UiGraphActionRunContext,
  type UiGraphId,
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
      { id: componentId, size: 'large', type: 'gap' },
      { id: componentId, label: 'Prompt', stateKey: 'prompt', type: 'input' },
      { id: componentId, label: '', stateKey: 'prompt', type: 'textarea' },
      { id: componentId, label: 'Run', action: { type: 'runGraph' }, type: 'button' },
      { id: componentId, label: 'Answer', stateKey: 'answer', renderAs: 'json', type: 'output' },
    ];

    const models = components.map((component) => getUiGraphComponentRenderModel(component, state));

    assert.deepEqual(
      models.map((model) => model.type),
      ['text', 'markdown', 'gap', 'input', 'textarea', 'button', 'output'],
    );
    assert.equal(models[2]?.type === 'gap' && models[2].size, 'large');
    assert.equal(models[3]?.type === 'input' && models[3].value, 'Hello');
    assert.equal(models[4]?.type === 'textarea' && models[4].label, 'prompt');
    assert.equal(models[6]?.type === 'output' && models[6].output.renderedValue, '{\n  "value": 42\n}');
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
        {
          type: 'runGraph',
          inputs: { fixed: { type: 'literal', value: 'fixed' }, question: { type: 'state', key: 'prompt' } },
        },
        state,
      ),
      { prompt: 'Write a story' },
    );
  });

  it('creates portable JSON download filenames from the app name and current time', () => {
    const filename = getUiGraphJsonOutputFilename(' Test: app / result ', new Date(2026, 6, 10, 9, 8, 7));

    assert.equal(filename, 'Test- app - result 2026-07-10 09-08-07.json');
  });

  it('tracks independently running buttons without letting one completion clear another', () => {
    const controller = createUiGraphActionExecutionController();
    const firstButton: Extract<UiGraphComponent, { type: 'button' }> = {
      action: { outputs: [{ stateKey: 'firstResult' }], type: 'runGraph' },
      id: 'first-button' as UiComponentId,
      label: 'First',
      type: 'button',
    };
    const secondButton: Extract<UiGraphComponent, { type: 'button' }> = {
      action: { outputs: [{ stateKey: 'secondResult' }], type: 'runGraph' },
      id: 'second-button' as UiComponentId,
      label: 'Second',
      type: 'button',
    };

    const firstExecution = controller.begin(firstButton)!;
    const secondExecution = controller.begin(secondButton)!;

    assert.equal(controller.begin(firstButton), undefined);
    assert.equal(controller.isCurrent(firstExecution), true);
    assert.equal(controller.isRunning(firstButton.id), true);
    assert.equal(controller.isRunning(secondButton.id), true);
    assert.equal(controller.finish(firstExecution), true);
    assert.equal(controller.isCurrent(firstExecution), false);
    assert.equal(controller.isRunning(firstButton.id), false);
    assert.equal(controller.isRunning(secondButton.id), true);
    assert.equal(controller.finish(secondExecution), true);
  });

  it('lets the latest-started action own overlapping state keys while preserving independent patches', () => {
    const controller = createUiGraphActionExecutionController();
    const firstButton: Extract<UiGraphComponent, { type: 'button' }> = {
      action: {
        outputs: [{ stateKey: 'sharedResult' }, { stateKey: 'firstOnly' }],
        type: 'runGraph',
      },
      id: 'first-button' as UiComponentId,
      label: 'First',
      type: 'button',
    };
    const secondButton: Extract<UiGraphComponent, { type: 'button' }> = {
      action: { outputs: [{ stateKey: 'sharedResult' }], type: 'runGraph' },
      id: 'second-button' as UiComponentId,
      label: 'Second',
      type: 'button',
    };

    const firstExecution = controller.begin(firstButton)!;
    const secondExecution = controller.begin(secondButton)!;

    assert.deepEqual(controller.resolveStatePatch(firstExecution, { firstOnly: 'first', sharedResult: 'stale' }), {
      firstOnly: 'first',
    });
    assert.deepEqual(controller.resolveStatePatch(secondExecution, { sharedResult: 'current' }), {
      sharedResult: 'current',
    });
  });

  it('does not let an in-flight action overwrite a newer direct state edit', () => {
    const controller = createUiGraphActionExecutionController();
    const button: Extract<UiGraphComponent, { type: 'button' }> = {
      action: { outputs: [{ stateKey: 'result' }], type: 'runGraph' },
      id: 'run-button' as UiComponentId,
      label: 'Run',
      type: 'button',
    };

    const execution = controller.begin(button)!;
    controller.noteStateWrite('result');

    assert.equal(controller.resolveStatePatch(execution, { result: 'stale' }), undefined);
    controller.reset();
    assert.equal(controller.isRunning(button.id), false);
    assert.equal(controller.finish(execution), false);
  });

  it('owns state, independent loading, errors, and stale-patch protection for every renderer', async () => {
    const action = {
      inputMappings: [{ inputKey: 'prompt', stateKey: 'prompt' }],
      outputs: [{ stateKey: 'result' }],
      type: 'runGraph' as const,
    };
    const firstButton = makeButton('first-button', action);
    const secondButton = makeButton('second-button', action);
    const uiGraph = makeUiGraph([firstButton, secondButton]);
    const controller = createUiGraphInteractionController(uiGraph, { initialState: { prompt: 'Initial' } });
    const changes: string[] = [];
    const unsubscribe = controller.subscribe((change) => changes.push(change));
    const firstRun = deferred<{ statePatch?: Record<string, unknown> }>();
    const secondRun = deferred<{ statePatch?: Record<string, unknown> }>();
    const runContexts = new Map<string, UiGraphActionRunContext>();

    controller.updateState('prompt', 'Edited');
    const firstPromise = controller.runAction(firstButton, (context) => {
      runContexts.set('first', context);
      return firstRun.promise;
    });
    const secondPromise = controller.runAction(secondButton, (context) => {
      runContexts.set('second', context);
      return secondRun.promise;
    });

    assert.deepEqual(runContexts.get('first')?.state, { prompt: 'Edited' });
    assert.deepEqual([...controller.getSnapshot().runningComponentIds], [firstButton.id, secondButton.id]);

    firstRun.resolve({ statePatch: { result: 'stale' } });
    await firstPromise;
    assert.equal(controller.getSnapshot().state.result, undefined);
    assert.deepEqual([...controller.getSnapshot().runningComponentIds], [secondButton.id]);

    secondRun.resolve({ statePatch: { result: 'current' } });
    await secondPromise;
    assert.equal(controller.getSnapshot().state.result, 'current');
    assert.equal(controller.getSnapshot().runningComponentIds.size, 0);

    await controller.runAction(firstButton, async () => {
      throw new Error('Action failed');
    });
    assert.equal(controller.getSnapshot().actionErrors[firstButton.id], 'Action failed');
    assert.equal(changes[0], 'state');
    assert.equal(changes.includes('action'), true);
    unsubscribe();
  });

  it('aborts removed actions and resets state when the rendered UI graph changes', async () => {
    const button = makeButton('run-button', { type: 'runGraph' });
    const initialGraph = makeUiGraph([
      { defaultValue: 'Initial', id: 'input' as UiComponentId, label: 'Input', stateKey: 'input', type: 'input' },
      button,
    ]);
    const controller = createUiGraphInteractionController(initialGraph);
    const removedAction = deferred<{ statePatch?: Record<string, unknown> }>();
    let removedSignal: AbortSignal | undefined;
    const removedPromise = controller.runAction(button, ({ signal }) => {
      removedSignal = signal;
      return removedAction.promise;
    });

    controller.setUiGraph(makeUiGraph([]));
    assert.equal(removedSignal?.aborted, true);
    assert.equal(controller.getSnapshot().runningComponentIds.size, 0);

    removedAction.resolve({ statePatch: { result: 'ignored' } });
    await removedPromise;
    assert.equal(controller.getSnapshot().state.result, undefined);

    controller.updateState('input', 'Edited');
    controller.setUiGraph({
      components: [
        {
          defaultValue: 'Replacement',
          id: 'next-input' as UiComponentId,
          label: 'Input',
          stateKey: 'input',
          type: 'input',
        },
      ],
      id: 'replacement' as UiGraphId,
      name: 'Replacement',
    });
    assert.deepEqual(controller.getSnapshot().state, { input: 'Replacement' });
  });
});

function makeButton(
  id: string,
  action: Extract<UiGraphComponent, { type: 'button' }>['action'],
): Extract<UiGraphComponent, { type: 'button' }> {
  return { action, id: id as UiComponentId, label: id, type: 'button' };
}

function makeUiGraph(components: UiGraphComponent[]): UiGraph {
  return { components, id: 'ui-graph' as UiGraphId, name: 'App' };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}
