import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeRegistration, NodeImpl, type PluginNodeImpl, type ChartNode, type NodeId } from '../../src/index.js';

type FixtureNode = ChartNode<'registrationFixture', {}>;
class FixtureImpl extends NodeImpl<FixtureNode> {
  static create(): FixtureNode {
    return {
      id: 'registration-fixture' as NodeId,
      type: 'registrationFixture',
      title: 'Fixture',
      data: {},
      visualData: { x: 0, y: 0 },
    };
  }
  static getUIData() {
    return { contextMenuTitle: 'Fixture', group: 'Testing' };
  }
  getInputDefinitions() {
    return [];
  }
  getOutputDefinitions() {
    return [];
  }
  async process() {
    return {};
  }
}

test('dynamic display labels preserve built-in/plugin, late registration and error semantics without a cache', () => {
  const registry = new NodeRegistration();
  for (const type of ['registrationFixture', 'missing', 'toString', '__proto__'])
    assert.throws(() => registry.getDynamicDisplayName(type), new RegExp(`Unknown node type: ${type}`));
  registry.register({ impl: FixtureImpl, displayName: 'Fixture name' });
  assert.equal(registry.getDynamicDisplayName('registrationFixture'), 'Fixture name');
  assert.equal(registry.getDisplayName('registrationFixture' as never), 'Fixture name');
  assert.throws(() => registry.register({ impl: FixtureImpl, displayName: 'Duplicate' }), /Duplicate node type/);

  const plugin: PluginNodeImpl<ChartNode> = {
    create: () => ({ ...FixtureImpl.create(), type: 'pluginFixture' }),
    getUIData: FixtureImpl.getUIData,
    getInputDefinitions: () => [],
    getOutputDefinitions: () => [],
    getEditors: () => [],
    getBody: () => undefined,
    process: async () => ({}),
  };
  registry.registerPlugin({
    id: 'fixture',
    register: (register) => register({ impl: plugin, displayName: 'Late plugin' }),
  });
  assert.equal(registry.getDynamicDisplayName('pluginFixture'), 'Late plugin');
  assert.equal(registry.getDynamicDisplayName('registrationFixture'), 'Fixture name');
  const empty = new NodeRegistration();
  empty.register({ impl: FixtureImpl, displayName: '' });
  assert.throws(() => empty.getDynamicDisplayName('registrationFixture'), /Unknown node type/);
});
