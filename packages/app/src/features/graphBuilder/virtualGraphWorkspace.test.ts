import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId, type NodeId, type ProjectId } from '@valerypopoff/rivet2-core';
import { type GraphBuilderAuthoringProject, type GraphDiagnostic } from '../../domain/graphBuilder/index.js';
import {
  createVirtualGraphWorkspace,
  getVirtualGraphDocumentPath,
  shouldProtectVirtualGraphSecretField,
  type VirtualGraphPolicyWorkspaceContext,
  VirtualGraphWorkspaceError,
} from './virtualGraphWorkspace.js';

const activeGraphId = 'active/graph' as GraphId;

function project(
  options: {
    title?: string;
    text?: string;
    headers?: unknown[];
  } = {},
): GraphBuilderAuthoringProject {
  return {
    metadata: {
      id: 'project' as ProjectId,
      title: 'Virtual workspace test',
      description: '',
      mainGraphId: activeGraphId,
    },
    graphs: {
      [activeGraphId]: {
        metadata: {
          id: activeGraphId,
          name: 'Active graph',
          description: 'Preserved graph metadata',
        },
        nodes: [
          {
            id: 'node-1' as NodeId,
            type: 'text',
            title: options.title ?? 'Before',
            description: 'Preserved node envelope',
            visualData: {
              x: 10,
              y: 20,
              width: 320,
              color: { border: '#111111', bg: '#eeeeee' },
            },
            data: {
              text: options.text ?? 'keep',
              apiKey: 'super-secret-value',
              apiKeySource: 'environment',
              apiKeyEnvVarName: 'OPENAI_API_KEY',
              programmaticName: 'llm-provider',
              useApiKeyInput: false,
              password: '',
              headers: options.headers ?? [],
              nested: {
                token: 'nested-secret-value',
              },
            },
            variants: [{ id: 'variant-1', data: { text: 'variant' } }],
          },
        ],
        connections: [],
        customGraphField: {
          retained: true,
        },
      } as GraphBuilderAuthoringProject['graphs'][GraphId],
    },
  };
}

function oneLineReplacementDiff(input: {
  contents: string;
  path: string;
  select: (line: string) => boolean;
  replace: (line: string) => string;
  lineEndings?: '\n' | '\r\n';
}): string {
  const lines = input.contents.endsWith('\n') ? input.contents.slice(0, -1).split('\n') : input.contents.split('\n');
  const index = lines.findIndex(input.select);
  assert.notEqual(index, -1, 'expected source line in canonical virtual document');
  const before = lines[index]!;
  const after = input.replace(before);
  assert.notEqual(after, before, 'replacement must change the selected source line');
  const eol = input.lineEndings ?? '\n';
  return [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    `@@ -${index + 1},1 +${index + 1},1 @@`,
    `-${before}`,
    `+${after}`,
    '',
  ].join(eol);
}

function titleDiff(
  workspace: ReturnType<typeof createVirtualGraphWorkspace>,
  title: string,
  lineEndings?: '\n' | '\r\n',
): string {
  const path = getVirtualGraphDocumentPath(activeGraphId);
  return oneLineReplacementDiff({
    contents: workspace.readDocument(path).contents,
    path,
    select: (line) => line.includes('title: Before'),
    replace: (line) => line.replace('title: Before', `title: ${title}`),
    lineEndings,
  });
}

test('virtual graph documents are deterministic, full-fidelity, and reveal only inert secret-like configuration', () => {
  const first = createVirtualGraphWorkspace({ project: project() });
  const second = createVirtualGraphWorkspace({ project: project() });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const document = first.readDocument(path);
  const repeated = second.readDocument(path);

  assert.equal(path, 'graphs/active%2Fgraph.yaml');
  assert.equal(document.contents, repeated.contents);
  assert.equal(document.digest, repeated.digest);
  assert.match(document.contents, /^version: 1\n/u);
  assert.match(document.contents, /customGraphField:/u);
  assert.match(document.contents, /\$graphBuilderSecret: host-secret:fnv1a64:/u);
  assert.doesNotMatch(document.contents, /super-secret-value|nested-secret-value/u);
  assert.match(document.contents, /apiKeySource: environment/u);
  assert.match(document.contents, /apiKeyEnvVarName: OPENAI_API_KEY/u);
  assert.match(document.contents, /programmaticName: llm-provider/u);
  assert.match(document.contents, /useApiKeyInput: false/u);
  assert.match(document.contents, /password: ""/u);
  assert.match(document.contents, /headers: \[\]/u);

  const draft = first.getDraft();
  const node = draft.graphs[activeGraphId]!.nodes[0]!;
  assert.equal((node.data as Record<string, unknown>).apiKey, 'super-secret-value');

  const context = first.getPolicyWorkspaceContext(activeGraphId);
  const controllerContext: VirtualGraphPolicyWorkspaceContext = context;
  assert.equal(controllerContext.activeDocumentPath, path);
  assert.deepEqual(Object.keys(context).sort(), [
    'activeDocument',
    'activeDocumentPath',
    'delta',
    'documents',
    'version',
  ]);
  assert.deepEqual(context.delta, { graphDeltas: [] });
  assert.equal(context.version, 1);
  assert.equal(context.activeDocumentPath, path);
  assert.equal(context.documents[0]?.name, 'Active graph');
  assert.equal(context.documents[0]?.totalLines, document.totalLineCount);
  assert.equal(context.activeDocument.content, document.contents);
  assert.equal(context.activeDocument.endLine, document.totalLineCount);
  assert.equal(context.activeDocument.truncated, false);

  const protectedHeaders = createVirtualGraphWorkspace({
    project: project({ headers: [{ Authorization: 'Bearer header-secret' }] }),
  }).readDocument(path);
  assert.doesNotMatch(protectedHeaders.contents, /Bearer header-secret/u);
  assert.match(protectedHeaders.contents, /headers:\n\s+\$graphBuilderSecret:/u);
});

test('secret protection is value-aware for safe LLM lookup policy fields and inert defaults', () => {
  const secretName = (key: string) =>
    ['apikey', 'credential', 'headers', 'password', 'privatekey', 'token'].some((fragment) =>
      key
        .toLowerCase()
        .replace(/[^a-z0-9]/gu, '')
        .includes(fragment),
    );

  assert.equal(shouldProtectVirtualGraphSecretField('apiKey', 'actual-key', secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('headers', [{ Authorization: 'secret' }], secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('headers', [], secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('password', '', secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('token', null, secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('apiKeySource', 'environment', secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('apiKeyEnvVarName', 'OPENAI_API_KEY', secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('apiKeyProgrammaticName', 'provider', secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('useApiKeyInput', true, secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('useApiKeyInput', false, secretName), false);
  assert.equal(shouldProtectVirtualGraphSecretField('useApiKeyInput', 'actual-key', secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('credentialSource', 'opaque-plugin-secret', secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('privateKeySource', 'opaque-plugin-secret', secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('tokenEnvVarName', 'opaque-plugin-secret', secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('apiKey', 123, secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('apiKey', false, secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('opaqueToken', 'plugin-secret'), true);
  assert.equal(shouldProtectVirtualGraphSecretField('maxTokens', 32_768, secretName), true);
  assert.equal(shouldProtectVirtualGraphSecretField('maxTokens', 32_768), false);
});

test('numeric and boolean secret-like values remain host-owned while explicit input-policy flags stay editable', () => {
  const inputProject = project();
  Object.assign(inputProject.graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>, {
    credential: false,
    numericToken: 12_345,
    privateKeySource: 'opaque-plugin-secret',
    useCredentialInput: false,
  });
  const workspace = createVirtualGraphWorkspace({ project: inputProject });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const contents = workspace.readDocument(path).contents;

  assert.doesNotMatch(contents, /numericToken: 12345|credential: false|opaque-plugin-secret/u);
  assert.match(contents, /numericToken:\n\s+\$graphBuilderSecret:/u);
  assert.match(contents, /credential:\n\s+\$graphBuilderSecret:/u);
  assert.match(contents, /privateKeySource:\n\s+\$graphBuilderSecret:/u);
  assert.match(contents, /useCredentialInput: false/u);

  const restoredData = workspace.getDraft().graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>;
  assert.equal(restoredData.numericToken, 12_345);
  assert.equal(restoredData.credential, false);
});

test('exact unified diffs apply atomically, preserve raw fields and secrets, and replay idempotently', () => {
  let normalizationCalls = 0;
  let validationCalls = 0;
  const workspace = createVirtualGraphWorkspace({
    project: project(),
    normalizeCandidate: ({ candidate, changedGraphIds }) => {
      normalizationCalls += 1;
      assert.deepEqual(changedGraphIds, [activeGraphId]);
      return candidate;
    },
    validateCandidate: ({ candidate, changedGraphIds }) => {
      validationCalls += 1;
      assert.equal(candidate.graphs[activeGraphId]!.nodes[0]!.title, 'After');
      assert.deepEqual(changedGraphIds, [activeGraphId]);
      return {
        completeness: 'complete',
        diagnostics: [],
        blockingDiagnosticKeys: [],
      };
    },
  });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const beforeDigest = workspace.readDocument(path).digest;
  const unifiedDiff = titleDiff(workspace, 'After', '\r\n');
  const applied = workspace.applyDocumentPatch({
    patchId: 'patch-1',
    expectedDraftRevision: 0,
    unifiedDiff,
  });

  assert.equal(applied.disposition, 'applied');
  assert.equal(applied.baseRevision, 0);
  assert.equal(applied.draftRevision, 1);
  assert.equal(applied.delta.graphDeltas[0]?.graphId, activeGraphId);
  assert.equal(applied.delta.graphDeltas[0]?.updatedNodes[0]?.nodeId, 'node-1');
  assert.equal(workspace.getDraftRevision(), 1);
  assert.equal(workspace.hasDraftChanges(), true);
  assert.deepEqual(workspace.getProjectDelta(), workspace.getProjectDraftDelta());
  assert.equal(normalizationCalls, 1);
  assert.equal(validationCalls, 1);

  const node = workspace.getDraft().graphs[activeGraphId]!.nodes[0]!;
  assert.equal(node.title, 'After');
  assert.equal((node.data as Record<string, unknown>).apiKey, 'super-secret-value');
  assert.notEqual(workspace.readDocument(path).digest, beforeDigest);

  const replayed = workspace.applyUnifiedDiff({
    patchId: 'patch-1',
    expectedDraftRevision: 0,
    unifiedDiff,
  });
  assert.equal(replayed.disposition, 'replayed');
  assert.equal(replayed.original.disposition, 'applied');
  assert.equal(normalizationCalls, 1);
  assert.equal(validationCalls, 1);

  assert.throws(
    () =>
      workspace.applyUnifiedDiff({
        patchId: 'patch-1',
        expectedDraftRevision: 1,
        unifiedDiff: unifiedDiff.replace('After', 'Different'),
      }),
    (error: unknown) => error instanceof VirtualGraphWorkspaceError && error.code === 'patch-identity-content-mismatch',
  );
});

test('full-document replacement uses the same atomic transaction and patch identity ledger', () => {
  let validationCalls = 0;
  const workspace = createVirtualGraphWorkspace({
    project: project(),
    validateCandidate: () => {
      validationCalls += 1;
      return {
        completeness: 'complete',
        diagnostics: [],
        blockingDiagnosticKeys: [],
      };
    },
  });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const replacementContents = workspace.readDocument(path).contents.replace('title: Before', 'title: Replaced');
  const replacement = {
    patchId: 'replacement-1',
    expectedDraftRevision: 0,
    path,
    contents: replacementContents,
  };

  const applied = workspace.replaceDocument(replacement);
  assert.equal(applied.disposition, 'applied');
  assert.equal(workspace.getDraftRevision(), 1);
  assert.equal(workspace.getDraft().graphs[activeGraphId]!.nodes[0]!.title, 'Replaced');
  assert.equal(
    (workspace.getDraft().graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>).apiKey,
    'super-secret-value',
  );
  assert.equal(validationCalls, 1);

  const replayed = workspace.replaceDocument(replacement);
  assert.equal(replayed.disposition, 'replayed');
  assert.equal(replayed.original.disposition, 'applied');
  assert.equal(validationCalls, 1);

  assert.throws(
    () =>
      workspace.applyUnifiedDiff({
        patchId: replacement.patchId,
        expectedDraftRevision: 0,
        unifiedDiff: titleDiff(createVirtualGraphWorkspace({ project: project() }), 'Other'),
      }),
    (error: unknown) => error instanceof VirtualGraphWorkspaceError && error.code === 'patch-identity-content-mismatch',
  );
});

test('full-document parsing accepts the complete valid ChartNode envelope', () => {
  const inputProject = project();
  Object.assign(inputProject.graphs[activeGraphId]!.nodes[0]!, {
    disabled: false,
    isConditional: true,
    isSplitRun: true,
    isSplitSequential: false,
    splitRunMax: 20,
    splitRunConcurrency: 4,
  });
  inputProject.graphs[activeGraphId]!.nodes[0]!.visualData.zIndex = 3;
  const workspace = createVirtualGraphWorkspace({ project: inputProject });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const replacement = workspace.replaceDocument({
    patchId: 'complete-node-envelope',
    expectedDraftRevision: 0,
    path,
    contents: workspace.readDocument(path).contents.replace('title: Before', 'title: After'),
  });

  assert.equal(replacement.disposition, 'applied');
  const node = workspace.getDraft().graphs[activeGraphId]!.nodes[0]!;
  assert.equal(node.title, 'After');
  assert.equal(node.isSplitRun, true);
  assert.equal(node.splitRunConcurrency, 4);
  assert.equal(node.visualData.zIndex, 3);
});

test('full-document parsing rejects malformed ChartNode envelope fields atomically', () => {
  const cases: ReadonlyArray<{
    name: string;
    replace: (contents: string) => string;
    expected: RegExp;
  }> = [
    {
      name: 'description',
      replace: (contents) => contents.replace('description: Preserved node envelope', 'description: 42'),
      expected: /"description" must be a string/u,
    },
    {
      name: 'boolean flag',
      replace: (contents) =>
        contents.replace(
          /^(\s*)description: Preserved node envelope$/mu,
          (_line, indentation: string) =>
            `${indentation}description: Preserved node envelope\n${indentation}disabled: "false"`,
        ),
      expected: /"disabled" must be a boolean/u,
    },
    {
      name: 'split bound',
      replace: (contents) =>
        contents.replace(
          /^(\s*)description: Preserved node envelope$/mu,
          (_line, indentation: string) =>
            `${indentation}description: Preserved node envelope\n${indentation}splitRunMax: 0`,
        ),
      expected: /"splitRunMax" must be a positive safe integer/u,
    },
    {
      name: 'visual width',
      replace: (contents) => contents.replace('width: 320', 'width: -1'),
      expected: /"visualData.width" must be a positive finite safe number/u,
    },
    {
      name: 'visual color',
      replace: (contents) => contents.replace('bg: "#eeeeee"', 'bg: 42'),
      expected: /"visualData.color"/u,
    },
    {
      name: 'variant',
      replace: (contents) => contents.replace('id: variant-1', 'id: ""'),
      expected: /"variants\[0\]"/u,
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const workspace = createVirtualGraphWorkspace({ project: project() });
    const path = getVirtualGraphDocumentPath(activeGraphId);
    const original = workspace.readDocument(path).contents;
    const edited = testCase.replace(original);
    assert.notEqual(edited, original, `fixture replacement failed for ${testCase.name}`);

    const result = workspace.replaceDocument({
      patchId: `malformed-envelope-${index}`,
      expectedDraftRevision: 0,
      path,
      contents: edited,
    });

    assert.equal(result.disposition, 'rejected', testCase.name);
    assert.match(result.diagnostics[0]!.message, testCase.expected, testCase.name);
    assert.equal(workspace.getDraftRevision(), 0, testCase.name);
    assert.equal(workspace.readDocument(path).contents, original, testCase.name);
  }
});

test('syntax, revision, path, and exact-context failures reject without mutating the draft', () => {
  const workspace = createVirtualGraphWorkspace({ project: project() });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const original = workspace.readDocument(path);

  const stale = workspace.applyUnifiedDiff({
    patchId: 'stale',
    expectedDraftRevision: 1,
    unifiedDiff: titleDiff(workspace, 'After'),
  });
  assert.equal(stale.disposition, 'rejected');
  assert.equal(stale.draftRevision, 0);

  const staleReplacement = workspace.replaceDocument({
    patchId: 'stale-replacement',
    expectedDraftRevision: 1,
    path,
    contents: original.contents.replace('title: Before', 'title: After'),
  });
  assert.equal(staleReplacement.disposition, 'rejected');
  assert.equal(staleReplacement.draftRevision, 0);

  const staleContextDiff = titleDiff(workspace, 'After').replace(/^-(\s*)title: Before$/mu, '-$1title: Stale');
  const staleContext = workspace.applyUnifiedDiff({
    patchId: 'stale-context',
    expectedDraftRevision: 0,
    unifiedDiff: staleContextDiff,
  });
  assert.equal(staleContext.disposition, 'rejected');
  assert.match(staleContext.diagnostics[0]!.message, /does not exactly match/u);

  const unknown = workspace.applyUnifiedDiff({
    patchId: 'unknown',
    expectedDraftRevision: 0,
    unifiedDiff: titleDiff(workspace, 'After').replaceAll(path, 'graphs/unknown.yaml'),
  });
  assert.equal(unknown.disposition, 'rejected');
  assert.match(unknown.diagnostics[0]!.message, /unknown virtual graph document/iu);

  const traversal = workspace.applyUnifiedDiff({
    patchId: 'traversal',
    expectedDraftRevision: 0,
    unifiedDiff: titleDiff(workspace, 'After').replaceAll(path, '../active.yaml'),
  });
  assert.equal(traversal.disposition, 'rejected');
  assert.match(traversal.diagnostics[0]!.message, /normalized relative .*path/iu);

  const timestamped = workspace.applyUnifiedDiff({
    patchId: 'timestamped',
    expectedDraftRevision: 0,
    unifiedDiff: titleDiff(workspace, 'After').replaceAll(path, `${path}\t2026-07-26`),
  });
  assert.equal(timestamped.disposition, 'rejected');
  assert.equal(timestamped.diagnostics[0]!.ruleId, 'invalid-unified-diff');
  assert.match(timestamped.diagnostics[0]!.message, /normalized relative virtual-document path/iu);

  const unknownReplacement = workspace.replaceDocument({
    patchId: 'unknown-replacement',
    expectedDraftRevision: 0,
    path: 'graphs/unknown.yaml',
    contents: original.contents,
  });
  assert.equal(unknownReplacement.disposition, 'rejected');
  assert.match(unknownReplacement.diagnostics[0]!.message, /unknown virtual graph document/iu);

  const traversalReplacement = workspace.replaceDocument({
    patchId: 'traversal-replacement',
    expectedDraftRevision: 0,
    path: '../active.yaml',
    contents: original.contents,
  });
  assert.equal(traversalReplacement.disposition, 'rejected');
  assert.match(traversalReplacement.diagnostics[0]!.message, /normalized relative path/iu);

  const invalidYamlDiff = oneLineReplacementDiff({
    contents: original.contents,
    path,
    select: (line) => line.includes('title: Before'),
    replace: (line) => line.replace('title: Before', 'title: ['),
  });
  const invalidYaml = workspace.applyUnifiedDiff({
    patchId: 'invalid-yaml',
    expectedDraftRevision: 0,
    unifiedDiff: invalidYamlDiff,
  });
  assert.equal(invalidYaml.disposition, 'rejected');
  assert.match(invalidYaml.diagnostics[0]!.message, /not valid YAML/iu);

  assert.equal(workspace.getDraftRevision(), 0);
  assert.equal(workspace.hasDraftChanges(), false);
  assert.equal(workspace.readDocument(path).contents, original.contents);
  assert.throws(
    () => workspace.readDocument('../active.yaml'),
    (error: unknown) => error instanceof VirtualGraphWorkspaceError && error.code === 'invalid-document-path',
  );
});

test('host secret placeholders cannot be changed and safe empty secret-like fields cannot acquire raw values', () => {
  const workspace = createVirtualGraphWorkspace({ project: project() });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const document = workspace.readDocument(path);
  const tamperedPlaceholderDiff = oneLineReplacementDiff({
    contents: document.contents,
    path,
    select: (line) => line.includes('$graphBuilderSecret:'),
    replace: (line) => line.replace(/host-secret:[^ ]+$/u, 'host-secret:tampered'),
  });
  const tampered = workspace.applyUnifiedDiff({
    patchId: 'tampered-secret',
    expectedDraftRevision: 0,
    unifiedDiff: tamperedPlaceholderDiff,
  });
  assert.equal(tampered.disposition, 'rejected');
  assert.match(tampered.diagnostics[0]!.message, /changed the host-owned secret placeholder/iu);

  const tamperedReplacement = workspace.replaceDocument({
    patchId: 'tampered-secret-replacement',
    expectedDraftRevision: 0,
    path,
    contents: document.contents.replace(/host-secret:[^ \n]+/u, 'host-secret:tampered'),
  });
  assert.equal(tamperedReplacement.disposition, 'rejected');
  assert.match(tamperedReplacement.diagnostics[0]!.message, /changed the host-owned secret placeholder/iu);

  const rawPasswordDiff = oneLineReplacementDiff({
    contents: document.contents,
    path,
    select: (line) => line.includes('password: ""'),
    replace: (line) => line.replace('password: ""', 'password: leaked'),
  });
  const rawPassword = workspace.applyUnifiedDiff({
    patchId: 'raw-password',
    expectedDraftRevision: 0,
    unifiedDiff: rawPasswordDiff,
  });
  assert.equal(rawPassword.disposition, 'rejected');
  assert.match(rawPassword.diagnostics[0]!.message, /introduced a new secret-like field/iu);
  assert.equal(workspace.getDraftRevision(), 0);
});

test('safe secret lookup policy fields remain editable while blocking validation remains atomic', () => {
  const blockingDiagnostic: GraphDiagnostic = {
    diagnosticKey: 'blocked-title',
    ruleId: 'blocked-title',
    rulesVersion: 'test-v1',
    severity: 'error',
    verification: 'verified',
    message: 'The candidate title is blocked.',
    graphId: activeGraphId,
  };
  const blocked = createVirtualGraphWorkspace({
    project: project(),
    validateCandidate: () => ({
      completeness: 'complete',
      diagnostics: [blockingDiagnostic],
      blockingDiagnosticKeys: [blockingDiagnostic.diagnosticKey],
    }),
  });
  const blockedPath = getVirtualGraphDocumentPath(activeGraphId);
  const rejected = blocked.replaceDocument({
    patchId: 'blocked',
    expectedDraftRevision: 0,
    path: blockedPath,
    contents: blocked.readDocument(blockedPath).contents.replace('title: Before', 'title: Blocked'),
  });
  assert.equal(rejected.disposition, 'rejected');
  assert.equal(rejected.attemptedDelta?.graphDeltas[0]?.graphId, activeGraphId);
  assert.equal(blocked.getDraft().graphs[activeGraphId]!.nodes[0]!.title, 'Before');
  assert.equal(blocked.getDraftRevision(), 0);

  const editable = createVirtualGraphWorkspace({ project: project() });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const sourceDiff = oneLineReplacementDiff({
    contents: editable.readDocument(path).contents,
    path,
    select: (line) => line.includes('apiKeySource: environment'),
    replace: (line) => line.replace('environment', 'programmatic'),
  });
  const applied = editable.applyUnifiedDiff({
    patchId: 'safe-source',
    expectedDraftRevision: 0,
    unifiedDiff: sourceDiff,
  });
  assert.equal(applied.disposition, 'applied');
  assert.equal(
    (editable.getDraft().graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>).apiKeySource,
    'programmatic',
  );
});

test('internal documents may exceed the provider envelope while cursor reads remain complete and bounded', () => {
  const longText = `prefix-${'🙂'.repeat(150 * 1024)}-suffix`;
  const workspace = createVirtualGraphWorkspace({
    project: project({ text: longText }),
  });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const read = workspace.readDocument(path, 1, 2_000);
  const context = workspace.getPolicyWorkspaceContext(activeGraphId);

  assert.ok(read.totalLineCount > 0);
  assert.ok(Buffer.byteLength(read.contents, 'utf8') <= 12 * 1024);
  assert.equal(read.truncated, true);
  assert.ok(Buffer.byteLength(context.activeDocument.content, 'utf8') <= 64 * 1024);
  assert.equal(context.activeDocument.truncated, true);
  assert.ok(context.activeDocument.totalLines >= context.activeDocument.endLine);

  const chunks: string[] = [];
  let nextOffset: number | undefined;
  let expectedStartOffset = 0;
  do {
    const chunk = workspace.readDocument(path, 1, undefined, nextOffset);
    assert.equal(chunk.startOffset, expectedStartOffset);
    assert.ok(Buffer.byteLength(chunk.contents, 'utf8') <= 12 * 1024);
    assert.equal(chunk.contents.length, chunk.endOffset - chunk.startOffset);
    chunks.push(chunk.contents);
    expectedStartOffset = chunk.endOffset;
    nextOffset = chunk.nextOffset;
  } while (nextOffset !== undefined);

  const reconstructed = chunks.join('');
  assert.equal(reconstructed.length, context.activeDocument.totalLength);
  assert.ok(reconstructed.includes(`${'🙂'.repeat(8)}-suffix\n`));
});

test('full replacement accepts documents above the provider envelope and rejects documents above the internal cap', () => {
  const workspace = createVirtualGraphWorkspace({ project: project() });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const original = workspace.readDocument(path).contents;
  const largeText = 'x'.repeat(300 * 1024);
  const largeContents = original.replace('text: keep', `text: ${largeText}`);
  assert.ok(Buffer.byteLength(largeContents, 'utf8') > 256 * 1024);

  const applied = workspace.replaceDocument({
    patchId: 'large-replacement',
    expectedDraftRevision: 0,
    path,
    contents: largeContents,
  });
  assert.equal(applied.disposition, 'applied');
  assert.equal((workspace.getDraft().graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>).text, largeText);
  assert.equal(workspace.getPolicyWorkspaceContext(activeGraphId).activeDocument.truncated, true);

  const oversizedContents = workspace
    .getPolicyWorkspaceContext(activeGraphId)
    .activeDocument.content.replace(/text: [x]*/u, `text: ${'y'.repeat(4 * 1024 * 1024)}`);
  assert.ok(Buffer.byteLength(oversizedContents, 'utf8') > 4 * 1024 * 1024);
  const oversized = workspace.replaceDocument({
    patchId: 'oversized-replacement',
    expectedDraftRevision: 1,
    path,
    contents: oversizedContents,
  });
  assert.equal(oversized.disposition, 'rejected');
  assert.match(oversized.diagnostics[0]!.message, /no larger than 4194304 bytes/iu);
  assert.equal(workspace.getDraftRevision(), 1);
  assert.equal((workspace.getDraft().graphs[activeGraphId]!.nodes[0]!.data as Record<string, unknown>).text, largeText);
});

test('semantic-equivalent YAML edits are reported as no-ops without advancing revision', () => {
  const workspace = createVirtualGraphWorkspace({ project: project() });
  const path = getVirtualGraphDocumentPath(activeGraphId);
  const quotedTitleDiff = oneLineReplacementDiff({
    contents: workspace.readDocument(path).contents,
    path,
    select: (line) => line.includes('title: Before'),
    replace: (line) => line.replace('title: Before', 'title: "Before"'),
  });
  const result = workspace.applyUnifiedDiff({
    patchId: 'quoted-title',
    expectedDraftRevision: 0,
    unifiedDiff: quotedTitleDiff,
  });

  assert.equal(result.disposition, 'no-op');
  assert.deepEqual(result.delta, { graphDeltas: [] });
  assert.equal(workspace.getDraftRevision(), 0);
  assert.equal(workspace.hasDraftChanges(), false);
});
