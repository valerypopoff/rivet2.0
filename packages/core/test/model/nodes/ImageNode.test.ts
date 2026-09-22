import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ImageNodeImpl, type DataId, type ImageNode, type InternalProcessContext } from '../../../src/index.js';

function createNode(data: Partial<ImageNode['data']> = {}): ImageNodeImpl {
  const node = ImageNodeImpl.create();
  return new ImageNodeImpl({ ...node, data: { ...node.data, ...data } });
}

const context = {
  project: { data: { fixture: 'AQIDBA==' } },
} as InternalProcessContext;

describe('ImageNode', () => {
  it('keeps binary data as the default and preserves legacy project data and ports', async () => {
    const node = createNode({ data: { refId: 'fixture' as DataId } });
    delete node.chartNode.data.sourceType;

    assert.equal(ImageNodeImpl.create().data.sourceType, 'binary');
    assert.equal(node.getEditors().find((editor) => editor.type === 'segmented')?.defaultValue, 'binary');
    assert.deepEqual((await node.process({}, context)).image.value.data, new Uint8Array([1, 2, 3, 4]));

    const inputNode = createNode({ useDataInput: true });
    delete inputNode.chartNode.data.sourceType;
    assert.deepEqual(
      inputNode.getInputDefinitions().map(({ id, dataType }) => [id, dataType]),
      [['data', 'binary']],
    );
    const bytes = new Uint8Array([5, 6]);
    assert.equal(
      (await inputNode.process({ data: { type: 'binary', value: bytes } }, context)).image.value.data,
      bytes,
    );
  });

  it('decodes inline base64 and shows only the base64 editor in that mode', async () => {
    const node = createNode({ sourceType: 'base64', base64: ' AQIDBA== ', mediaType: 'image/jpeg' });

    assert.deepEqual(node.getInputDefinitions(), []);
    const editors = node.getEditors();
    const binaryEditor = editors.find((editor) => editor.type === 'imageBrowser');
    const base64Editor = editors.find((editor) => editor.type === 'code' && editor.dataKey === 'base64');
    assert.equal(binaryEditor?.hideIf?.(node.chartNode.data), true);
    assert.equal(base64Editor?.hideIf?.(node.chartNode.data), false);
    assert.equal(base64Editor?.useInputToggleDataKey, 'useBase64Input');

    const image = (await node.process({}, context)).image;
    assert.equal(image.type, 'image');
    assert.deepEqual(image.value, { mediaType: 'image/jpeg', data: new Uint8Array([1, 2, 3, 4]) });
  });

  it('uses a string Base64 input when the port is enabled without changing the binary port id', async () => {
    const node = createNode({
      sourceType: 'base64',
      base64: 'ignored',
      useBase64Input: true,
      useDataInput: true,
    });

    assert.deepEqual(
      node.getInputDefinitions().map(({ id, title, dataType }) => [id, title, dataType]),
      [['base64', 'Base64', 'string']],
    );
    assert.deepEqual(
      (await node.process({ base64: { type: 'string', value: 'BQY=' } }, context)).image.value.data,
      new Uint8Array([5, 6]),
    );
    node.chartNode.data.sourceType = 'binary';
    assert.deepEqual(
      node.getInputDefinitions().map(({ id, dataType }) => [id, dataType]),
      [['data', 'binary']],
    );
  });

  it('rejects missing or invalid base64 content instead of emitting an empty image', async () => {
    const node = createNode({ sourceType: 'base64', base64: '' });
    await assert.rejects(node.process({}, context), /No base64 image data/);
    node.chartNode.data.base64 = 'not-base64!';
    await assert.rejects(node.process({}, context));
  });
});
