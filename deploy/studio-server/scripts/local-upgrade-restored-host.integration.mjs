import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  createRestoredContainerTracker,
  assertRestoredRehearsalResult,
  redactedRestoredFailureStep,
} from './local-upgrade-restored-rehearsal.mjs';
import { restoreLocalUpgradeBackup, assertBackupDirectory } from './local-upgrade-backup.mjs';

// Runs directly on a Linux Docker host. No Docker socket is ever mounted into
// a container. All payloads are generated here, not copied from a real stack.
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
async function main() {
  assert.equal(process.platform, 'linux', 'This integration gate requires a Linux Docker host.');
  assert.equal(process.getuid(), 0, 'Use sudo for ownership-preserving disposable host fixtures.');
  const reference =
    process.env.RIVET_REHEARSAL_API_IMAGE || `${process.env.IMAGE_NAMESPACE}/api:${process.env.SOURCE_TAG}`;
  assert.ok(reference && !reference.includes('undefined') && !reference.endsWith(':latest'));
  const docker = (args) => exec('docker', args, { timeout: 900_000, maxBuffer: 4 * 1048576 });
  const image = JSON.parse((await docker(['image', 'inspect', reference])).stdout)[0];
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  if (process.env.GITHUB_SHA)
    assert.equal(image.Config.Labels['org.opencontainers.image.revision'], process.env.GITHUB_SHA);
  const directory = path.join(root, 'artifacts', 'local-upgrade');
  await fs.mkdir(directory, { recursive: true });
  await assertBackupDirectory(directory);
  const output = await fs.mkdtemp(path.join(directory, 'linux-host-'));
  const owner = 'rivet-restored-host-' + randomUUID();
  const publicReport = path.join(directory, 'host-summary-' + randomUUID());
  await fs.mkdir(publicReport, { mode: 0o755 });
  await fs.chmod(publicReport, 0o755);
  const writeSummary = async (name, summary) => {
    const file = path.join(publicReport, name);
    await fs.writeFile(file, JSON.stringify(summary), { mode: 0o644, flag: 'wx' });
    // sudo may inherit a restrictive umask. These explicitly redacted reports
    // must remain readable by the non-root CI artifact uploader.
    await fs.chmod(file, 0o644);
  };
  const volume = owner + '-data';
  const tracker = createRestoredContainerTracker(docker, owner);
  let volumeCreated = false;
  let phase = 'fixture-generation';
  let result;
  let receipt;
  try {
    const existing = await docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']);
    assert.equal(existing.stdout.trim(), '');
    await docker(['volume', 'create', '--label', `rivet.local-upgrade.restored=${owner}`, volume]);
    volumeCreated = true;
    // Only generated package/project bytes; no workflow is executed and no
    // public registry, provider, database or production mount is reachable.
    await tracker.start([
      '--network',
      'none',
      '--user',
      '0',
      '--mount',
      `type=volume,source=${volume},target=/fixture`,
      '--mount',
      `type=bind,source=${path.join(root, 'deploy/studio-server/scripts/local-upgrade-backup.mjs')},target=/tools/local-upgrade-backup.mjs,readonly`,
      '--mount',
      `type=bind,source=${path.join(root, 'deploy/studio-server/scripts/local-upgrade-snapshot-plan.mjs')},target=/tools/local-upgrade-snapshot-plan.mjs,readonly`,
      '--entrypoint',
      'node',
      image.Id,
      '--input-type=module',
      '-e',
      `
      const fs=await import('node:fs/promises');
      const base='/app/packages/studio-server-api/dist/studio-server-api/src/';
      const {createBlankProjectFile}=await import(base+'routes/workflows/fs-helpers.js');
      const {createLocalUpgradeBackup}=await import('/tools/local-upgrade-backup.mjs');
      const roots=Object.fromEntries(['workflows','recordings','appData','runtimeLibraries'].map(domain=>[domain,'/fixture/source/'+domain]));
      for(const directory of Object.values(roots))await fs.mkdir(directory,{recursive:true,mode:0o700});
      await fs.mkdir(roots.workflows+'/empty');
      // Model an already-running legacy server: its normal startup creates
      // these empty roots. If omitted, first clone boot changes the frozen
      // source fingerprint even though no user data was written.
      for(const directory of ['.published','.rivet-move-transactions','.rivet-publication-transactions'])
        await fs.mkdir(roots.workflows+'/'+directory);
      await fs.mkdir(roots.runtimeLibraries+'/staging');
      await fs.writeFile(roots.workflows+'/fixture.rivet-project',createBlankProjectFile('Host rehearsal'));
      await fs.mkdir(roots.appData+'/settings');
      await fs.writeFile(roots.appData+'/settings/environment-variables.json',JSON.stringify({version:1,variables:[{id:'fixture-env',name:'FIXTURE_VALUE',value:'synthetic',browserAccess:false}]}));
      const {FilesystemRivetEvaluationStore}=await import(base+'evaluation-runs/filesystem-store.js');
      const {FilesystemRivetLLMProfileHealthStore}=await import(base+'llm-profile-health/filesystem-store.js');
      const evaluations=new FilesystemRivetEvaluationStore(roots.appData+'/evaluation-runs.sqlite');
      const health=new FilesystemRivetLLMProfileHealthStore(roots.appData+'/llm-profile-health.sqlite');
      try {await evaluations.getLibrarySnapshot();await health.list();}
      finally {await evaluations.dispose();await health.dispose();}
      await fs.mkdir(roots.runtimeLibraries+'/current/node_modules/example',{recursive:true});
      await fs.writeFile(roots.runtimeLibraries+'/current/package.json','{"private":true}');
      await fs.writeFile(roots.runtimeLibraries+'/current/node_modules/example/index.js','module.exports=42;');
      await fs.writeFile(roots.runtimeLibraries+'/manifest.json',JSON.stringify({packages:{example:{name:'example',version:'1.0.0'}},updatedAt:'2026-01-01T00:00:00.000Z'}));
      const result=await createLocalUpgradeBackup({roots,destination:'/fixture/backup',assertFrozen:async()=>{}});
      console.log(JSON.stringify({receipt:result.receipt}));
      `,
    ]);
    assert.equal((await docker(['wait', owner])).stdout.trim(), '0', 'Fixture generation failed.');
    const logs = (await docker(['logs', owner])).stdout;
    receipt = JSON.parse(
      logs
        .trim()
        .split('\n')
        .find((line) => line.startsWith('{')),
    ).receipt;
    const backup = path.join(output, 'backup');
    phase = 'independent-backup-restore';
    await docker(['cp', owner + ':/fixture/backup', backup]);
    const restored = path.join(output, 'restored');
    await restoreLocalUpgradeBackup({ backup, receipt, destination: restored });
    await exec('chown', ['-R', '10001:10001', restored]);
    phase = 'restored-copy-orchestration';
    await exec(
      process.execPath,
      [
        path.join(root, 'deploy/studio-server/scripts/local-upgrade-restored-rehearsal.mjs'),
        '--restored',
        restored,
        '--receipt',
        receipt,
        '--image',
        image.Id,
        '--memory-mib',
        '1024',
        '--cpus',
        '1',
        '--output',
        path.join(output, 'run'),
        '--run',
      ],
      { timeout: 900_000, maxBuffer: 1048576, env: process.env },
    );
    result = JSON.parse(await fs.readFile(path.join(output, 'run/result.json'), 'utf8'));
    assertRestoredRehearsalResult(result, {
      imageId: image.Id,
      backupReceipt: receipt,
      memoryMiB: 1024,
      cpus: 1,
    });
  } catch {
    let rehearsalStep = null;
    try {
      const privateResult = JSON.parse(await fs.readFile(path.join(output, 'run/result.json'), 'utf8'));
      rehearsalStep = redactedRestoredFailureStep(privateResult, { imageId: image.Id, backupReceipt: receipt });
    } catch {
      // A preflight or interrupted run may have no private result yet.
    }
    await writeSummary('failure.json', {
      passed: false,
      phase,
      ...(rehearsalStep ? { rehearsalStep } : {}),
      imageId: image.Id,
      checkedAt: new Date().toISOString(),
    });
    throw new Error('Synthetic host integration failed in ' + phase + '.');
  } finally {
    try {
      const cleaned = await tracker.cleanup(true);
      assert.equal(cleaned.failed, false, 'Owned host fixture cleanup failed.');
      if (volumeCreated) {
        const info = JSON.parse((await docker(['volume', 'inspect', volume])).stdout)[0];
        assert.equal(info.Labels?.['rivet.local-upgrade.restored'], owner);
        await docker(['volume', 'rm', volume]);
      }
    } catch {
      await writeSummary('cleanup-failure.json', {
        passed: false,
        phase: 'owned-resource-cleanup',
        imageId: image.Id,
        checkedAt: new Date().toISOString(),
      });
      throw new Error('Owned host fixture cleanup failed.');
    }
    // Keep independent host backup, clone and reports. Never delete user data.
  }
  // Do not publish a successful receipt until owned-resource cleanup succeeds.
  await writeSummary('result.json', {
    passed: true,
    imageId: image.Id,
    sourceCommit: image.Config.Labels?.['org.opencontainers.image.revision'] ?? null,
    phases: result.phases,
    memoryLimitMiB: result.memoryLimitMiB,
    sampledPeakMemoryBytes: result.sampledPeakMemoryBytes,
    cpus: result.cpus,
    scope: 'Generated synthetic Linux-host fixture, not production qualification.',
  });
  console.log('PASS: direct Linux-host restored-copy runner; synthetic data, not production certification.');
}
main().catch(() => {
  console.error(
    'Linux-host restored-copy gate failed. Inspect protected owned fixture reports; production was not touched.',
  );
  process.exitCode = 1;
});
