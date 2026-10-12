import assert from 'node:assert/strict';
import test from 'node:test';
import { serialize } from 'node:v8';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  serializeDatasets,
  serializeProject,
} from '@valerypopoff/rivet2-node';
import { ParsedExecutionCache } from '../routes/workflows/parsed-execution-cache.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { getFilesystemProjectRevisionId } from '../routes/workflows/project-stats.js';
import { getWorkflowProjectIndexDataFromContents } from '../routes/workflows/project-index.js';
import { configureStudioMetrics, resetStudioMetricsForTests } from '../metrics.js';

test('lightweight default parsing preserves project, attached data, datasets and public index identity', () => {
  const [project] = loadProjectAndAttachedDataFromString(createBlankProjectFile('Compatibility'));
  const attachedData = { fixtureEvidence: { nested: ['preserve', 7] } };
  const contents = serializeProject(project, attachedData) as string;
  const datasetsContents = serializeDatasets([
    {
      meta: { id: 'dataset' as never, projectId: project.metadata.id!, name: 'Dataset', description: '' },
      data: { id: 'dataset' as never, rows: [{ id: 'row', data: ['value'] }] },
    },
  ]);
  const [expectedProject, expectedAttachedData] = loadProjectAndAttachedDataFromString(contents);
  const source = { revisionId: 'compatibility', contents, datasetsContents };
  const cache = new ParsedExecutionCache();
  const expected = {
    project: expectedProject,
    attachedData: expectedAttachedData,
    datasets: deserializeDatasets(datasetsContents),
  };
  assert.deepEqual(cache.materialize(source), expected);
  assert.deepEqual(cache.materialize(source), expected, 'warm and cold materialization have identical semantics');
  assert.deepEqual(getWorkflowProjectIndexDataFromContents(contents, datasetsContents), {
    projectMetadataId: project.metadata.id,
    revisionId: getFilesystemProjectRevisionId(contents, datasetsContents),
    stats: { graphCount: 1, totalNodeCount: 0, webAppCount: 0 },
  });
});

test('parsed revisions reuse parsing but never expose cached mutable project state', () => {
  let reads = 0;
  const cache = new ParsedExecutionCache({
    parse: (text) => {
      reads++;
      return loadProjectAndAttachedDataFromString(text);
    },
  });
  const source = { revisionId: 'revision', contents: createBlankProjectFile('Original'), datasetsContents: null };
  const first = cache.materialize(source, true);
  first.project.metadata.title = 'Changed by a run';
  first.project.graphs = {};
  first.datasets.push({} as never);
  const second = cache.materialize(source, true);
  assert.equal(reads, 1);
  assert.equal(second.project.metadata.title, 'Original');
  assert.equal(second.datasets.length, 0);
  assert.equal(second.contentRevision, getFilesystemProjectRevisionId(source.contents, null));
  assert.notStrictEqual(first.project, second.project);
  cache.materialize({ ...source, contents: createBlankProjectFile('Replacement') });
  assert.equal(reads, 2, 'A reused revision name cannot expose another payload');
  cache.clear();
  cache.materialize(source);
  assert.equal(reads, 3);
});

test('oversized and disabled parsed caches bypass admission without changing results', () => {
  for (const options of [{ maxBytes: 0 }, { maxEntryBytes: 1 }]) {
    let reads = 0;
    const cache = new ParsedExecutionCache({
      ...options,
      parse: (text) => {
        reads++;
        return loadProjectAndAttachedDataFromString(text);
      },
    });
    const source = { revisionId: 'revision', contents: createBlankProjectFile('Original'), datasetsContents: null };
    assert.deepEqual(cache.materialize(source), cache.materialize(source));
    assert.equal(reads, 2);
  }
});

test('total parsed cache budget evicts definitions without exposing mutations or stale content revisions', () => {
  const first = { revisionId: 'first', contents: createBlankProjectFile('First'), datasetsContents: null };
  const second = { revisionId: 'second', contents: createBlankProjectFile('Second'), datasetsContents: null };
  const entryBytes = (source: typeof first) => {
    const [project, attachedData] = loadProjectAndAttachedDataFromString(source.contents);
    return 4 * serialize({ project, attachedData, datasets: [] }).byteLength + 2 * source.contents.length;
  };
  const maxBytes = Math.max(entryBytes(first), entryBytes(second));
  let parses = 0;
  const cache = new ParsedExecutionCache({
    maxBytes,
    maxEntryBytes: maxBytes,
    parse: (contents) => {
      parses++;
      return loadProjectAndAttachedDataFromString(contents);
    },
  });
  const original = cache.materialize(first, true);
  original.project.metadata.title = 'Execution mutation';
  const other = cache.materialize(second, true);
  other.project.graphs = {};
  const reloaded = cache.materialize(first, true);
  assert.equal(parses, 3, 'two individually admissible entries cannot exceed the total budget');
  assert.equal(reloaded.project.metadata.title, 'First');
  assert.ok(Object.keys(reloaded.project.graphs).length > 0);
  assert.equal(reloaded.contentRevision, getFilesystemProjectRevisionId(first.contents, null));
  assert.equal(cache.materialize(first, true).contentRevision, reloaded.contentRevision);
  assert.equal(parses, 3, 'the newly admitted definition is warm again');
});

test('default uncached definitions remain isolated and oversized admission avoids accounting copies', () => {
  const metrics = configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
  try {
    const source = {
      revisionId: 'uncached',
      contents: createBlankProjectFile('Fresh ownership'),
      datasetsContents: null,
    };
    for (const options of [{ maxBytes: 0 }, { maxEntryBytes: 1 }, { maxBytes: 1 }]) {
      const cache = new ParsedExecutionCache(options);
      const first = cache.materialize(source);
      first.project.metadata.title = 'mutated';
      first.project.graphs = {};
      first.datasets.push({} as never);
      assert.equal(cache.materialize(source).project.metadata.title, 'Fresh ownership');
      assert.deepEqual(cache.getStats(), { entries: 0, retainedBytes: 0 });
    }
    const cache = new ParsedExecutionCache();
    cache.materialize(source);
    cache.materialize(source);
    assert.equal(cache.getStats().entries, 1);
    assert.ok(cache.getStats().retainedBytes > 0);
    assert.match(metrics.render(), /rivet_parsed_execution_cache_retained_bytes\{profile="control"\} [1-9]/);
    cache.clear();
    assert.match(metrics.render(), /rivet_parsed_execution_cache_retained_bytes\{profile="control"\} 0/);
    assert.match(metrics.render(), /event="hit"/);
    assert.match(metrics.render(), /event="entry_too_large"/);
    assert.doesNotMatch(metrics.render(), /Fresh ownership|uncached/);
  } finally {
    resetStudioMetricsForTests();
  }
});
