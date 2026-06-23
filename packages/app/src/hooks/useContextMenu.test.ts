import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContextMenuVirtualElement, getContextMenuDataFromTarget } from './useContextMenu.js';

type FakeContextMenuNode = {
  dataset?: {
    contextmenutype?: string;
  };
  parentElement?: FakeContextMenuNode | null;
};

const asEventTarget = (node: FakeContextMenuNode) => node as unknown as EventTarget;

test('context menu target lookup resolves a context menu ancestor', () => {
  const graphItem: FakeContextMenuNode = {
    dataset: { contextmenutype: 'graph-item' },
  };
  const icon: FakeContextMenuNode = {
    dataset: {},
    parentElement: graphItem,
  };

  const data = getContextMenuDataFromTarget(asEventTarget(icon));

  assert.equal(data?.type, 'graph-item');
  assert.equal(data?.element, graphItem);
});

test('context menu target lookup tolerates text-node-like targets without a dataset', () => {
  const folderItem: FakeContextMenuNode = {
    dataset: { contextmenutype: 'graph-folder' },
  };
  const textTarget: FakeContextMenuNode = {
    parentElement: folderItem,
  };

  const data = getContextMenuDataFromTarget(asEventTarget(textTarget));

  assert.equal(data?.type, 'graph-folder');
  assert.equal(data?.element, folderItem);
});

test('context menu target lookup returns null without a menu ancestor', () => {
  const ordinaryElement: FakeContextMenuNode = {
    dataset: {},
  };

  assert.equal(getContextMenuDataFromTarget(asEventTarget(ordinaryElement)), null);
  assert.equal(getContextMenuDataFromTarget(null), null);
});

test('context menu target lookup stops on cyclic parent chains', () => {
  const ordinaryElement: FakeContextMenuNode = {
    dataset: {},
  };
  ordinaryElement.parentElement = ordinaryElement;

  assert.equal(getContextMenuDataFromTarget(asEventTarget(ordinaryElement)), null);
});

test('context menu virtual reference anchors to the pointer without DOM nesting', () => {
  const virtualElement = createContextMenuVirtualElement(42, 64);
  const rect = virtualElement.getBoundingClientRect();

  assert.deepEqual(
    {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
      x: rect.x,
      y: rect.y,
    },
    {
      bottom: 64,
      height: 0,
      left: 42,
      right: 42,
      top: 64,
      width: 0,
      x: 42,
      y: 64,
    },
  );
  assert.equal(rect.toJSON(), rect);
});

test('context menu hook keeps legacy reference refs separate from floating menu refs', () => {
  const source = readFileSync(new URL('./useContextMenu.ts', import.meta.url), 'utf8');

  assert.match(source, /const setReference = useMergeRefs\(\[refs\.setReference, contextMenuRef\]\);/);
  assert.match(source, /const setFloatingMenu = useMergeRefs\(\[refs\.setFloating, contextMenuRef\]\);/);
  assert.match(source, /refs:\s*\{\s*\.\.\.refs,\s*setReference,\s*\}/s);
  assert.match(source, /setFloatingMenu,/);
});
