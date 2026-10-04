import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  clearCodeEditorModelCache,
  clearCodeEditorModelCacheForProject,
  getCachedCodeEditorModelCount,
  getCodeEditorViewState,
  getOrCreateCodeEditorModel,
  saveCodeEditorViewState,
  acknowledgeCodeEditorModelSource,
} from './codeEditorModelCache.js';
import { buildCodeEditorModelCacheKey } from './codeEditorModelCacheKey.js';

class FakeTextModel {
  disposed = false;

  constructor(private value: string) {}

  getValue() {
    return this.value;
  }

  setValue(value: string) {
    this.value = value;
  }

  dispose() {
    this.disposed = true;
  }
}

function createFakeModel(value: string) {
  return new FakeTextModel(value) as any;
}

afterEach(() => {
  clearCodeEditorModelCache();
});
test('buildCodeEditorModelCacheKey requires project, graph, node, and editor identity', () => {
  assert.equal(
    buildCodeEditorModelCacheKey({
      projectId: 'project',
      graphId: 'graph',
      nodeId: 'node',
      editorKey: 'code',
      language: 'javascript',
      interpolationSyntax: 'js-value',
    }),
    'project:project|graph:graph|node:node|editor:code|language:javascript|interpolation:js-value',
  );
  assert.equal(buildCodeEditorModelCacheKey({ projectId: 'project', graphId: 'graph', nodeId: 'node' }), undefined);
});

test('getOrCreateCodeEditorModel reuses the same cached model and refreshes stale text', () => {
  const first = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'one',
    createModel: () => createFakeModel('one'),
  });

  const second = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'two',
    createModel: () => createFakeModel('never used'),
  });

  assert.equal(second.model, first.model);
  assert.equal(second.model.getValue(), 'two');
  assert.equal(getCachedCodeEditorModelCount(), 1);
});

test('getOrCreateCodeEditorModel does not overwrite warm edits with the same stale input text', () => {
  const first = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'one',
    createModel: () => createFakeModel('one'),
  });

  first.model.setValue('edited');

  const second = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'one',
    createModel: () => createFakeModel('never used'),
  });

  assert.equal(second.model, first.model);
  assert.equal(second.model.getValue(), 'edited');
});

test('getOrCreateCodeEditorModel clears stale view state when cached text is externally refreshed', () => {
  getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'one',
    createModel: () => createFakeModel('one'),
  });
  saveCodeEditorViewState('key', { cursorState: [], viewState: {} } as any);

  getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'two',
    createModel: () => createFakeModel('never used'),
  });

  assert.equal(getCodeEditorViewState('key'), undefined);
});

test('getOrCreateCodeEditorModel returns uncached models without retaining them', () => {
  const first = getOrCreateCodeEditorModel({
    cacheKey: undefined,
    text: 'one',
    createModel: () => createFakeModel('one'),
  });
  const second = getOrCreateCodeEditorModel({
    cacheKey: undefined,
    text: 'one',
    createModel: () => createFakeModel('one'),
  });

  assert.notEqual(second.model, first.model);
  assert.equal(first.isCached, false);
  assert.equal(getCachedCodeEditorModelCount(), 0);
});

test('getOrCreateCodeEditorModel adopts existing Monaco models before creating duplicate uri models', () => {
  const existing = createFakeModel('warm-edit');
  const result = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'one',
    getExistingModel: () => existing,
    createModel: () => createFakeModel('never used'),
  });

  assert.equal(result.model, existing);
  assert.equal(result.model.getValue(), 'warm-edit');
  assert.equal(getCachedCodeEditorModelCount(), 1);
});

test('clearCodeEditorModelCacheForProject disposes only that project models', () => {
  const projectAKey = buildCodeEditorModelCacheKey({
    projectId: 'project-a',
    graphId: 'graph',
    nodeId: 'node',
    editorKey: 'code',
  })!;
  const projectBKey = buildCodeEditorModelCacheKey({
    projectId: 'project-b',
    graphId: 'graph',
    nodeId: 'node',
    editorKey: 'code',
  })!;

  const projectAModel = getOrCreateCodeEditorModel({
    cacheKey: projectAKey,
    text: 'a',
    createModel: () => createFakeModel('a'),
  }).model as unknown as FakeTextModel;
  const projectBModel = getOrCreateCodeEditorModel({
    cacheKey: projectBKey,
    text: 'b',
    createModel: () => createFakeModel('b'),
  }).model as unknown as FakeTextModel;
  const projectAViewState = { cursorState: [], viewState: {} } as any;
  const projectBViewState = { cursorState: [{ inSelectionMode: false }], viewState: {} } as any;

  saveCodeEditorViewState(projectAKey, projectAViewState);
  saveCodeEditorViewState(projectBKey, projectBViewState);

  clearCodeEditorModelCacheForProject('project-a');

  assert.equal(projectAModel.disposed, true);
  assert.equal(projectBModel.disposed, false);
  assert.equal(getCachedCodeEditorModelCount(), 1);
  assert.equal(getCodeEditorViewState(projectAKey), undefined);
  assert.equal(getCodeEditorViewState(projectBKey), projectBViewState);
});

test('model cache evicts oldest models', () => {
  const models: FakeTextModel[] = [];
  for (let index = 0; index < 13; index++) {
    const model = getOrCreateCodeEditorModel({
      cacheKey: `project:p|graph:g|node:n-${index}|editor:code|language:none|interpolation:none`,
      text: String(index),
      createModel: () => {
        const fakeModel = createFakeModel(String(index)) as unknown as FakeTextModel;
        models.push(fakeModel);
        return fakeModel as any;
      },
    }).model;

    assert.equal(model.getValue(), String(index));
  }

  assert.equal(models[0]!.disposed, true);
  assert.equal(models[12]!.disposed, false);
  assert.equal(getCachedCodeEditorModelCount(), 12);
});

test('model cache evicts matching editor view state', () => {
  const firstKey = 'project:p|graph:g|node:n-0|editor:code|language:none|interpolation:none';
  saveCodeEditorViewState(firstKey, { cursorState: [], viewState: {} } as any);

  for (let index = 0; index < 13; index++) {
    getOrCreateCodeEditorModel({
      cacheKey: `project:p|graph:g|node:n-${index}|editor:code|language:none|interpolation:none`,
      text: String(index),
      createModel: () => createFakeModel(String(index)),
    });
  }

  assert.equal(getCodeEditorViewState(firstKey), undefined);
});

test('variant, library, and reload generations never share editable models', () => {
  const owner = { projectId: 'p', graphId: 'g', nodeId: 'n', editorKey: 'code' };
  const keys = [
    buildCodeEditorModelCacheKey({ ...owner, scope: 'graph/current' }),
    buildCodeEditorModelCacheKey({ ...owner, scope: 'graph/variant' }),
    buildCodeEditorModelCacheKey({ ...owner, scope: 'library/current' }),
    buildCodeEditorModelCacheKey({ ...owner, scope: 'graph/current', contentRevision: 1 }),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('source acknowledgements preserve incomplete drafts but recognize later Undo to original', () => {
  const first = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'original',
    createModel: () => createFakeModel('original'),
  });
  first.model.setValue('saved');
  acknowledgeCodeEditorModelSource('key', 'saved');
  first.model.setValue('incomplete draft');
  const warm = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'saved',
    createModel: () => createFakeModel('unused'),
  });
  assert.equal(warm.model.getValue(), 'incomplete draft');
  const restored = getOrCreateCodeEditorModel({
    cacheKey: 'key',
    text: 'original',
    createModel: () => createFakeModel('unused'),
  });
  assert.equal(restored.model.getValue(), 'original');
});

test('cache pressure never disposes attached models and release restores the bound', () => {
  const attached = Array.from({ length: 13 }, (_, index) =>
    getOrCreateCodeEditorModel({
      cacheKey: `active-${index}`,
      text: String(index),
      retain: true,
      createModel: () => createFakeModel(String(index)),
    }),
  );
  assert.equal(getCachedCodeEditorModelCount(), 13);
  assert.equal(
    attached.some(({ model }) => (model as unknown as FakeTextModel).disposed),
    false,
  );
  attached[0]!.release();
  attached[0]!.release();
  assert.equal(getCachedCodeEditorModelCount(), 12);
  assert.equal((attached[0]!.model as unknown as FakeTextModel).disposed, true);
  assert.equal((attached[1]!.model as unknown as FakeTextModel).disposed, false);
});

test('project cleanup defers attached-model disposal until its final release', () => {
  const key = buildCodeEditorModelCacheKey({ projectId: 'p', graphId: 'g', nodeId: 'n', editorKey: 'code' })!;
  const lease = getOrCreateCodeEditorModel({
    cacheKey: key,
    text: 'original',
    retain: true,
    createModel: () => createFakeModel('original'),
  });
  clearCodeEditorModelCacheForProject('p');
  assert.equal((lease.model as unknown as FakeTextModel).disposed, false);
  lease.release();
  assert.equal((lease.model as unknown as FakeTextModel).disposed, true);
  assert.equal(getCachedCodeEditorModelCount(), 0);
});
