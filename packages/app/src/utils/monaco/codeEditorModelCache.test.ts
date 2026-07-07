import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { afterEach } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearCodeEditorModelCache,
  clearCodeEditorModelCacheForProject,
  getCachedCodeEditorModelCount,
  getCodeEditorViewState,
  getOrCreateCodeEditorModel,
  saveCodeEditorViewState,
} from './codeEditorModelCache.js';
import { buildCodeEditorModelCacheKey } from './codeEditorModelCacheKey.js';

const monacoUtilsDir = dirname(fileURLToPath(import.meta.url));

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

test('model cache module stays independent from main-used cache key helpers', () => {
  const source = readFileSync(join(monacoUtilsDir, 'codeEditorModelCache.ts'), 'utf8');

  assert.doesNotMatch(source, /codeEditorModelCacheKey/);
});
