import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  normalizeProjectUiGraphs,
  normalizeUiGraph,
  normalizeUiGraphComponentIds,
  normalizeUiGraphRecord,
  UiGraphNormalizationError,
  type GraphId,
  type Project,
  type UiGraph,
} from '../../src/index.js';

void describe('UI graph normalization', () => {
  void it('accepts every supported component and action shape without cloning valid data', () => {
    const uiGraph = makeUiGraph();

    assert.equal(normalizeUiGraph(uiGraph), uiGraph);
    assert.equal(normalizeUiGraphRecord({ app: uiGraph }).app, uiGraph);
  });

  void it('repairs only missing and duplicate legacy component IDs without mutating the source', () => {
    const uiGraph = {
      ...makeUiGraph(),
      components: [
        { text: 'Missing ID', type: 'text' },
        { id: 'shared', text: 'First', type: 'text' },
        { id: 'shared', text: 'Duplicate', type: 'text' },
      ],
    };

    const normalized = normalizeUiGraph(uiGraph);

    assert.deepEqual(
      normalized.components.map((component) => component.id),
      ['app-component-1', 'shared', 'app-component-3'],
    );
    assert.notEqual(normalized, uiGraph);
    assert.equal('id' in uiGraph.components[0]!, false);
  });

  void it('preserves supported legacy action mappings', () => {
    const uiGraph = {
      components: [
        {
          action: {
            graphId: 'graph',
            inputs: {
              prompt: { key: 'question', type: 'state' },
              temperature: { type: 'literal', value: 0 },
            },
            outputKey: 'answer',
            outputStateKey: 'result',
            type: 'runGraph',
          },
          id: 'button',
          label: 'Run',
          type: 'button',
        },
      ],
      id: 'legacy',
      name: 'Legacy',
    };

    assert.equal(normalizeUiGraph(uiGraph), uiGraph);
  });

  void it('reports unsupported components and missing fields with component-index paths', () => {
    const error = captureNormalizationError(() =>
      normalizeUiGraph({
        components: [
          { id: 'unknown', type: 'video' },
          { id: 'input', label: 'Question', type: 'input' },
          { action: { type: 'request' }, id: 'button', label: 'Run', type: 'button' },
          { id: 'gap', size: 'huge', type: 'gap' },
          { id: 'output', renderAs: 'html', stateKey: 'result', type: 'output' },
        ],
        id: 'broken',
        name: 'Broken app',
      }),
    );

    assert.deepEqual(
      error.issues.map((issue) => issue.path),
      [
        'UI graph "broken" component at index 0.type',
        'UI graph "broken" component at index 1.stateKey',
        'UI graph "broken" component at index 2.action.type',
        'UI graph "broken" component at index 3.size',
        'UI graph "broken" component at index 4.renderAs',
      ],
    );
  });

  void it('requires the declared content fields for every component discriminator', () => {
    const error = captureNormalizationError(() =>
      normalizeUiGraph({
        components: [
          { id: 'text', type: 'text' },
          { id: 'markdown', type: 'markdown' },
          { id: 'input-label', stateKey: 'input', type: 'input' },
          { id: 'input-state', label: 'Input', type: 'input' },
          { id: 'textarea-label', stateKey: 'input', type: 'textarea' },
          { id: 'textarea-state', label: 'Input', type: 'textarea' },
          { action: { type: 'runGraph' }, id: 'button-label', type: 'button' },
          { id: 'button-action', label: 'Run', type: 'button' },
          { id: 'output', type: 'output' },
        ],
        id: 'required-fields',
        name: 'Required fields',
      }),
    );

    assert.deepEqual(
      error.issues.map((issue) => issue.path),
      [
        'UI graph "required-fields" component at index 0.text',
        'UI graph "required-fields" component at index 1.markdown',
        'UI graph "required-fields" component at index 2.label',
        'UI graph "required-fields" component at index 3.stateKey',
        'UI graph "required-fields" component at index 4.label',
        'UI graph "required-fields" component at index 5.stateKey',
        'UI graph "required-fields" component at index 6.label',
        'UI graph "required-fields" component at index 7.action',
        'UI graph "required-fields" component at index 8.stateKey',
      ],
    );
  });

  void it('rejects wrong runtime types in graph, component, and action optional fields', () => {
    const error = captureNormalizationError(() =>
      normalizeUiGraph({
        components: [
          {
            defaultValue: false,
            id: 'input',
            label: 'Input',
            placeholder: 42,
            stateKey: 'input',
            type: 'input',
          },
          {
            action: {
              graphId: 42,
              outputKey: false,
              outputStateKey: {},
              type: 'runGraph',
            },
            id: 'button',
            label: 'Run',
            type: 'button',
          },
          { id: 'output', label: 42, stateKey: 'result', type: 'output' },
        ],
        description: false,
        id: 'wrong-types',
        name: 'Wrong types',
      }),
    );

    assert.deepEqual(
      error.issues.map((issue) => issue.path),
      [
        'UI graph "wrong-types".description',
        'UI graph "wrong-types" component at index 0.placeholder',
        'UI graph "wrong-types" component at index 0.defaultValue',
        'UI graph "wrong-types" component at index 1.action.graphId',
        'UI graph "wrong-types" component at index 1.action.outputKey',
        'UI graph "wrong-types" component at index 1.action.outputStateKey',
        'UI graph "wrong-types" component at index 2.label',
      ],
    );
  });

  void it('reports malformed modern and legacy action bindings at their exact indexes and keys', () => {
    const error = captureNormalizationError(() =>
      normalizeUiGraph({
        components: [
          {
            action: {
              inputMappings: [{ inputKey: 'prompt' }],
              inputs: {
                literal: { type: 'literal' },
                state: { type: 'state' },
                unsupported: { type: 'environment' },
              },
              outputs: [{ outputKey: 'answer' }],
              type: 'runGraph',
            },
            id: 'button',
            label: 'Run',
            type: 'button',
          },
        ],
        id: 'broken-action',
        name: 'Broken action',
      }),
    );

    assert.deepEqual(
      error.issues.map((issue) => issue.path),
      [
        'UI graph "broken-action" component at index 0.action.inputMappings at index 0.stateKey',
        'UI graph "broken-action" component at index 0.action.inputs["literal"].value',
        'UI graph "broken-action" component at index 0.action.inputs["state"].key',
        'UI graph "broken-action" component at index 0.action.inputs["unsupported"].type',
        'UI graph "broken-action" component at index 0.action.outputs at index 0.stateKey',
      ],
    );
  });

  void it('rejects mismatched project keys and can disable legacy ID repair for raw validation', () => {
    const mismatched = captureNormalizationError(() => normalizeUiGraphRecord({ expected: makeUiGraph() }));
    assert.equal(mismatched.issues[0]?.path, 'UI graph "expected".id');

    const duplicate = captureNormalizationError(() =>
      normalizeUiGraph(
        {
          components: [
            { id: 'same', text: 'One', type: 'text' },
            { id: 'same', text: 'Two', type: 'text' },
          ],
          id: 'app',
          name: 'App',
        },
        { repairComponentIds: false },
      ),
    );
    assert.match(duplicate.issues[0]?.message ?? '', /duplicates component id/);
  });

  void it('does not treat malformed collections or wrong-type IDs as legacy missing IDs', () => {
    const collectionError = captureNormalizationError(() => normalizeUiGraphRecord(null));
    assert.equal(collectionError.issues[0]?.path, 'Project uiGraphs');

    const componentError = captureNormalizationError(() =>
      normalizeUiGraph({
        components: [{ id: 42, text: 'Text', type: 'text' }],
        id: 'app',
        name: 'App',
      }),
    );
    assert.deepEqual(componentError.issues[0], {
      message: 'must be a string',
      path: 'UI graph "app" component at index 0.id',
    });
  });

  void it('rejects sparse component and action-binding arrays', () => {
    const sparseComponents = new Array<unknown>(1);
    const componentError = captureNormalizationError(() =>
      normalizeUiGraph({ components: sparseComponents, id: 'app', name: 'App' }),
    );
    assert.deepEqual(componentError.issues[0], {
      message: 'must be an object',
      path: 'UI graph "app" component at index 0',
    });

    const sparseInputMappings = new Array<unknown>(1);
    const sparseOutputs = new Array<unknown>(1);
    const bindingError = captureNormalizationError(() =>
      normalizeUiGraph({
        components: [
          {
            action: { inputMappings: sparseInputMappings, outputs: sparseOutputs, type: 'runGraph' },
            id: 'button',
            label: 'Run',
            type: 'button',
          },
        ],
        id: 'app',
        name: 'App',
      }),
    );
    assert.deepEqual(
      bindingError.issues.map((issue) => issue.path),
      [
        'UI graph "app" component at index 0.action.inputMappings at index 0',
        'UI graph "app" component at index 0.action.outputs at index 0',
      ],
    );
  });

  void it('keeps the legacy component-ID helper scoped to ID repair', () => {
    const malformedComponentGraph = {
      components: [{ label: 'Missing state key', type: 'input' }],
      id: 'app',
      name: 'App',
    } as unknown as UiGraph;

    const repaired = normalizeUiGraphComponentIds(malformedComponentGraph);

    assert.equal(repaired.components[0]?.id, 'app-component-1');
    assert.throws(() => normalizeUiGraph(malformedComponentGraph), UiGraphNormalizationError);
  });

  void it('repairs graphs under special object keys without invoking prototype setters', () => {
    const uiGraphs = Object.fromEntries([
      [
        '__proto__',
        {
          components: [{ text: 'Legacy', type: 'text' }],
          id: '__proto__',
          name: 'Special key',
        },
      ],
    ]);

    const normalized = normalizeUiGraphRecord(uiGraphs);

    assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
    assert.equal(Object.hasOwn(normalized, '__proto__'), true);
    assert.equal(normalized['__proto__' as never]?.components[0]?.id, '__proto__-component-1');
  });

  void it('normalizes hosted project snapshots without cloning unaffected projects', () => {
    const project = makeProject(makeUiGraph());
    assert.equal(normalizeProjectUiGraphs(project), project);

    const legacyProject = makeProject({
      ...makeUiGraph(),
      components: [{ text: 'Legacy', type: 'text' } as never],
    });
    const normalized = normalizeProjectUiGraphs(legacyProject);

    assert.notEqual(normalized, legacyProject);
    assert.equal(normalized.uiGraphs?.app?.components[0]?.id, 'app-component-1');
  });
});

function makeUiGraph(): UiGraph {
  return {
    components: [
      { id: 'text' as never, text: 'Text', type: 'text' },
      { id: 'markdown' as never, markdown: '**Markdown**', type: 'markdown' },
      { id: 'gap' as never, size: 'medium', type: 'gap' },
      {
        defaultValue: 'Default',
        id: 'input' as never,
        label: 'Input',
        placeholder: 'Type here',
        stateKey: 'input',
        type: 'input',
      },
      { id: 'textarea' as never, label: 'Prompt', stateKey: 'prompt', type: 'textarea' },
      {
        action: {
          graphId: 'graph' as GraphId,
          inputMappings: [{ inputKey: 'input', stateKey: 'prompt' }],
          outputs: [{ outputKey: 'answer', stateKey: 'result' }],
          type: 'runGraph',
        },
        id: 'button' as never,
        label: 'Run',
        type: 'button',
      },
      { id: 'output' as never, label: 'Result', renderAs: 'markdown', stateKey: 'result', type: 'output' },
    ],
    description: 'Description',
    id: 'app' as never,
    name: 'App',
  };
}

function makeProject(uiGraph: UiGraph): Project {
  return {
    graphs: {},
    metadata: { id: 'project' as never, title: 'Project' },
    uiGraphs: { app: uiGraph } as Project['uiGraphs'],
  };
}

function captureNormalizationError(run: () => unknown): UiGraphNormalizationError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof UiGraphNormalizationError);
    return error;
  }
  assert.fail('Expected UI graph normalization to fail');
}
