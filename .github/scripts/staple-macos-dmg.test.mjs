import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTransientStaplerFailure, parseStaplerArgs, runMacDmgStaplerWithRetries } from './staple-macos-dmg.mjs';

// test-style: fixture-read: Only read command logs produced by test-owned mock tools, never source assertions.

const networkLoss = {
  status: 68,
  output:
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe staple and validate action failed! Error 68.\n',
};
const success = { status: 0, output: 'The staple and validate action worked!\n' };

test('only explicit transient Apple network errors qualify for stapler retry', () => {
  for (const code of [1001, 1004, 1005, 1009]) {
    assert.equal(
      isTransientStaplerFailure({
        status: 68,
        output: `Error Domain=NSURLErrorDomain Code=-${code} "network failure"`,
      }),
      true,
    );
  }
  for (const result of [
    { status: 0, output: networkLoss.output },
    { status: 65, output: networkLoss.output },
    { status: null, output: networkLoss.output },
    { status: 68, output: 'CloudKit response inconsistent. No valid ticket.' },
    { status: 68, output: 'Error Domain=NSURLErrorDomain Code=-1202 "Untrusted certificate"' },
    { status: 68, output: 'The staple and validate action failed! Error 68.' },
    { status: 68, output: 'Error Domain=NSURLErrorDomain Code=-10050' },
  ])
    assert.equal(isTransientStaplerFailure(result), false);
});

function fixture(results) {
  const commands = [],
    waits = [],
    output = [],
    warnings = [];
  return {
    commands,
    waits,
    output,
    warnings,
    options: {
      run: async (program, args) => {
        commands.push([program, args]);
        return results.shift();
      },
      wait: async (delay) => waits.push(delay),
      write: (text) => output.push(text),
      warn: (text) => warnings.push(text),
    },
  };
}

test('a lost ticket connection retries the same accepted DMG without signing, submission or rebuilding', async () => {
  const f = fixture([networkLoss, success]);
  const path = 'bundles/Rivet 2_2.26.0_x64.dmg';
  assert.equal(await runMacDmgStaplerWithRetries(path, f.options), success);
  assert.deepEqual(
    f.commands,
    Array.from({ length: 2 }, () => ['xcrun', ['stapler', 'staple', path]]),
  );
  assert.deepEqual(f.waits, [5000]);
  assert.deepEqual(f.output, [networkLoss.output, success.output]);
  assert.equal(f.warnings.length, 1);
});

test('ticket retrieval recovers after the three connection losses observed in CI', async () => {
  const f = fixture([networkLoss, networkLoss, networkLoss, success]);
  assert.equal(await runMacDmgStaplerWithRetries('release.dmg', f.options), success);
  assert.deepEqual(f.commands, Array.from({ length: 4 }, () => ['xcrun', ['stapler', 'staple', 'release.dmg']]));
  assert.deepEqual(f.waits, [5000, 15000, 30000]);
  assert.match(f.warnings.at(-1), /attempt 4\/6/);
});

test('ticket retrieval can recover on the final bounded attempt', async () => {
  const f = fixture([...Array(5).fill(networkLoss), success]);
  assert.equal(await runMacDmgStaplerWithRetries('release.dmg', f.options), success);
  assert.equal(f.commands.length, 6);
  assert.deepEqual(f.waits, [5000, 15000, 30000, 60000, 120000]);
});

test('persistent network loss fails after six attempts, preserving the last native failure', async () => {
  const finalFailure = { ...networkLoss, output: `${networkLoss.output}Final ticket retrieval failed.\n` };
  const f = fixture([...Array(5).fill(networkLoss), finalFailure, success]);
  assert.equal(await runMacDmgStaplerWithRetries('release.dmg', f.options), finalFailure);
  assert.equal(f.commands.length, 6);
  assert.deepEqual(f.waits, [5000, 15000, 30000, 60000, 120000]);
  assert.equal(f.warnings.length, 5);
  assert.equal(f.output.at(-1), finalFailure.output);
  assert.match(f.warnings.at(-1), /attempt 6\/6/);
});

test('a permanent failure after a transient one stops immediately', async () => {
  const failure = { status: 68, output: 'No valid ticket.' };
  const f = fixture([networkLoss, failure, success]);
  assert.equal(await runMacDmgStaplerWithRetries('release.dmg', f.options), failure);
  assert.equal(f.commands.length, 2);
  assert.deepEqual(f.waits, [5000]);
});

test('unexpected execution exceptions are not converted into a retry or success', async () => {
  const error = new Error('unexpected command failure');
  const events = [];
  await assert.rejects(
    runMacDmgStaplerWithRetries('release.dmg', {
      run: async () => {
        events.push('run');
        throw error;
      },
      wait: async () => events.push('wait'),
    }),
    (actual) => actual === error,
  );
  assert.deepEqual(events, ['run']);
});

test('successful and permanent failures complete once without a retry', async () => {
  for (const result of [
    success,
    { status: 68, output: 'No valid ticket.' },
    { status: 65, output: 'Invalid signed DMG.' },
    { status: null, output: '', error: new Error('xcrun unavailable') },
  ]) {
    const f = fixture([result]);
    assert.equal(await runMacDmgStaplerWithRetries('release.dmg', f.options), result);
    assert.equal(f.commands.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.warnings, []);
  }
});

test('the CLI defaults to stapling and explicitly selects validation without accepting extra options', () => {
  const path = 'bundles/Rivet 2_2.26.1_aarch64.dmg';
  assert.deepEqual(parseStaplerArgs([path]), { dmgPath: path, action: 'staple' });
  assert.deepEqual(parseStaplerArgs(['--validate', path]), { dmgPath: path, action: 'validate' });
  for (const args of [[], [''], ['--validate'], ['--unknown', path], [path, '--validate'], ['--validate', path, 'extra']])
    assert.throws(() => parseStaplerArgs(args), /Usage:/);
});

test('final DMG validation retries the reported Apple connection loss without stapling again', async () => {
  const failure = { ...networkLoss, output: networkLoss.output.replace('staple and validate', 'validate') };
  const path = 'bundles/Rivet 2_2.26.1_aarch64.dmg';
  const f = fixture([failure, success]);
  assert.equal(await runMacDmgStaplerWithRetries(path, { ...f.options, action: 'validate' }), success);
  assert.deepEqual(f.commands, Array.from({ length: 2 }, () => ['xcrun', ['stapler', 'validate', path]]));
  assert.deepEqual(f.waits, [5000]);
  assert.deepEqual(f.output, [failure.output, success.output]);
  assert.match(f.warnings[0], /ticket validate/);
});

test('validation remains fail-closed for permanent errors and exhausted network failures', async () => {
  for (const failure of [
    { status: 68, output: 'No valid ticket.' },
    { status: 68, output: 'Error Domain=NSURLErrorDomain Code=-1202 "Untrusted certificate"' },
    { status: null, output: networkLoss.output },
  ]) {
    const f = fixture([networkLoss, failure, success]);
    assert.equal(await runMacDmgStaplerWithRetries('release.dmg', { ...f.options, action: 'validate' }), failure);
    assert.equal(f.commands.length, 2);
    assert.deepEqual(f.waits, [5000]);
  }
  const f = fixture([...Array(6).fill(networkLoss), success]);
  assert.equal(await runMacDmgStaplerWithRetries('release.dmg', { ...f.options, action: 'validate' }), networkLoss);
  assert.deepEqual(f.commands, Array.from({ length: 6 }, () => ['xcrun', ['stapler', 'validate', 'release.dmg']]));
  assert.deepEqual(f.waits, [5000, 15000, 30000, 60000, 120000]);
});

test('unknown stapler actions are rejected before any native command or delay', async () => {
  const f = fixture([success]);
  await assert.rejects(runMacDmgStaplerWithRetries('release.dmg', { ...f.options, action: 'submit' }), /Unsupported/);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.waits, []);
});

const nativeShell = { skip: process.platform === 'win32' ? 'Run POSIX release-script contracts in a Linux container or on macOS/Linux.' : false };

async function releaseScriptFixture(script, { count = 1, target = 'aarch64-apple-darwin', validation = 0, gatekeeper = 0, detach = 0, attach = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rivet-release-script-test-'));
  const tools = join(root, 'tools.sh');
  const bundle = join(root, 'bundle with spaces');
  const mounts = join(root, 'mounts');
  const log = join(root, 'commands.log');
  try {
    await Promise.all([mkdir(bundle), mkdir(mounts), writeFile(log, '')]);
    for (let index = 0; index < count; index++) await writeFile(join(bundle, `Rivet ${index}.dmg`), 'test-owned DMG placeholder');
    const mock = `mock_tool() {
local tool="$1"
shift
printf '%s' "$tool" >> "$MOCK_LOG"
printf '|%s' "$@" >> "$MOCK_LOG"
printf '\\n' >> "$MOCK_LOG"
case "$tool" in
  hdiutil)
    if [[ "$1" == attach ]]; then
      if (( MOCK_ATTACH != 0 )); then return "$MOCK_ATTACH"; fi
      while [[ "$1" != -mountpoint ]]; do shift; done
      mkdir "$2/Rivet 2.app"
    else
      if (( MOCK_DETACH != 0 )); then return "$MOCK_DETACH"; fi
      if [[ -d "$2/Rivet 2.app" ]]; then rmdir "$2/Rivet 2.app"; fi
    fi ;;
  node) if [[ "$1" == .github/scripts/staple-macos-dmg.mjs && "$2" == --validate ]]; then return "$MOCK_VALIDATION"; fi ;;
  spctl) return "$MOCK_GATEKEEPER" ;;
esac
}
codesign() { mock_tool codesign "$@"; }
xcrun() { mock_tool xcrun "$@"; }
hdiutil() { mock_tool hdiutil "$@"; }
node() { mock_tool node "$@"; }
spctl() { mock_tool spctl "$@"; }
`;
    await writeFile(tools, mock);
    const scriptPath = fileURLToPath(new URL(script, import.meta.url));
    const args = [scriptPath, bundle, ...(script === 'verify-macos-dmg.sh' ? [target] : [])];
    const result = spawnSync('bash', args, {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: {
        ...process.env,
        BASH_ENV: tools,
        RUNNER_TEMP: mounts,
        MOCK_LOG: log,
        MOCK_VALIDATION: String(validation), MOCK_GATEKEEPER: String(gatekeeper),
        MOCK_DETACH: String(detach), MOCK_ATTACH: String(attach),
        APPLE_SIGNING_IDENTITY: 'test-identity', APPLE_API_ISSUER: 'test-issuer',
        APPLE_API_KEY: 'test-key-id', APPLE_API_KEY_PATH: 'test-key-path',
      },
      encoding: 'utf8', timeout: 10_000,
    });
    if (result.error) throw result.error;
    const commands = (await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    const remaining = await readdir(mounts);
    const preservedApp = remaining.length === 1 && (await readdir(join(mounts, remaining[0]))).includes('Rivet 2.app');
    return { ...result, commands, remaining, preservedApp };
  } finally {
    // These are generated test placeholders, not real mounted images.
    await rm(root, { recursive: true, force: true });
  }
}

test('both real release scripts reject missing or ambiguous DMGs before native mutations or temp allocation', nativeShell, async () => {
  for (const script of ['notarize-macos-dmg.sh', 'verify-macos-dmg.sh']) {
    for (const count of [0, 2]) {
      const result = await releaseScriptFixture(script, { count });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Expected exactly one .dmg/);
      assert.deepEqual(result.commands, []);
      assert.deepEqual(result.remaining, []);
    }
  }
});

test('notarization signs and submits exactly once before stapling the same DMG', nativeShell, async () => {
  const result = await releaseScriptFixture('notarize-macos-dmg.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands.length, 3);
  assert.match(result.commands[0], /^codesign\|--force\|--timestamp/);
  assert.match(result.commands[1], /^xcrun\|notarytool\|submit/);
  assert.match(result.commands[2], /^node\|.github\/scripts\/staple-macos-dmg.mjs\|/);
  const dmg = result.commands[2].split('|').at(-1);
  assert.ok(result.commands[0].endsWith(`|${dmg}`));
  assert.ok(result.commands[1].includes(`|${dmg}|`));
});

test('verification uses validation-only retries and cleans up after success', nativeShell, async () => {
  const result = await releaseScriptFixture('verify-macos-dmg.sh');
  assert.equal(result.status, 0, result.stderr);
  const validation = result.commands.findIndex((line) => line.startsWith('node|.github/scripts/staple-macos-dmg.mjs|--validate|'));
  assert.ok(validation > 0);
  assert.match(result.commands[validation - 1], /^spctl\|--assess\|--type\|execute/);
  assert.match(result.commands[validation + 1], /^spctl\|--assess\|--type\|open/);
  assert.match(result.commands.at(-1), /^hdiutil\|detach/);
  assert.deepEqual(result.remaining, []);
});

test('validation failure preserves its exit status, blocks DMG Gatekeeper and still detaches', nativeShell, async () => {
  const result = await releaseScriptFixture('verify-macos-dmg.sh', { validation: 68 });
  assert.equal(result.status, 68, result.stderr);
  assert.equal(result.commands.some((line) => line.startsWith('spctl|--assess|--type|open')), false);
  assert.match(result.commands.at(-1), /^hdiutil\|detach/);
  assert.deepEqual(result.remaining, []);
});

test('failed detach preserves mounted contents and never masks the original verification failure', nativeShell, async () => {
  for (const validation of [0, 68]) {
    const result = await releaseScriptFixture('verify-macos-dmg.sh', { validation, detach: 16 });
    assert.equal(result.status, validation || 1, result.stderr);
    assert.match(result.stderr, /leaving it intact/);
    assert.equal(result.preservedApp, true);
  }
});

test('unsupported targets allocate no mountpoint; attach and Gatekeeper failures remain fatal', nativeShell, async () => {
  const unsupported = await releaseScriptFixture('verify-macos-dmg.sh', { target: 'unsupported' });
  assert.equal(unsupported.status, 1);
  assert.deepEqual(unsupported.commands, []);
  assert.deepEqual(unsupported.remaining, []);
  for (const options of [{ attach: 7 }, { gatekeeper: 3 }]) {
    const result = await releaseScriptFixture('verify-macos-dmg.sh', options);
    assert.equal(result.status, options.attach || options.gatekeeper, result.stderr);
    assert.deepEqual(result.remaining, []);
    assert.equal(result.commands.some((line) => line.includes('staple-macos-dmg.mjs')), false);
  }
});
