import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyUiGraphStatePatch,
  createUiGraphChatHistoryFlushStatePatch,
  createUiGraphChatMessageRemovalStatePatch,
  createUiGraphChatPinStatePatch,
  createUiGraphChatSubmissionStatePatch,
  createUiGraphActionExecutionController,
  createUiGraphInteractionController,
  getUiGraphActionState,
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessagesStateKey,
  getUiGraphChatPins,
  getUiGraphChatPinsStateKey,
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
  type UiGraphChatMessage,
  buildAgentResponseTrace,
  type GraphExecutionMetadata,
  type UiComponentId,
} from '../../src/index.js';
import {
  applyUiGraphWebAppStorageActionPatch,
  applyUiGraphWebAppStoragePatch,
  getUiGraphChatStorageKey,
  getUiGraphWebAppStorageKey,
  getUiGraphChatMessagePresentations,
  hasUiGraphChatPersistentStateChanged,
  loadUiGraphChatPersistentState,
  loadUiGraphWebAppStorage,
  loadUiGraphResponseTrace,
  pruneUiGraphResponseTraces,
  revealUiGraphChatElement,
  saveUiGraphChatPersistentState,
  saveUiGraphResponseTrace,
} from '../../src/model/UiGraphBrowserRuntime.js';

const componentId = 'component' as UiComponentId;

describe('UiGraphRuntimeModel', () => {
  it('persists only valid Chat state per browser app URL and preserves drafts when flushing history', () => {
    const chatId = 'chat' as UiComponentId;
    const uiGraph: UiGraph = {
      components: [{ action: { type: 'runGraph' }, id: chatId, type: 'chat' }],
      id: 'chat-app' as UiGraphId,
      name: 'Chat app',
    };
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => storageValues.delete(key),
      setItem: (key: string, value: string) => storageValues.set(key, value),
    };
    const location = { origin: 'https://example.test', pathname: '/apps/chat/' };
    const draftKey = getUiGraphChatDraftStateKey(chatId);
    const messagesKey = getUiGraphChatMessagesStateKey(chatId);
    const pinsKey = getUiGraphChatPinsStateKey(chatId);
    const state = {
      [draftKey]: 'Unsaved question',
      [messagesKey]: [
        { content: 'First question', role: 'user' },
        { content: 'First response', role: 'assistant' },
      ],
      [pinsKey]: [1, 3, 'invalid'],
      unrelatedPageField: 'do not persist this',
    };

    saveUiGraphChatPersistentState(uiGraph, state, storage, location);
    const storageKey = getUiGraphChatStorageKey(uiGraph, location)!;
    assert.deepEqual(JSON.parse(storageValues.get(storageKey)!), {
      [draftKey]: 'Unsaved question',
      [messagesKey]: state[messagesKey],
      [pinsKey]: [1],
    });
    assert.deepEqual(loadUiGraphChatPersistentState(uiGraph, storage, location), {
      [draftKey]: 'Unsaved question',
      [messagesKey]: state[messagesKey],
      [pinsKey]: [1],
    });
    assert.notEqual(getUiGraphChatStorageKey(uiGraph, { ...location, pathname: '/apps/another-chat' }), storageKey);
    assert.notEqual(
      getUiGraphChatStorageKey({ ...uiGraph, id: 'another-chat-app' as UiGraphId }, location),
      storageKey,
    );

    storageValues.set(storageKey, '{not valid JSON');
    assert.deepEqual(loadUiGraphChatPersistentState(uiGraph, storage, location), {});
    assert.deepEqual(createUiGraphChatHistoryFlushStatePatch(chatId), {
      [messagesKey]: [],
      [pinsKey]: [],
    });
    assert.equal(
      hasUiGraphChatPersistentStateChanged(
        uiGraph,
        { [messagesKey]: state[messagesKey] },
        { [messagesKey]: state[messagesKey], unrelatedPageField: 'updated' },
      ),
      false,
    );
    assert.equal(
      hasUiGraphChatPersistentStateChanged(
        uiGraph,
        { [messagesKey]: state[messagesKey] },
        { [messagesKey]: [...state[messagesKey]] },
      ),
      true,
    );
  });

  it('stores bounded response traces per Chat component and removes orphaned traces', () => {
    const firstChatId = 'chat-a' as UiComponentId;
    const secondChatId = 'chat-b' as UiComponentId;
    const uiGraph: UiGraph = {
      components: [
        { action: { type: 'runGraph' }, allowResponseInspection: true, id: firstChatId, type: 'chat' },
        { action: { type: 'runGraph' }, allowResponseInspection: true, id: secondChatId, type: 'chat' },
      ],
      id: 'trace-app' as UiGraphId,
      name: 'Trace app',
    };
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => storageValues.delete(key),
      setItem: (key: string, value: string) => storageValues.set(key, value),
    };
    const location = { origin: 'https://example.test', pathname: '/apps/traces/' };
    const makeTrace = (index: number) =>
      buildAgentResponseTrace({
        scope: 'response',
        execution: {
          graphId: 'graph',
          graphRunId: `graph-run-${index}`,
          rootRunId: `trace-${index}`,
        } as GraphExecutionMetadata,
        events: [],
        status: 'completed',
      });

    for (let index = 0; index < 101; index += 1) {
      saveUiGraphResponseTrace(uiGraph, firstChatId, makeTrace(index), storage, location);
    }
    saveUiGraphResponseTrace(uiGraph, secondChatId, makeTrace(200), storage, location);

    assert.equal(loadUiGraphResponseTrace(uiGraph, firstChatId, 'trace-0', storage, location), undefined);
    assert.equal(loadUiGraphResponseTrace(uiGraph, firstChatId, 'trace-100', storage, location)?.traceId, 'trace-100');
    assert.equal(loadUiGraphResponseTrace(uiGraph, secondChatId, 'trace-100', storage, location), undefined);
    assert.equal(loadUiGraphResponseTrace(uiGraph, secondChatId, 'trace-200', storage, location)?.traceId, 'trace-200');

    pruneUiGraphResponseTraces(
      uiGraph,
      {
        [getUiGraphChatMessagesStateKey(firstChatId)]: [
          { content: 'kept', responseTraceId: 'trace-100', role: 'assistant' },
        ],
        [getUiGraphChatMessagesStateKey(secondChatId)]: [],
      },
      storage,
      location,
    );

    assert.equal(loadUiGraphResponseTrace(uiGraph, firstChatId, 'trace-99', storage, location), undefined);
    assert.equal(loadUiGraphResponseTrace(uiGraph, firstChatId, 'trace-100', storage, location)?.traceId, 'trace-100');
    assert.equal(loadUiGraphResponseTrace(uiGraph, secondChatId, 'trace-200', storage, location), undefined);
  });

  it('keeps unsynced response traces readable after browser storage rejects a write', () => {
    const chatId = 'quota-chat' as UiComponentId;
    const uiGraph: UiGraph = {
      components: [{ action: { type: 'runGraph' }, allowResponseInspection: true, id: chatId, type: 'chat' }],
      id: 'quota-trace-app' as UiGraphId,
      name: 'Quota trace app',
    };
    const storageValues = new Map<string, string>();
    let rejectWrites = false;
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => {
        if (rejectWrites) throw new Error('storage full');
        storageValues.delete(key);
      },
      setItem: (key: string, value: string) => {
        if (rejectWrites) throw new Error('storage full');
        storageValues.set(key, value);
      },
    };
    const location = { origin: 'https://example.test', pathname: '/apps/quota-traces/' };
    const makeTrace = (index: number) =>
      buildAgentResponseTrace({
        scope: 'response',
        execution: {
          graphId: 'graph',
          graphRunId: `graph-run-${index}`,
          rootRunId: `quota-trace-${index}`,
        } as GraphExecutionMetadata,
        events: [],
        status: 'completed',
      });

    saveUiGraphResponseTrace(uiGraph, chatId, makeTrace(1), storage, location);
    rejectWrites = true;
    saveUiGraphResponseTrace(uiGraph, chatId, makeTrace(2), storage, location);

    assert.equal(
      loadUiGraphResponseTrace(uiGraph, chatId, 'quota-trace-2', storage, location)?.traceId,
      'quota-trace-2',
    );
    assert.equal(
      [...storageValues.values()].some((value) => value.includes('quota-trace-2')),
      false,
    );

    rejectWrites = false;
    saveUiGraphResponseTrace(uiGraph, chatId, makeTrace(3), storage, location);

    assert.equal(
      [...storageValues.values()].some((value) => value.includes('quota-trace-2')),
      true,
    );
    assert.equal(
      loadUiGraphResponseTrace(uiGraph, chatId, 'quota-trace-3', storage, location)?.traceId,
      'quota-trace-3',
    );
  });

  it('purges response trace IDs and data when Chat response inspection is disabled', () => {
    const chatId = 'opt-out-chat' as UiComponentId;
    const enabledUiGraph: UiGraph = {
      components: [{ action: { type: 'runGraph' }, allowResponseInspection: true, id: chatId, type: 'chat' }],
      id: 'opt-out-trace-app' as UiGraphId,
      name: 'Opt-out trace app',
    };
    const disabledUiGraph: UiGraph = {
      ...enabledUiGraph,
      components: [{ action: { type: 'runGraph' }, allowResponseInspection: false, id: chatId, type: 'chat' }],
    };
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => storageValues.delete(key),
      setItem: (key: string, value: string) => storageValues.set(key, value),
    };
    const location = { origin: 'https://example.test', pathname: '/apps/opt-out-traces/' };
    const trace = buildAgentResponseTrace({
      scope: 'response',
      execution: {
        graphId: 'graph',
        graphRunId: 'graph-run',
        rootRunId: 'opt-out-trace',
      } as GraphExecutionMetadata,
      events: [],
      status: 'completed',
    });
    const messagesKey = getUiGraphChatMessagesStateKey(chatId);
    const state = {
      [messagesKey]: [
        { content: 'Question', role: 'user' },
        { content: 'Answer', responseTraceId: trace.traceId, role: 'assistant' },
      ],
    };

    saveUiGraphResponseTrace(enabledUiGraph, chatId, trace, storage, location);
    saveUiGraphChatPersistentState(enabledUiGraph, state, storage, location);
    assert.equal(
      loadUiGraphResponseTrace(enabledUiGraph, chatId, trace.traceId, storage, location)?.traceId,
      trace.traceId,
    );

    saveUiGraphChatPersistentState(disabledUiGraph, state, storage, location);

    assert.deepEqual(loadUiGraphChatPersistentState(disabledUiGraph, storage, location), {
      [messagesKey]: [
        { content: 'Question', role: 'user' },
        { content: 'Answer', role: 'assistant' },
      ],
    });
    assert.equal(loadUiGraphResponseTrace(disabledUiGraph, chatId, trace.traceId, storage, location), undefined);
    assert.equal(
      [...storageValues.values()].some((value) => value.includes(trace.traceId)),
      false,
    );

    saveUiGraphResponseTrace(disabledUiGraph, chatId, trace, storage, location);
    assert.equal(
      [...storageValues.values()].some((value) => value.includes(trace.traceId)),
      false,
    );
  });

  it('isolates graph-managed browser storage by app URL and UI graph ID', () => {
    const uiGraph: UiGraph = { components: [], id: 'settings-app' as UiGraphId, name: 'Settings app' };
    const otherUiGraph: UiGraph = { ...uiGraph, id: 'other-app' as UiGraphId };
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      removeItem: (key: string) => storageValues.delete(key),
      setItem: (key: string, value: string) => storageValues.set(key, value),
    };
    const location = { origin: 'https://example.test', pathname: '/apps/settings/' };

    const stored = applyUiGraphWebAppStoragePatch(
      uiGraph,
      { existing: 'kept' },
      { preferences: { density: 'compact', sidebarOpen: false } },
      storage,
      location,
    );

    assert.deepEqual(stored, {
      existing: 'kept',
      preferences: { density: 'compact', sidebarOpen: false },
    });
    assert.deepEqual(loadUiGraphWebAppStorage(uiGraph, storage, location), stored);
    assert.deepEqual(loadUiGraphWebAppStorage(otherUiGraph, storage, location), {});
    assert.deepEqual(loadUiGraphWebAppStorage(uiGraph, storage, { ...location, pathname: '/apps/another/' }), {});
    assert.notEqual(getUiGraphWebAppStorageKey(uiGraph, location), getUiGraphWebAppStorageKey(otherUiGraph, location));
  });

  it('commits action ordering only after a storage patch is persisted successfully', () => {
    const appliedActionByKey = new Map<string, number>();
    const persisted: Record<string, unknown>[] = [];

    assert.throws(
      () =>
        applyUiGraphWebAppStorageActionPatch({ shared: 'newer' }, 2, appliedActionByKey, () => {
          throw new Error('storage full');
        }),
      /storage full/,
    );
    assert.equal(appliedActionByKey.has('shared'), false);

    assert.deepEqual(
      applyUiGraphWebAppStorageActionPatch({ shared: 'older', unrelated: true }, 1, appliedActionByKey, (patch) => {
        persisted.push(patch);
      }),
      { shared: 'older', unrelated: true },
    );
    assert.deepEqual(persisted, [{ shared: 'older', unrelated: true }]);
    assert.deepEqual(
      [...appliedActionByKey],
      [
        ['shared', 1],
        ['unrelated', 1],
      ],
    );

    assert.deepEqual(
      applyUiGraphWebAppStorageActionPatch({ shared: 'stale', third: 3 }, 0, appliedActionByKey, (patch) => {
        persisted.push(patch);
      }),
      { third: 3 },
    );
    assert.deepEqual(persisted[1], { third: 3 });
    assert.equal(appliedActionByKey.get('shared'), 1);
    assert.equal(appliedActionByKey.get('third'), 0);
  });

  it('creates one render model for every supported component kind', () => {
    const state = { answer: { value: 42 }, prompt: 'Hello' };
    const components: UiGraphComponent[] = [
      { id: componentId, text: 'Static text', type: 'text' },
      { id: componentId, markdown: '**Markdown**', type: 'markdown' },
      { id: componentId, size: 'large', type: 'gap' },
      { id: componentId, label: 'Prompt', stateKey: 'prompt', type: 'input' },
      { id: componentId, label: '', stateKey: 'prompt', type: 'textarea' },
      {
        id: componentId,
        items: [{ label: 'Friendly', value: 'friendly' }],
        label: 'Tone',
        stateKey: 'tone',
        type: 'dropdown',
      },
      { id: componentId, label: 'Run', action: { type: 'runGraph' }, type: 'button' },
      { id: componentId, action: { type: 'runGraph' }, type: 'chat' },
      { id: componentId, label: 'Answer', stateKey: 'answer', renderAs: 'json', type: 'output' },
    ];

    const models = components.map((component) => getUiGraphComponentRenderModel(component, state));

    assert.deepEqual(
      models.map((model) => model.type),
      ['text', 'markdown', 'gap', 'input', 'textarea', 'dropdown', 'button', 'chat', 'output'],
    );
    assert.equal(models[2]?.type === 'gap' && models[2].size, 'large');
    assert.equal(models[3]?.type === 'input' && models[3].value, 'Hello');
    assert.equal(models[4]?.type === 'textarea' && models[4].label, 'prompt');
    assert.equal(models[5]?.type === 'dropdown' && models[5].value, '');
    assert.equal(models[7]?.type === 'chat' && models[7].messages.length, 0);
    assert.equal(models[8]?.type === 'output' && models[8].output.renderedValue, '{\n  "value": 42\n}');
  });

  it('keeps dropdown state within its declared option values', () => {
    const dropdown: UiGraphComponent = {
      id: componentId,
      items: [
        { label: 'Friendly', value: 'friendly' },
        { label: 'Direct', value: 'direct' },
      ],
      label: 'Tone',
      stateKey: 'tone',
      type: 'dropdown',
    };

    const selected = getUiGraphComponentRenderModel(dropdown, { tone: 'direct' });
    const stale = getUiGraphComponentRenderModel(dropdown, { tone: 'removed' });

    assert.equal(selected.type === 'dropdown' && selected.value, 'direct');
    assert.equal(stale.type === 'dropdown' && stale.value, '');
  });

  it('clears a removed dropdown value before a later action can use stale state', () => {
    const dropdown = {
      id: componentId,
      items: [
        { label: 'Friendly', value: 'friendly' },
        { label: 'Direct', value: 'direct' },
      ],
      label: 'Tone',
      stateKey: 'tone',
      type: 'dropdown' as const,
    };
    const uiGraph: UiGraph = {
      components: [dropdown],
      id: 'dropdown-app' as UiGraphId,
      name: 'Dropdown app',
    };
    const controller = createUiGraphInteractionController(uiGraph);

    controller.updateState('tone', 'direct');
    controller.setUiGraph({ ...uiGraph, components: [{ ...dropdown, items: [dropdown.items[0]!] }] });

    assert.equal(controller.getSnapshot().state.tone, '');
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
    const previousTimestamp = '2026-07-22T08:00:00.000Z';
    const timestamp = '2026-07-22T08:15:00.000Z';
    const initialState = {
      [draftKey]: '  Hello  ',
      [messagesKey]: [{ role: 'assistant', content: 'Welcome', timestamp: previousTimestamp }],
      tone: 'Friendly',
    };
    const submission = createUiGraphChatSubmissionStatePatch(chat.id, initialState, timestamp)!;
    const submittedState = applyUiGraphStatePatch(initialState, submission);
    const actionState = getUiGraphComponentActionState(chat, submittedState);

    assert.deepEqual(submission, {
      [draftKey]: '',
      [messagesKey]: [
        { role: 'assistant', content: 'Welcome', timestamp: previousTimestamp },
        { role: 'user', content: 'Hello', timestamp },
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
          { role: 'assistant', content: 'Welcome', timestamp: previousTimestamp },
          { role: 'user', content: 'Hello', timestamp },
          { role: 'assistant', content: 'Hi there' },
        ],
      },
    );
  });

  it('formats Chat timestamps locally, separates later dates, and keeps malformed legacy timestamps undated', () => {
    const presentations = getUiGraphChatMessagePresentations(
      [
        { role: 'user', content: 'First', timestamp: '2026-07-20T23:45:00.000Z' },
        { role: 'assistant', content: 'Second', timestamp: '2026-07-20T23:46:00.000Z' },
        { role: 'user', content: 'Third', timestamp: '2026-07-21T00:05:00.000Z' },
        { role: 'assistant', content: 'Legacy' },
        { role: 'assistant', content: 'Malformed', timestamp: 'not-a-date' },
      ],
      { locales: 'en-GB', timeZone: 'UTC' },
    );

    assert.deepEqual(presentations[0]?.timestamp, { dateTime: '2026-07-20T23:45:00.000Z', label: '23:45' });
    assert.equal(presentations[0]?.dateSeparator, undefined);
    assert.deepEqual(presentations[1]?.timestamp, {
      dateTime: '2026-07-20T23:46:00.000Z',
      elapsedSincePreviousUserMessage: '60 seconds after previous user message',
      label: '23:46',
    });
    assert.equal(presentations[1]?.dateSeparator, undefined);
    assert.deepEqual(presentations[2]?.dateSeparator, {
      dateTime: '2026-07-21T00:05:00.000Z',
      label: '21 July 2026',
    });
    assert.deepEqual(presentations[3], {});
    assert.deepEqual(presentations[4], {});

    const oneDatePresentations = getUiGraphChatMessagePresentations(
      [
        { role: 'user', content: 'One', timestamp: '2026-07-22T08:00:00.000Z' },
        { role: 'assistant', content: 'Two', timestamp: '2026-07-22T18:00:00.000Z' },
      ],
      { locales: 'en-GB', timeZone: 'UTC' },
    );
    assert.equal(oneDatePresentations[0]?.dateSeparator, undefined);
    assert.equal(oneDatePresentations[1]?.dateSeparator, undefined);
    assert.equal(
      oneDatePresentations[1]?.timestamp?.elapsedSincePreviousUserMessage,
      '36000 seconds after previous user message',
    );

    const malformedUserTimestampPresentations = getUiGraphChatMessagePresentations(
      [
        { role: 'user', content: 'First', timestamp: '2026-07-22T08:00:00.000Z' },
        { role: 'assistant', content: 'First response', timestamp: '2026-07-22T08:00:02.000Z' },
        { role: 'user', content: 'Legacy user', timestamp: 'not-a-date' },
        { role: 'assistant', content: 'Second response', timestamp: '2026-07-22T08:00:04.000Z' },
      ],
      { locales: 'en-GB', timeZone: 'UTC' },
    );
    assert.equal(
      malformedUserTimestampPresentations[3]?.timestamp?.elapsedSincePreviousUserMessage,
      undefined,
      'a malformed closest user timestamp must not reuse an older user turn',
    );
  });

  it('stamps a Chat response when the interaction controller receives its action result', async () => {
    const chat = { action: { type: 'runGraph' as const }, id: componentId, type: 'chat' as const };
    const uiGraph = { components: [chat], id: 'chat-app' as UiGraphId, name: 'Chat app' };
    const messagesKey = getUiGraphChatMessagesStateKey(componentId);
    const controller = createUiGraphInteractionController(uiGraph);
    controller.updateStatePatch({ [messagesKey]: [{ role: 'user', content: 'Question' }] });

    await controller.runAction(chat, async () => ({
      statePatch: {
        [messagesKey]: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: 'Answer' },
        ],
      },
    }));

    const messages = controller.getSnapshot().state[messagesKey] as UiGraphChatMessage[];
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(typeof messages[1]?.timestamp, 'string');
    assert.equal(Number.isNaN(new Date(messages[1]!.timestamp!).getTime()), false);

    const responseTrace = buildAgentResponseTrace({
      scope: 'response',
      execution: { graphId: 'graph', graphRunId: 'graph-run', rootRunId: 'trace-id' } as GraphExecutionMetadata,
      events: [],
      status: 'completed',
    });
    await controller.runAction(chat, async () => ({
      responseTrace,
      statePatch: {
        [messagesKey]: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: 'Inspection disabled' },
        ],
      },
    }));
    assert.equal((controller.getSnapshot().state[messagesKey] as UiGraphChatMessage[])[1]?.responseTraceId, undefined);

    const inspectedChat = { ...chat, allowResponseInspection: true };
    controller.setUiGraph({ ...uiGraph, components: [inspectedChat] });
    await controller.runAction(inspectedChat, async () => ({
      responseTrace,
      statePatch: {
        [messagesKey]: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: 'Inspection enabled' },
        ],
      },
    }));
    assert.equal((controller.getSnapshot().state[messagesKey] as UiGraphChatMessage[])[1]?.responseTraceId, 'trace-id');
  });

  it('keeps Chat pins in session state without exposing stale or non-assistant entries', () => {
    const messagesKey = getUiGraphChatMessagesStateKey(componentId);
    const pinsKey = getUiGraphChatPinsStateKey(componentId);
    const state = {
      [messagesKey]: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Second answer' },
        { role: 'assistant', content: 'Second follow-up' },
      ],
      [pinsKey]: [4, 3, 1, 3, 2, 99, -1, 'invalid'],
    };

    assert.deepEqual(getUiGraphChatPins(componentId, state), [
      {
        messageIndex: 1,
        prompt: { role: 'user', content: 'First question' },
        promptMessageIndex: 0,
        response: { role: 'assistant', content: 'First answer' },
      },
      {
        messageIndex: 3,
        prompt: { role: 'user', content: 'Second question' },
        promptMessageIndex: 2,
        response: { role: 'assistant', content: 'Second answer' },
      },
      {
        messageIndex: 4,
        prompt: { role: 'user', content: 'Second question' },
        promptMessageIndex: 2,
        response: { role: 'assistant', content: 'Second follow-up' },
      },
    ]);
    assert.deepEqual(createUiGraphChatPinStatePatch(componentId, state, 1), { [pinsKey]: [3, 4] });
    assert.deepEqual(createUiGraphChatPinStatePatch(componentId, state, 2), undefined);
    assert.deepEqual(createUiGraphChatPinStatePatch(componentId, { ...state, [pinsKey]: [1] }, 3), {
      [pinsKey]: [1, 3],
    });
    assert.deepEqual(createUiGraphChatMessageRemovalStatePatch(componentId, state, 1), {
      [messagesKey]: [
        { role: 'user', content: 'First question' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Second answer' },
        { role: 'assistant', content: 'Second follow-up' },
      ],
      [pinsKey]: [2, 3],
    });
    assert.deepEqual(createUiGraphChatMessageRemovalStatePatch(componentId, state, 3), {
      [messagesKey]: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Second follow-up' },
      ],
      [pinsKey]: [1, 3],
    });
    assert.equal(createUiGraphChatMessageRemovalStatePatch(componentId, state, -1), undefined);
    assert.equal(createUiGraphChatMessageRemovalStatePatch(componentId, state, 99), undefined);
    assert.deepEqual(
      getUiGraphComponentActionState(
        { action: { type: 'runGraph' }, id: componentId, type: 'chat' },
        { ...state, tone: 'Friendly' },
      ),
      { [messagesKey]: state[messagesKey] },
    );
  });

  it('top-aligns a pinned Chat question without changing the shared default alignment', () => {
    const messagesElement = {
      clientHeight: 300,
      contains: () => true,
      getBoundingClientRect: () => ({ top: 100 }),
      scrollHeight: 1_200,
      scrollTop: 100,
    } as unknown as HTMLElement;
    const messageElement = {
      getBoundingClientRect: () => ({ height: 80, top: 400 }),
    } as unknown as HTMLElement;

    revealUiGraphChatElement(messagesElement, messageElement, 'start');

    assert.equal(messagesElement.scrollTop, 400);

    messagesElement.scrollTop = 100;
    revealUiGraphChatElement(messagesElement, messageElement);

    assert.equal(messagesElement.scrollTop, 290);
  });

  it('clears Chat pins with the rest of the app session state', () => {
    const chat = { action: { type: 'runGraph' as const }, id: componentId, type: 'chat' as const };
    const uiGraph = { components: [chat], id: 'chat-app' as UiGraphId, name: 'Chat app' };
    const pinsKey = getUiGraphChatPinsStateKey(componentId);
    const controller = createUiGraphInteractionController(uiGraph);

    controller.updateStatePatch({
      [getUiGraphChatMessagesStateKey(componentId)]: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
      [pinsKey]: [1],
    });
    assert.equal(getUiGraphChatPins(componentId, controller.getSnapshot().state).length, 1);

    controller.reset();

    assert.deepEqual(controller.getSnapshot().state[pinsKey], []);
    assert.deepEqual(getUiGraphChatPins(componentId, controller.getSnapshot().state), []);
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

  it('delays visible Button loading presentation without delaying the action itself', async () => {
    const button = makeButton('run-button', { type: 'runGraph' });
    const controller = createUiGraphInteractionController(makeUiGraph([button]));

    await controller.runAction(button, async () => ({ statePatch: { result: 'fast' } }));
    assert.equal(controller.getSnapshot().loadingComponentIds.size, 0);

    const run = deferred<{ statePatch?: Record<string, unknown> }>();
    const runPromise = controller.runAction(button, () => run.promise);
    assert.equal(controller.getSnapshot().runningComponentIds.has(button.id), true);
    assert.equal(controller.getSnapshot().loadingComponentIds.has(button.id), false);

    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(controller.getSnapshot().loadingComponentIds.has(button.id), true);

    run.resolve({});
    await runPromise;
    assert.equal(controller.getSnapshot().loadingComponentIds.size, 0);
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

  it('aborts an active action whose execution definition changes without interrupting a label edit', async () => {
    const button = makeButton('run-button', {
      outputs: [{ stateKey: 'old-result' }],
      type: 'runGraph',
    });
    const controller = createUiGraphInteractionController(makeUiGraph([button]));
    const outdatedRun = deferred<{ statePatch?: Record<string, unknown> }>();
    let outdatedSignal: AbortSignal | undefined;
    const outdatedPromise = controller.runAction(button, ({ reportProgress, signal }) => {
      outdatedSignal = signal;
      reportProgress({ message: 'Using old bindings' });
      return outdatedRun.promise;
    });

    const editedButton = {
      ...button,
      action: { ...button.action, outputs: [{ stateKey: 'new-result' }] },
    };
    controller.setUiGraph(makeUiGraph([editedButton]));
    assert.equal(outdatedSignal?.aborted, true);
    assert.equal(controller.getSnapshot().runningComponentIds.size, 0);
    assert.equal(controller.getSnapshot().actionProgress[button.id], undefined);

    outdatedRun.resolve({ statePatch: { 'old-result': 'ignored' } });
    await outdatedPromise;
    assert.equal(controller.getSnapshot().state['old-result'], undefined);

    const currentRun = deferred<{ statePatch?: Record<string, unknown> }>();
    let currentSignal: AbortSignal | undefined;
    const currentPromise = controller.runAction(editedButton, ({ signal }) => {
      currentSignal = signal;
      return currentRun.promise;
    });
    controller.setUiGraph(makeUiGraph([{ ...editedButton, label: 'Renamed button' }]));
    assert.equal(currentSignal?.aborted, false);

    currentRun.resolve({ statePatch: { 'new-result': 'kept' } });
    await currentPromise;
    assert.equal(controller.getSnapshot().state['new-result'], 'kept');
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

  it('unfolds collapsed outputs when their rendered value is added or updated', async () => {
    const firstOutput = { id: 'first' as UiComponentId, stateKey: 'result', type: 'output' as const };
    const secondOutput = { id: 'second' as UiComponentId, stateKey: 'result', type: 'output' as const };
    const unrelatedOutput = { id: 'other' as UiComponentId, stateKey: 'other', type: 'output' as const };
    const button = makeButton('run-button', { outputs: [{ stateKey: 'result' }], type: 'runGraph' });
    const controller = createUiGraphInteractionController(
      makeUiGraph([button, firstOutput, secondOutput, unrelatedOutput]),
    );

    for (const output of [firstOutput, secondOutput, unrelatedOutput]) {
      controller.toggleOutputCollapsed(output.id);
    }

    controller.updateState('result', 'Direct value');
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(firstOutput.id), false);
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(secondOutput.id), false);
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(unrelatedOutput.id), true);

    controller.toggleOutputCollapsed(firstOutput.id);
    controller.updateStatePatch({ result: '' });
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(firstOutput.id), true);

    await controller.runAction(button, async () => ({ statePatch: { result: 'Action value' } }));
    assert.equal(controller.getSnapshot().collapsedOutputComponentIds.has(firstOutput.id), false);
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
