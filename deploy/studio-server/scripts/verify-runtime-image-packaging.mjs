import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Inspect complete BuildKit-produced dependency exports, not sampled files.
 * Diff IDs hash the full uncompressed layer, including modes/link metadata.
 * These local producer artifacts are not a registry/qualification trust gate. */
export function readRuntimeDependencyArchive(file) {
  const read = (name) =>
    JSON.parse(
      execFileSync('tar', ['-xOf', file, name], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      }),
    );
  const blob = (digest) => {
    assert.match(digest, digestPattern);
    return read(`blobs/sha256/${digest.slice(7)}`);
  };
  const select = (index) =>
    index.manifests?.find((entry) => entry.platform?.os === 'linux' && entry.platform?.architecture === 'amd64') ??
    (index.manifests?.length === 1 ? index.manifests[0] : null);
  let descriptor = select(read('index.json'));
  let manifest;
  for (let depth = 0; depth < 4; depth++) {
    assert.ok(descriptor, 'Archive must contain a Linux amd64 runtime export');
    manifest = blob(descriptor.digest);
    if (manifest.layers) break;
    descriptor = select(manifest);
    assert.ok(descriptor, 'Archive must contain a Linux amd64 runtime export');
  }
  assert.equal(manifest.layers?.length, 1, 'Export exactly the runtime-dependencies stage');
  const layer = manifest.layers[0],
    config = blob(manifest.config.digest);
  assert.equal(config.rootfs?.diff_ids?.length, 1);
  assert.match(config.rootfs.diff_ids[0], digestPattern);
  assert.match(layer.digest, digestPattern);
  assert.ok(Number.isSafeInteger(layer.size) && layer.size > 0);
  return { diffId: config.rootfs.diff_ids[0], digest: layer.digest, bytes: layer.size, mediaType: layer.mediaType };
}

export function assertRuntimeDependencyReuse({ baseline, sourceChanged, cold, dependencyChanged }) {
  for (const observed of [sourceChanged, cold]) {
    assert.equal(observed.diffId, baseline.diffId, 'Complete dependency payload/metadata changed');
    assert.equal(observed.digest, baseline.digest, 'Compressed dependency layer is not reusable');
  }
  assert.notEqual(
    dependencyChanged.diffId,
    baseline.diffId,
    'A changed dependency/security payload must invalidate reuse',
  );
}

export function assertColdRuntimeDependencyBuild(log) {
  const runs = [...log.matchAll(/^#([0-9]+) \[(?:dependencies|esbuild-security)[^\]]*\] RUN /gm)];
  assert.ok(runs.length > 0, 'Cold build must record actual dependency/toolchain instructions');
  for (const [, id] of runs)
    assert.ok(
      !new RegExp(`^#${id} CACHED$`, 'm').test(log),
      'Cold-cache proof reused a dependency/toolchain build instruction',
    );
}

/** Explicit local diagnostic; never part of ordinary rollout or its acceptance.
 * No push, registry mutation, Kubernetes command or automatic retry is issued. */
export async function verifyRuntimeImagePackaging({ builder, coldBuilder, directory, execute = execFileSync } = {}) {
  assert.match(builder ?? '', /^[a-z0-9][a-z0-9_.-]{0,63}$/);
  assert.match(coldBuilder ?? '', /^[a-z0-9][a-z0-9_.-]{0,63}$/);
  assert.notEqual(coldBuilder, builder, 'Use a separate fresh local builder for the cold-cache proof');
  const id = randomUUID();
  directory ??= path.join(root, 'artifacts/runtime-image-packaging', id);
  await fs.mkdir(directory, { recursive: true });
  const docker = (args, options = {}) =>
    execute('docker', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  const source = await fs.readFile(path.join(root, 'deploy/studio-server/images/api/Dockerfile'), 'utf8');
  const marker = 'COPY packages ./packages';
  assert.equal(source.split(marker).length, 2);
  const fixtureModule = '/app/packages/studio-server-api/src/runtime-packaging-fixture.ts';
  const changedSource = source.replace(
    marker,
    `${marker}\nRUN ${JSON.stringify([
      'node',
      '-e',
      `require('node:fs').writeFileSync('${fixtureModule}', 'export const packagingRevision = "changed-source";\\n');`,
    ])}`,
  );
  const boundary = 'FROM scratch AS runtime-dependencies';
  assert.equal(source.split(boundary).length, 2);
  const changedDependency = source.replace(
    boundary,
    `RUN ${JSON.stringify([
      'node',
      '-e',
      "require('node:fs').appendFileSync('/runtime-dependencies/app/node_modules/esbuild/bin/esbuild', '\\npackaging-security-input-fixture\\n');",
    ])}\n\n${boundary}`,
  );
  const builds = [
    { name: 'baseline', source },
    { name: 'sourceChanged', source: changedSource },
    { name: 'cold', source, cold: true },
    { name: 'dependencyChanged', source: changedDependency },
  ];
  const report = { protocol: 1, localOnly: true, builder, coldBuilder, layers: {}, images: {} };
  for (const build of builds) {
    const dockerfile = path.join(directory, `${build.name}.Dockerfile`);
    const archive = path.join(directory, `${build.name}.tar`);
    await fs.writeFile(dockerfile, build.source, { flag: 'wx' });
    const log = await fs.open(path.join(directory, `${build.name}.log`), 'wx');
    try {
      docker(
        [
          'buildx',
          'build',
          '--builder',
          build.cold ? coldBuilder : builder,
          '--platform',
          'linux/amd64',
          '--target',
          'runtime-dependencies',
          '--file',
          dockerfile,
          '--output',
          `type=oci,dest=${archive},compression=gzip,compression-level=6,force-compression=true`,
          '.',
        ],
        { stdio: ['ignore', log.fd, log.fd] },
      );
    } finally {
      await log.close();
    }
    if (build.cold)
      assertColdRuntimeDependencyBuild(await fs.readFile(path.join(directory, `${build.name}.log`), 'utf8'));
    report.layers[build.name] = readRuntimeDependencyArchive(archive);
    console.log(JSON.stringify({ phase: build.name, ...report.layers[build.name] }));
    if (build.name === 'sourceChanged' || build.cold) {
      assert.equal(
        report.layers[build.name].diffId,
        report.layers.baseline.diffId,
        'Complete dependency payload/metadata changed',
      );
      assert.equal(
        report.layers[build.name].digest,
        report.layers.baseline.digest,
        'Compressed dependency layer is not reusable',
      );
    }
  }
  assertRuntimeDependencyReuse(report.layers);
  for (const name of ['baseline', 'sourceChanged']) {
    const image = `rivet-packaging-api:${id}-${name.toLowerCase()}`;
    const log = await fs.open(path.join(directory, `${name}-image.log`), 'wx');
    try {
      docker(
        [
          'buildx',
          'build',
          '--builder',
          builder,
          '--platform',
          'linux/amd64',
          '--load',
          '--file',
          path.join(directory, `${name}.Dockerfile`),
          '--tag',
          image,
          '.',
        ],
        { stdio: ['ignore', log.fd, log.fd] },
      );
    } finally {
      await log.close();
    }
    const inspected = JSON.parse(docker(['image', 'inspect', image]))[0];
    assert.ok(
      inspected.RootFS.Layers.includes(report.layers.baseline.diffId),
      'The actual runtime image must reuse the tested complete dependency layer',
    );
    const fingerprintScript = path.join(root, 'deploy/studio-server/images/lib/normalize-runtime-dependencies.mjs');
    const fingerprint = JSON.parse(
      docker([
        'run',
        '--rm',
        '--pull=never',
        '--network=none',
        '--read-only',
        '--user=10001:10001',
        '--cap-drop=ALL',
        '--mount',
        `type=bind,source=${fingerprintScript},target=/fingerprint.mjs,readonly`,
        '--entrypoint',
        'node',
        image,
        '--input-type=module',
        '-e',
        "import {fingerprintRuntimeDependencies as f} from '/fingerprint.mjs';console.log(JSON.stringify(await f('/app/node_modules')))",
      ]),
    );
    const fixture = '/app/packages/studio-server-api/dist/studio-server-api/src/runtime-packaging-fixture.js';
    const check =
      name === 'baseline'
        ? `if(require('node:fs').existsSync('${fixture}'))process.exit(1)`
        : `const m=await import('${fixture}');if(m.packagingRevision!=='changed-source')process.exit(1)`;
    docker([
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--entrypoint',
      'node',
      image,
      '--input-type=module',
      '-e',
      name === 'baseline'
        ? `import {createRequire} from 'node:module';const require=createRequire(import.meta.url);${check}`
        : check,
    ]);
    report.images[name] = { image, fingerprint };
  }
  assert.deepEqual(report.images.baseline.fingerprint, report.images.sourceChanged.fingerprint);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  return { directory, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv[2],
    '--builder',
    'Usage: node verify-runtime-image-packaging.mjs --builder <local-builder>',
  );
  assert.equal(process.argv[4], '--cold-builder');
  assert.equal(process.argv.length, 6);
  const result = await verifyRuntimeImagePackaging({ builder: process.argv[3], coldBuilder: process.argv[5] });
  console.log(JSON.stringify({ report: path.join(result.directory, 'report.json'), passed: true }));
}
