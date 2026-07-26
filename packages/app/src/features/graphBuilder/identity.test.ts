import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeRegistration, type GraphId, type ProjectId } from '@valerypopoff/rivet2-core';
import type { GraphBuilderEditorSnapshot } from './editorSnapshot.js';
import { createGraphBuilderBaseIdentity, graphBuilderBaseIdentityMatches } from './identity.js';

const snapshot = {
  activeGraphId: 'main' as GraphId,
  canonicalIdentity: '{"project":"snapshot"}',
  fingerprint: 'project-fingerprint',
  projectId: 'project' as ProjectId,
} as GraphBuilderEditorSnapshot;

function identityForPreferences(
  preferences: { applyDefaultNodeColors: boolean; openNodeSettingsOnCreate: boolean },
  referencedProjects: Parameters<typeof createGraphBuilderBaseIdentity>[0]['referencedProjects'] = {},
) {
  return createGraphBuilderBaseIdentity({
    assistModel: {
      displayName: 'Test model',
      generatorBranch: 'openai',
      model: 'test-model',
      provider: 'openai',
    },
    authoringPreferences: preferences,
    editorRevision: 1,
    pluginRefreshCounter: 0,
    plugins: [],
    projectPlugins: [],
    referencedProjects,
    registry: new NodeRegistration(),
    snapshot,
  });
}

test('base identity tracks authoring preferences without coupling to unrelated editor UI behavior', () => {
  const base = identityForPreferences({
    applyDefaultNodeColors: false,
    openNodeSettingsOnCreate: true,
  });
  const unrelatedUiChange = identityForPreferences({
    applyDefaultNodeColors: false,
    openNodeSettingsOnCreate: false,
  });
  const authoringChange = identityForPreferences({
    applyDefaultNodeColors: true,
    openNodeSettingsOnCreate: true,
  });

  assert.equal(graphBuilderBaseIdentityMatches(base, unrelatedUiChange), true);
  assert.equal(base.registryContractCanonicalIdentity, unrelatedUiChange.registryContractCanonicalIdentity);
  assert.equal(graphBuilderBaseIdentityMatches(base, authoringChange), false);
  assert.notEqual(base.registryContractCanonicalIdentity, authoringChange.registryContractCanonicalIdentity);
});

test('referenced-project identity rejects accessors without invoking them', () => {
  let getterCalls = 0;
  const referencedProjects = {};
  Object.defineProperty(referencedProjects, 'reference', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return {};
    },
  });

  assert.throws(
    () =>
      identityForPreferences(
        {
          applyDefaultNodeColors: false,
          openNodeSettingsOnCreate: true,
        },
        referencedProjects,
      ),
    /accessor/,
  );
  assert.equal(getterCalls, 0);
});
