import assert from 'node:assert/strict';
const mode = process.argv[2];
if (mode === 'early-close') process.exit(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const packet = JSON.parse(Buffer.concat(chunks));
assert.equal(packet.sourceRoot, '/app');
assert.match(packet.sourceSha, /^[a-f0-9]{40}$/);
if (mode === 'ok') assert.equal(packet.kubernetesVersion, '1.36.4-gke.2046003');
if (mode !== 'preflight') {
  const args = process.argv.slice(3);
  for (const flag of ['--interactive', '--init', '--rm', '--pull=never', '--network=none'])
    assert.ok(args.includes(flag));
  assert.equal(args.at(-1), 'preflight');
  assert.ok(!args.some((arg) => /^--(?:env|mount|volume)/.test(arg)));
}
if (mode === 'preflight' && process.env.RIVET_TEST_OFFLINE_HANG === '1') {
  process.stdout.write('offline-test-ready\n');
  setInterval(() => {}, 1000);
} else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'overflow') process.stdout.write(Buffer.alloc(65537, 65));
else if (mode === 'bad-json') process.stdout.write('not-json');
else {
  process.stdout.write(
    JSON.stringify({
      offlineFixturePassed: true,
      sourceSha: mode === 'wrong-source' ? 'f'.repeat(40) : packet.sourceSha,
    }),
  );
  if (mode === 'failed-late') {
    process.stderr.write('private fixture media-tool failure');
    setTimeout(() => process.exit(7), 30);
  }
}
