import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationEvidence as evidence, migrationCommitParents } from '../migration/evidence.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..', '..', '..');
const ledgerPath = path.join(rootDir, 'deploy', 'studio-server', 'migration', 'source-file-ledger.json');

const removedFiles = new Map([
  ['.gitattributes', 'The monorepo owns line-ending policy; the standalone repository attribute was retired.'],
  ['.gitlab-ci.yml', 'The standalone GitLab pipeline was replaced by monorepo GitHub workflows.'],
  ['scripts/bootstrap-rivet.mjs', 'External Rivet checkout bootstrap became obsolete in the shared workspace.'],
  ['scripts/ensure-dev-deps.mjs', 'Nested dependency installation became obsolete under the root Yarn workspace.'],
  [
    'scripts/ensure-rivet-runtime-build.mjs',
    'External Rivet runtime build orchestration became obsolete under root workspace builds.',
  ],
  [
    'scripts/lib/rivet-local-dependencies.d.mts',
    'Generated external-package link declarations became obsolete under workspace dependencies.',
  ],
  [
    'scripts/lib/rivet-local-dependencies.mjs',
    'External-package link resolution became obsolete under workspace dependencies.',
  ],
  ['scripts/lib/rivet-source-context.mjs', 'External Rivet source checkout discovery became obsolete in the monorepo.'],
  ['scripts/link-rivet-node-package.mjs', 'External package linking became obsolete under workspace dependencies.'],
  [
    'scripts/prepare-rivet-docker-context.mjs',
    'The secondary Rivet Docker build context became obsolete with monorepo-root image builds.',
  ],
  [
    'scripts/run-preserve-symlinks.mjs',
    'The nested-install symlink launcher became obsolete under Yarn Plug and Play.',
  ],
  ['scripts/run-rivet-yarn.mjs', 'The external Rivet Yarn launcher became obsolete under the root workspace.'],
  ['wrapper/api/package-lock.json', 'The nested npm lockfile was replaced by the root Yarn lockfile.'],
  [
    'wrapper/api/src/tests/rivet-local-dependencies.test.ts',
    'The test covered the retired external-package linking machinery and has no monorepo runtime seam to test.',
  ],
  [
    'wrapper/bootstrap/proxy-bootstrap/package-lock.json',
    'The nested npm lockfile was replaced by the root Yarn lockfile.',
  ],
  ['wrapper/web/package-lock.json', 'The nested npm lockfile was replaced by the root Yarn lockfile.'],
]);

const rootDestinations = new Map([
  ['.dockerignore', ['.dockerignore']],
  ['.env.example', ['deploy/studio-server/.env.example']],
  ['.github/workflows/build-images.yml', ['.github/workflows/studio-server-images.yml']],
  ['.github/workflows/verify-develop.yml', ['.github/workflows/studio-server-verify.yml']],
  ['.gitignore', ['.gitignore']],
  ['.yarnrc.yml', ['.yarnrc.yml']],
  ['AGENTS.md', ['AGENTS.md']],
  ['LICENSE', ['LICENSE']],
  ['README.md', ['README.md', 'deploy/studio-server/README.md']],
  ['backlog.md', ['developer-docs/studio-server/backlog.md']],
  ['kubernetes_managed_mode_audit.md', ['developer-docs/studio-server/audits/kubernetes-managed-mode.md']],
  ['loc_reduce_with_libs.md', ['developer-docs/studio-server/audits/loc-reduction.md']],
  ['package.json', ['package.json']],
  ['yarn.lock', ['yarn.lock']],
  ['scripts/playwright-observe.mjs', ['packages/studio-server-web/scripts/playwright-observe.mjs']],
]);

/**
 * Reviewed post-consolidation successors. The ledger still records the exact
 * migration-era destination/blob; this mapping only proves that a later
 * refactor intentionally kept that responsibility at a tracked current path.
 */
const currentDestinationSuccessors = new Map([
  [
    'packages/studio-server-web/overrides/state/settings.ts',
    {
      path: 'packages/app/src/state/settings.ts',
      reason:
        'The shared editor owns stored debugger preferences; explicit host UI policy supplies defaults and URL normalization.',
    },
  ],
  [
    'packages/studio-server-web/overrides/state/savedGraphs.ts',
    {
      path: 'packages/app/src/hooks/workspaceHost/useWorkspaceHostProjectCleanup.ts',
      reason:
        'Workspace cleanup owns tab release and explicit durable project-context deletion; the host no longer reaches into editor storage.',
    },
  ],
  [
    'packages/studio-server-web/overrides/hooks/useCheckForUpdate.tsx',
    {
      path: 'packages/app/src/hooks/useCheckForUpdate.tsx',
      reason: 'The shared updater respects explicit host capability while keeping the standalone desktop update flow.',
    },
  ],
  [
    'packages/studio-server-web/overrides/hooks/useCopyNodesHotkeys.ts',
    {
      path: 'packages/app/src/hooks/useCopyNodesHotkeys.ts',
      reason:
        'The shared clipboard owner reads its provider store at event time; the host supplies hovered fallback and native clipboard event policy.',
    },
  ],
  [
    'packages/studio-server-web/overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts',
    {
      path: 'packages/app/src/hooks/useSyncCurrentStateIntoOpenedProjects.ts',
      reason:
        'The shared editor synchronizer owns metadata, legacy recovery and close suppression; the host supplies explicit tab and title/cache policy.',
    },
  ],
  [
    'packages/studio-server-web/overrides/hooks/useContextMenu.ts',
    {
      path: 'packages/app/src/hooks/useContextMenu.ts',
      reason:
        'The shared editor owns menu state and positioning; the host supplies only external dismissal and focus cleanup.',
    },
  ],
  [
    'packages/studio-server-web/overrides/hooks/useLoadProject.ts',
    {
      path: 'packages/app/src/hooks/useActivateOpenedProject.ts',
      reason:
        'The shared activation owner consumes host-provided Evaluation cache and executor policy without a module replacement.',
    },
  ],
  [
    'packages/studio-server-api/src/runtime-libraries/managed/job-stream.ts',
    {
      path: 'packages/studio-server-api/src/routes/runtime-library-job-stream.ts',
      reason:
        'Runtime-library observation is backend-neutral; the HTTP adapter owns SSE connections separately from durable jobs.',
    },
  ],
  [
    'packages/studio-server-web/dashboard/useEditorCommandQueue.ts',
    {
      path: 'packages/studio-server-web/dashboard/useEditorBridgeSession.ts',
      reason:
        'The bounded editor bridge session owns command delivery, acknowledgement, expiry and editor replacement.',
    },
  ],
  [
    'packages/studio-server-web/tests/hosted-fonts.test.ts',
    {
      path: 'packages/studio-server-web/playwright-observe/hosted-dashboard-contracts.spec.ts',
      reason:
        'Font source-text assertions were replaced by the rendered dashboard/editor contract in the headless CI lane.',
    },
  ],
  [
    'packages/studio-server-web/tests/modal-theme-contract.test.ts',
    {
      path: 'packages/studio-server-web/playwright-observe/hosted-dashboard-contracts.spec.ts',
      reason:
        'Modal source-text assertions were replaced by computed-style checks on all seven rendered dashboard dialogs.',
    },
  ],
  [
    'packages/studio-server-api/src/trusted-host-settings.ts',
    {
      path: 'packages/studio-server-api/src/trusted-client-settings.ts',
      reason:
        'Hostname bypass was replaced by verified client IP/network settings; legacy data remains migration information.',
    },
  ],
  [
    'packages/studio-server-web/dashboard/app-settings/useTrustedHostsForm.ts',
    {
      path: 'packages/studio-server-web/dashboard/app-settings/useTrustedClientsForm.ts',
      reason: 'The settings form now edits trusted client IPs/networks instead of hostnames.',
    },
  ],
  [
    'packages/studio-server-web/project-tab-label-transform.ts',
    {
      path: 'packages/studio-server-web/dashboard/HostedEditorApp.tsx',
      reason:
        'Hosted project-tab labels moved from a build-time source transform to the RivetAppHost projectTabs.showFileNames UI policy.',
    },
  ],
  [
    'packages/studio-server-web/dashboard/RuntimeLibrariesReplicaReadinessPanel.tsx',
    {
      path: 'packages/studio-server-web/dashboard/DeploymentReplicaReadinessPanel.tsx',
      reason: 'Replica readiness moved from Runtime libraries to Deployment settings after the monorepo import.',
    },
  ],
  [
    'packages/studio-server-web/dashboard/RuntimeLibrariesModal.css',
    {
      path: 'packages/studio-server-web/dashboard/app-settings/RuntimeLibrariesSettingsTab.css',
      reason: 'Runtime-library presentation moved from a standalone modal into the Runtime libraries Settings tab.',
    },
  ],
  [
    'packages/studio-server-web/dashboard/RuntimeLibrariesModal.tsx',
    {
      path: 'packages/studio-server-web/dashboard/app-settings/tabs/RuntimeLibrariesSettingsTab.tsx',
      reason: 'Runtime-library administration moved from a standalone modal into the application Settings tabs.',
    },
  ],
  [
    'packages/studio-server-web/dashboard/useRuntimeLibrariesModalState.ts',
    {
      path: 'packages/studio-server-web/dashboard/useRuntimeLibrariesState.ts',
      reason: 'Runtime-library state is now shared by the Settings tab instead of being owned by a standalone modal.',
    },
  ],
]);
const destinationRules = [
  ['wrapper/api/', 'packages/studio-server-api/'],
  ['wrapper/web/', 'packages/studio-server-web/'],
  ['wrapper/executor/', 'packages/studio-server-executor/'],
  ['wrapper/shared/', 'packages/studio-server-shared/'],
  ['wrapper/bootstrap/proxy-bootstrap/', 'packages/studio-server-bootstrap/'],
  ['charts/', 'deploy/studio-server/helm/'],
  ['docs/', 'developer-docs/studio-server/'],
  ['image/', 'deploy/studio-server/images/'],
  ['ops/compose/', 'deploy/studio-server/compose/'],
  ['ops/docker/', 'deploy/studio-server/compose/docker/'],
  ['ops/nginx/', 'deploy/studio-server/compose/nginx/'],
  ['scripts/', 'deploy/studio-server/scripts/'],
];

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
  });
}

function listTree(treeish) {
  const output = git(['ls-tree', '-r', '-z', treeish]);
  const entries = new Map();

  for (const record of output.split('\0').filter(Boolean)) {
    const tabIndex = record.indexOf('\t');
    assert.notEqual(tabIndex, -1, `Malformed git ls-tree record for ${treeish}`);
    const [mode, type, object] = record.slice(0, tabIndex).split(' ');
    const filePath = record.slice(tabIndex + 1);
    assert.equal(type, 'blob', `Unexpected non-blob entry in ${treeish}: ${filePath}`);
    entries.set(filePath, { mode, object });
  }

  return entries;
}

function destinationPathsFor(sourcePath) {
  const explicit = rootDestinations.get(sourcePath);
  if (explicit) return explicit;

  for (const [sourcePrefix, destinationPrefix] of destinationRules) {
    if (sourcePath.startsWith(sourcePrefix)) {
      return [`${destinationPrefix}${sourcePath.slice(sourcePrefix.length)}`];
    }
  }

  return [];
}

function transformationReason(sourcePath, destinationPaths) {
  if (sourcePath === 'README.md') {
    return 'The standalone README was split between the monorepo overview and Studio Server deployment guide.';
  }
  if (sourcePath.startsWith('.github/workflows/')) {
    return 'The standalone workflow was renamed and adapted to the monorepo workspace and release gates.';
  }
  if (
    ['.dockerignore', '.gitignore', '.yarnrc.yml', 'AGENTS.md', 'LICENSE', 'package.json', 'yarn.lock'].includes(
      sourcePath,
    )
  ) {
    return 'The standalone root configuration was merged into the corresponding monorepo-owned file.';
  }
  if (destinationPaths.some((destinationPath) => destinationPath.endsWith('/package.json'))) {
    return 'The package manifest was adapted to the root Yarn workspace and workspace dependency graph.';
  }
  return 'The file moved to its monorepo owner and was adapted for shared workspace paths or runtime contracts.';
}

function buildLedger() {
  const sourceEntries = listTree(`${evidence.importCommit}:${evidence.importPrefix}`);
  const migrationEntries = listTree(evidence.migrationCommit);
  const entries = [];
  const unresolved = [];

  for (const [sourcePath, sourceEntry] of sourceEntries) {
    const removalReason = removedFiles.get(sourcePath);
    if (removalReason) {
      entries.push({
        sourcePath,
        sourceMode: sourceEntry.mode,
        sourceBlob: sourceEntry.object,
        disposition: 'removed',
        reason: removalReason,
        destinations: [],
      });
      continue;
    }

    const destinationPaths = destinationPathsFor(sourcePath);
    const destinations = destinationPaths.flatMap((destinationPath) => {
      const destinationEntry = migrationEntries.get(destinationPath);
      if (!destinationEntry) return [];
      const successor = currentDestinationSuccessors.get(destinationPath);
      return [
        {
          path: destinationPath,
          migrationMode: destinationEntry.mode,
          migrationBlob: destinationEntry.object,
          ...(successor == null ? {} : { currentPath: successor.path, currentReason: successor.reason }),
        },
      ];
    });

    if (destinations.length !== destinationPaths.length || destinations.length === 0) {
      unresolved.push({ sourcePath, expectedDestinations: destinationPaths });
      continue;
    }

    const unchangedMove =
      destinations.length === 1 &&
      destinations[0].migrationBlob === sourceEntry.object &&
      destinations[0].migrationMode === sourceEntry.mode;
    entries.push({
      sourcePath,
      sourceMode: sourceEntry.mode,
      sourceBlob: sourceEntry.object,
      disposition: unchangedMove ? 'moved' : destinations.length > 1 ? 'merged' : 'transformed',
      ...(unchangedMove ? {} : { reason: transformationReason(sourcePath, destinationPaths) }),
      destinations,
    });
  }

  assert.deepEqual(unresolved, [], `Unresolved source paths:\n${JSON.stringify(unresolved, null, 2)}`);

  return {
    ...evidence,
    generatedFrom: 'Git objects retained by the non-squashed subtree import',
    entries,
  };
}

function verifyLedger(ledger) {
  assert.deepEqual(
    ledger,
    buildLedger(),
    'Migration ledger is stale or differs from the reviewed mapping rules; run yarn studio-server:verify:migration-ledger:write',
  );
  assert.equal(ledger.version, evidence.version);
  for (const key of ['sourceCommit', 'sourceTree', 'importCommit', 'importPrefix', 'migrationCommit']) {
    assert.equal(ledger[key], evidence[key], `Migration ledger ${key} changed unexpectedly`);
  }

  const importParents = migrationCommitParents(git(['cat-file', 'commit', evidence.importCommit]));
  assert.equal(
    importParents[1],
    evidence.sourceCommit,
    'The subtree import no longer points to the recorded source commit',
  );
  assert.equal(git(['rev-parse', `${evidence.sourceCommit}^{tree}`]).trim(), evidence.sourceTree);
  assert.equal(git(['rev-parse', `${evidence.importCommit}:${evidence.importPrefix}`]).trim(), evidence.sourceTree);
  assert.deepEqual(
    migrationCommitParents(git(['cat-file', 'commit', evidence.migrationCommit])),
    [evidence.importCommit],
    'The consolidation commit must directly follow the complete subtree import',
  );

  const sourceEntries = listTree(`${evidence.importCommit}:${evidence.importPrefix}`);
  const migrationEntries = listTree(evidence.migrationCommit);
  const currentTrackedPaths = new Set(git(['ls-files']).split(/\r?\n/).filter(Boolean));
  const ledgerSourcePaths = new Set();
  const dispositionCounts = { moved: 0, transformed: 0, merged: 0, removed: 0 };

  assert.equal(ledger.entries.length, sourceEntries.size, 'Ledger entry count must equal imported source-file count');

  for (const entry of ledger.entries) {
    assert.equal(ledgerSourcePaths.has(entry.sourcePath), false, `Duplicate source path: ${entry.sourcePath}`);
    ledgerSourcePaths.add(entry.sourcePath);

    const sourceEntry = sourceEntries.get(entry.sourcePath);
    assert.ok(sourceEntry, `Ledger path is absent from imported source: ${entry.sourcePath}`);
    assert.equal(entry.sourceMode, sourceEntry.mode, `Source mode mismatch: ${entry.sourcePath}`);
    assert.equal(entry.sourceBlob, sourceEntry.object, `Source blob mismatch: ${entry.sourcePath}`);
    assert.ok(Object.hasOwn(dispositionCounts, entry.disposition), `Invalid disposition: ${entry.disposition}`);
    dispositionCounts[entry.disposition] += 1;

    if (entry.disposition === 'removed') {
      assert.equal(entry.destinations.length, 0, `Removed entry has destinations: ${entry.sourcePath}`);
      assert.ok(entry.reason?.trim(), `Removed entry lacks a reason: ${entry.sourcePath}`);
      assert.equal(
        removedFiles.get(entry.sourcePath),
        entry.reason,
        `Removal is not in the reviewed allowlist: ${entry.sourcePath}`,
      );
      continue;
    }

    assert.ok(entry.destinations.length > 0, `Migrated entry has no destination: ${entry.sourcePath}`);
    if (entry.disposition === 'moved') {
      assert.equal(entry.destinations.length, 1, `Unchanged move has multiple destinations: ${entry.sourcePath}`);
      assert.equal(entry.destinations[0].migrationBlob, entry.sourceBlob, `Moved blob changed: ${entry.sourcePath}`);
      assert.equal(entry.destinations[0].migrationMode, entry.sourceMode, `Moved mode changed: ${entry.sourcePath}`);
      assert.equal(
        entry.reason,
        undefined,
        `Unchanged move should not carry a transformation reason: ${entry.sourcePath}`,
      );
    } else {
      assert.ok(entry.reason?.trim(), `Changed entry lacks a reason: ${entry.sourcePath}`);
    }

    for (const destination of entry.destinations) {
      const migrationEntry = migrationEntries.get(destination.path);
      assert.ok(migrationEntry, `Destination was absent at migration commit: ${destination.path}`);
      assert.equal(destination.migrationMode, migrationEntry.mode, `Migration mode mismatch: ${destination.path}`);
      assert.equal(destination.migrationBlob, migrationEntry.object, `Migration blob mismatch: ${destination.path}`);
      const currentPath = destination.currentPath ?? destination.path;
      if (destination.currentPath != null) {
        assert.notEqual(destination.currentPath, destination.path, `Successor must differ: ${destination.path}`);
        assert.ok(destination.currentReason?.trim(), `Successor lacks a reason: ${destination.path}`);
      } else {
        assert.equal(destination.currentReason, undefined, `Unexpected successor reason: ${destination.path}`);
      }
      assert.equal(
        currentTrackedPaths.has(currentPath),
        true,
        `Current destination is no longer tracked: ${currentPath}`,
      );
      assert.equal(
        fs.existsSync(path.join(rootDir, ...currentPath.split('/'))),
        true,
        `Current destination is missing: ${currentPath}`,
      );
    }
  }

  for (const sourcePath of sourceEntries.keys()) {
    assert.equal(
      ledgerSourcePaths.has(sourcePath),
      true,
      `Imported source path lacks a ledger disposition: ${sourcePath}`,
    );
  }

  assert.equal(dispositionCounts.removed, removedFiles.size, 'Reviewed removal count changed unexpectedly');
  return dispositionCounts;
}

if (process.argv.includes('--write')) {
  const ledger = buildLedger();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${ledger.entries.length} migration dispositions to ${path.relative(rootDir, ledgerPath)}.`);
} else {
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const counts = verifyLedger(ledger);
  console.log(
    `Studio Server migration ledger is valid: ${ledger.entries.length} source files; ` +
      `${counts.moved} moved unchanged, ${counts.transformed} transformed, ${counts.merged} merged, ${counts.removed} removed.`,
  );
}
