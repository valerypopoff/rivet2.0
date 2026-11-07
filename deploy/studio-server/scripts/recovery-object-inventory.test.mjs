import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRecoveryObjects } from './lib/recovery-object-inventory.mjs';

const metadata = (name) => ({ name, generation: '123', size: '10', md5Hash: 'md5', crc32c: 'crc' });
const fixture = (references) => ({
  references,
  prefixes: ['workflows/', 'runtime-libraries/'],
  listPage: async ({ prefix }) => ({ items: references.filter((name) => name.startsWith(prefix)).map(metadata) }),
  getObject: async (name) => metadata(name),
});

test('empty and null final page tokens finish a complete inventory', async () => {
  for (const nextPageToken of ['', null]) {
    const f = fixture(['workflows/ab-file']);
    f.listPage = async () => ({ items: f.references.map(metadata), nextPageToken });
    assert.deepEqual((await inventoryRecoveryObjects(f)).objects, f.references.map(metadata));
  }
});

test('sharded inventory covers Unicode and non-hex names, short keys and paginated references exactly', async () => {
  const references = [
    'workflows/',
    'workflows/a',
    'workflows/ab-one',
    'workflows/ab-two',
    'workflows/🦊é/file',
    'runtime-libraries/non-hex',
  ];
  const f = fixture(references);
  const pages = [];
  f.listPage = async ({ prefix, pageToken }) => {
    pages.push([prefix, pageToken]);
    const objects = references.filter((name) => name.startsWith(prefix)).map(metadata);
    if (prefix === 'workflows/ab')
      return pageToken ? { items: objects.slice(1) } : { items: objects.slice(0, 1), nextPageToken: 'second' };
    return { items: [...objects, metadata(prefix + '-unreferenced')] };
  };
  const result = await inventoryRecoveryObjects(f);
  assert.deepEqual(result.objects, references.map(metadata));
  assert.equal(result.metadataReads, 2);
  assert.deepEqual(
    pages.filter(([prefix]) => prefix === 'workflows/ab'),
    [
      ['workflows/ab', undefined],
      ['workflows/ab', 'second'],
    ],
  );
});

test('inventory bounds reads, overlaps independent prefixes and joins in-flight reads after failure', async () => {
  const references = Array.from({ length: 12 }, (_, i) => 'workflows/' + i.toString().padStart(2, '0') + '/file');
  let active = 0,
    peak = 0,
    settled = 0;
  const f = fixture(references);
  f.listPage = async ({ prefix }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active--;
    settled++;
    if (prefix === 'workflows/00') throw Error('Read failed');
    return { items: [metadata(references.find((name) => name.startsWith(prefix)))] };
  };
  await assert.rejects(inventoryRecoveryObjects(f), /Read failed/);
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(settled, 4);
});

test('missing, duplicate, malformed and cyclic inventory results never certify a checkpoint', async () => {
  for (const mode of ['missing', 'duplicate', 'generation', 'size', 'cycle', 'foreign']) {
    const f = fixture(['workflows/ab-file']);
    f.listPage = async () => ({
      items:
        mode === 'missing' || mode === 'foreign'
          ? [metadata('workflows/foreign')]
          : mode === 'duplicate'
            ? [metadata(f.references[0]), metadata(f.references[0])]
            : [
                {
                  ...metadata(f.references[0]),
                  ...(mode === 'generation'
                    ? { generation: '0' }
                    : mode === 'size'
                      ? { size: '9007199254740992' }
                      : {}),
                },
              ],
      ...(mode === 'cycle' ? { items: [], nextPageToken: 'same' } : {}),
    });
    await assert.rejects(inventoryRecoveryObjects(f));
  }
  await assert.rejects(inventoryRecoveryObjects(fixture(['elsewhere/file'])), /outside/);
  await assert.rejects(inventoryRecoveryObjects(fixture(['workflows/ab', 'workflows/ab'])), /Duplicate/);
});

test('large alphabets use a bounded root-listing fallback without losing reference coverage', async () => {
  const references = Array.from({ length: 1100 }, (_, i) => 'workflows/' + String.fromCodePoint(0x1000 + i) + '/file');
  const result = await inventoryRecoveryObjects(fixture(references));
  assert.equal(result.partitions, 1);
  assert.deepEqual(result.objects, references.map(metadata));
});

test('large shared directory prefixes still produce concurrent complete page chains', async () => {
  const references = Array.from(
    { length: 12000 },
    (_, i) => 'workflows/recordings/shared-workflow/' + i.toString(16).padStart(4, '0') + '.gz',
  );
  const f = fixture(references);
  let active = 0,
    peak = 0;
  f.listPage = async ({ prefix }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(setImmediate);
    active--;
    const objects = references.filter((name) => name.startsWith(prefix)).map(metadata);
    assert.ok(objects.length <= 1000, 'A shared directory must not leave the large inventory serial');
    return { items: objects };
  };
  const result = await inventoryRecoveryObjects(f);
  assert.equal(peak, 4);
  assert.ok(result.partitions > 4 && result.partitions <= 1024);
  assert.deepEqual(result.objects, references.map(metadata));
});
