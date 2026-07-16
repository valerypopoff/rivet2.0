import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyUiGraphStatePatch,
  createUiGraphChatSubmissionStatePatch,
  createUiGraphActionExecutionController,
  createUiGraphInteractionController,
  getUiGraphActionState,
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessagesStateKey,
  getUiGraphComponentActionState,
  getUiGraphComponentRenderModel,
  getUiGraphImageSource,
  getUiGraphJsonOutputFilename,
  getUiGraphOutputRenderModel,
  getUiGraphProgressiveJsonOutputChunks,
  resolveUiGraphComponentActionInputs,
  resolveUiGraphComponentActionOutputStatePatch,
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
      { id: componentId, action: { type: 'runGraph' }, type: 'chat' },
      { id: componentId, label: 'Answer', stateKey: 'answer', renderAs: 'json', type: 'output' },
    ];

    const models = components.map((component) => getUiGraphComponentRenderModel(component, state));

    assert.deepEqual(
      models.map((model) => model.type),
      ['text', 'markdown', 'gap', 'input', 'textarea', 'button', 'chat', 'output'],
    );
    assert.equal(models[2]?.type === 'gap' && models[2].size, 'large');
    assert.equal(models[3]?.type === 'input' && models[3].value, 'Hello');
    assert.equal(models[4]?.type === 'textarea' && models[4].label, 'prompt');
    assert.equal(models[6]?.type === 'chat' && models[6].messages.length, 0);
    assert.equal(models[7]?.type === 'output' && models[7].output.renderedValue, '{\n  "value": 42\n}');
  });

  it('submits Chat state as a current string, prior native history, and explicitly mapped page data', () => {
    const chat = {
      action: {
        graphId: 'graph' as never,
        historyInputId: 'history',
        responseOutputId: 'response',
        inputMappings: [{ inputKey: 'tone', stateKey: 'tone' }],
        type: 'runGraph' as const,
        userInputId: 'message',
      },
      id: 'chat' as UiComponentId,
      type: 'chat' as const,
    };
    const draftKey = getUiGraphChatDraftStateKey(chat.id);
    const messagesKey = getUiGraphChatMessagesStateKey(chat.id);
    const initialState = {
      [draftKey]: '  Hello  ',
      [messagesKey]: [{ role: 'assistant', content: 'Welcome' }],
      tone: 'Friendly',
    };
    const submission = createUiGraphChatSubmissionStatePatch(chat.id, initialState)!;
    const submittedState = applyUiGraphStatePatch(initialState, submission);
    const actionState = getUiGraphComponentActionState(chat, submittedState);

    assert.deepEqual(submission, {
      [draftKey]: '',
      [messagesKey]: [
        { role: 'assistant', content: 'Welcome' },
        { role: 'user', content: 'Hello' },
      ],
    });
    assert.deepEqual(actionState, { [messagesKey]: submission[messagesKey], tone: 'Friendly' });
    assert.deepEqual(resolveUiGraphComponentActionInputs(chat, actionState), {
      message: 'Hello',
      history: {
        type: 'chat-message[]',
        value: [{ type: 'assistant', message: 'Welcome', function_call: undefined, function_calls: undefined }],
      },
      tone: 'Friendly',
    });
    assert.deepEqual(
      resolveUiGraphComponentActionOutputStatePatch(
        chat,
        { response: { type: 'string', value: 'Hi there' } },
        actionState,
      ),
      {
        [messagesKey]: [
          { role: 'assistant', content: 'Welcome' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      },
    );
  });

  it('keeps empty output blocks empty until the action stores a value', () => {
    const output = getUiGraphOutputRenderModel({}, 'result', 'text');
    const imageOutput = getUiGraphOutputRenderModel({}, 'image', 'image');

    assert.equal(output.hasValue, false);
    assert.equal(output.renderedValue, '');
    assert.equal(output.jsonDownloadValue, undefined);
    assert.equal(imageOutput.imageErrorMessage, undefined);
    assert.equal(imageOutput.imageSource, undefined);
  });

  it('keeps blank text output empty even when an initialized input owns the same state key', () => {
    const textOutput = getUiGraphOutputRenderModel({ result: '' }, 'result', 'text');
    const markdownOutput = getUiGraphOutputRenderModel({ result: null }, 'result', 'markdown');
    const imageOutput = getUiGraphOutputRenderModel({ result: '' }, 'result', 'image');

    assert.equal(textOutput.hasValue, false);
    assert.equal(markdownOutput.hasValue, false);
    assert.equal(imageOutput.hasValue, false);
    assert.equal(imageOutput.imageErrorMessage, undefined);
  });

  it('keeps displayable false, zero, JSON, and invalid image output values visible', () => {
    assert.equal(getUiGraphOutputRenderModel({ result: false }, 'result', 'text').hasValue, true);
    assert.equal(getUiGraphOutputRenderModel({ result: 0 }, 'result', 'markdown').hasValue, true);
    assert.equal(getUiGraphOutputRenderModel({ result: '' }, 'result', 'json').hasValue, true);
    assert.equal(getUiGraphOutputRenderModel({ result: 'not an image' }, 'result', 'image').hasValue, true);
  });

  it('makes JSON output download and display use the same serialized value', () => {
    const output = getUiGraphOutputRenderModel({ result: { nested: ['value'] } }, 'result', 'json');

    assert.equal(output.hasValue, true);
    assert.equal(output.renderedValue, '{\n  "nested": [\n    "value"\n  ]\n}');
    assert.equal(output.jsonDownloadValue, output.renderedValue);
  });

  it('splits only large JSON output into lossless text chunks', () => {
    const smallJson = '{"answer":"small"}';
    const largeJson = `${'a'.repeat(16 * 1024 - 1)}\ud83d\ude00${'b'.repeat(128 * 1024)}`;
    const chunks = getUiGraphProgressiveJsonOutputChunks(largeJson);

    assert.equal(getUiGraphProgressiveJsonOutputChunks(smallJson), undefined);
    assert.ok(chunks);
    assert.equal(chunks.join(''), largeJson);
    assert.equal(chunks.length > 1, true);
    for (let index = 0; index < chunks.length - 1; index += 1) {
      const chunk = chunks[index]!;
      const nextChunk = chunks[index + 1]!;
      assert.equal(isHighSurrogateCodeUnit(chunk.charCodeAt(chunk.length - 1)), false);
      assert.equal(isLowSurrogateCodeUnit(nextChunk.charCodeAt(0)), false);
    }
  });

  it('derives safe image sources from URLs and base64 image data', () => {
    const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

    assert.equal(getUiGraphImageSource('https://example.test/image.png'), 'https://example.test/image.png');
    assert.equal(getUiGraphImageSource('./images/result.webp'), './images/result.webp');
    assert.equal(getUiGraphImageSource(`data:image/gif;base64,${gifBase64}`), `data:image/gif;base64,${gifBase64}`);
    assert.equal(getUiGraphImageSource(gifBase64), `data:image/gif;base64,${gifBase64}`);
    assert.equal(getUiGraphImageSource('javascript:alert(1).png'), undefined);
    assert.equal(getUiGraphImageSource('file:///private/image.png'), undefined);
    assert.equal(getUiGraphImageSource('data:text/html;base64,PGgxPk5vdCBhbiBpbWFnZTwvaDE+'), undefined);
    assert.equal(getUiGraphImageSource('SGVsbG8gd29ybGQ='), undefined);
    assert.equal(
      getUiGraphOutputRenderModel({ result: 'not an image' }, 'result', 'image').imageErrorMessage,
      'Expected an image URL or base64 image.',
    );
  });

  it('keeps the original image output value while exposing its render source', () => {
    const gifBase64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    const output = getUiGraphOutputRenderModel({ result: gifBase64 }, 'result', 'image');

    assert.equal(output.hasValue, true);
    assert.equal(output.renderedValue, gifBase64);
    assert.equal(output.imageSource, `data:image/gif;base64,${gifBase64}`);
    assert.equal(output.jsonDownloadValue, undefined);
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

  it('normalizes current action progress and drops stale reports after cancellation', async () => {
    const button = makeButton('run-button', { type: 'runGraph' });
    const controller = createUiGraphInteractionController(makeUiGraph([button]));
    const run = deferred<{ statePatch?: Record<string, unknown> }>();
    let context: UiGraphActionRunContext | undefined;
    const runPromise = controller.runAction(button, (runContext) => {
      context = runContext;
      return run.promise;
    });

    context?.reportProgress({ message: '  Working  ', percent: 130 });
    assert.deepEqual(controller.getSnapshot().actionProgress[button.id], { message: 'Working', percent: 100 });

    controller.cancelAction(button.id);
    assert.equal(context?.signal.aborted, true);
    assert.equal(controller.getSnapshot().actionProgress[button.id], undefined);
    context?.reportProgress({ message: 'Stale' });
    assert.equal(controller.getSnapshot().actionProgress[button.id], undefined);

    run.resolve({ statePatch: { result: 'ignored' } });
    await runPromise;
    assert.equal(controller.getSnapshot().state.result, undefined);
  });

  it('resets renderer state, errors, progress, and active actions to the initial state', async () => {
    const button = makeButton('run-button', { type: 'runGraph' });
    const uiGraph = makeUiGraph([
      { defaultValue: 'Initial', id: 'input' as UiComponentId, label: 'Input', stateKey: 'input', type: 'input' },
      button,
    ]);
    const controller = createUiGraphInteractionController(uiGraph);
    const run = deferred<{ statePatch?: Record<string, unknown> }>();
    let signal: AbortSignal | undefined;

    controller.updateState('input', 'Edited');
    const runPromise = controller.runAction(button, (context) => {
      signal = context.signal;
      context.reportProgress({ message: 'Working' });
      return run.promise;
    });
    assert.equal(controller.getSnapshot().runningComponentIds.has(button.id), true);
    assert.equal(controller.getSnapshot().actionProgress[button.id]?.message, 'Working');

    controller.reset();

    assert.equal(signal?.aborted, true);
    assert.deepEqual(controller.getSnapshot().state, { input: 'Initial' });
    assert.deepEqual(controller.getSnapshot().actionErrors, {});
    assert.deepEqual(controller.getSnapshot().actionProgress, {});
    assert.equal(controller.getSnapshot().runningComponentIds.size, 0);

    run.resolve({ statePatch: { result: 'ignored' } });
    await runPromise;
    assert.equal(controller.getSnapshot().state.result, undefined);
  });

  it('keeps output collapse state transient and scopes it to current output components', () => {
    const output = { id: 'result' as UiComponentId, label: 'Result', stateKey: 'result', type: 'output' as const };
    const controller = createUiGraphInteractionController(makeUiGraph([output]));

    controller.toggleOutputCollapsed(output.id);
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(output.id), true);

    controller.setUiGraph(makeUiGraph([output]));
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(output.id), true);

    controller.setUiGraph(makeUiGraph([]));
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.size, 0);

    controller.toggleOutputCollapsed(output.id);
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.size, 0);

    controller.setUiGraph(makeUiGraph([output]));
    controller.toggleOutputCollapsed(output.id);
    controller.reset();
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.size, 0);
  });

  it('detaches in-flight hosted actions without aborting their remote run', async () => {
    const button = makeButton('run-button', { type: 'runGraph' });
    const controller = createUiGraphInteractionController(makeUiGraph([button]));
    const run = deferred<{ statePatch?: Record<string, unknown> }>();
    let signal: AbortSignal | undefined;
    const runPromise = controller.runAction(button, (context) => {
      signal = context.signal;
      return run.promise;
    });

    controller.detachActions();
    assert.equal(signal?.aborted, false);
    assert.equal(controller.getSnapshot().runningComponentIds.size, 0);

    run.resolve({ statePatch: { result: 'detached' } });
    await runPromise;
    assert.equal(controller.getSnapshot().state.result, undefined);
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

function isHighSurrogateCodeUnit(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogateCodeUnit(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
