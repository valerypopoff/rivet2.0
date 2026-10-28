// Local command fixture only. Not a provider driver or qualification evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { operation, privateDirectory } = JSON.parse(input);
const phase = process.argv[2];
if (
  Object.keys(process.env).some((name) => {
    const key = name.toUpperCase();
    return (
      key.startsWith('RIVET_QUALIFICATION_PRODUCTION_') ||
      key.startsWith('GITHUB_') ||
      key.startsWith('ACTIONS_') ||
      ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN'].includes(key)
    );
  })
)
  throw Error('Production/Actions credential environment leaked to a provider child');
await fs.appendFile(path.join(privateDirectory, 'calls.jsonl'), JSON.stringify(phase) + '\n');
const facts = JSON.parse(await fs.readFile(new URL('./facts.json', import.meta.url), 'utf8'));
if (facts.fail === phase) {
  console.error('PRIVATE-TEST-CREDENTIAL');
  process.exit(3);
}
const result = {
  ...facts[phase],
  protocol: 1,
  operationId: operation.operationId,
  inputHash: operation.inputHash,
  projectId: operation.projectId,
  projectNumber: operation.projectNumber,
};
if (phase === 'upgrade' || phase === 'autoscaling') {
  const started = Date.now();
  result.startedAt = new Date(started).toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  result.finishedAt = new Date().toISOString();
  if (phase === 'upgrade')
    for (const key of ['initialAutoscaler', 'autoscaler', 'finalAutoscaler'])
      result.outcomes[key].sampleAt = started + 1;
}
if (phase === 'armExpiry') {
  result.expiresAt = operation.expiresAt;
  result.maxUsd = operation.maxUsd;
  result.stagingClusterUid = operation.staging.clusterUid;
}
if (phase === 'prepare' || phase === 'settle')
  for (const item of result.inventory) {
    item.operationId = operation.operationId;
    item.projectNumber = operation.projectNumber;
  }
if (phase === 'verifyCleanup') {
  const { createHash } = await import('node:crypto');
  const items = facts.settle.inventory.map((item) => ({
    ...item,
    operationId: operation.operationId,
    projectNumber: operation.projectNumber,
  }));
  result.inventoryHash = createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
process.stdout.write(JSON.stringify(result));
