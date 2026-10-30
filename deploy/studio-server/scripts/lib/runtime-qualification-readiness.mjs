import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readDeploymentPolicy } from './deployment-workflow.mjs';

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** Only the qualification's read-only preflight uses this private copy. Actual
 * production deployment still requires its own in-checkout installation policy. */
export async function prepareQualificationReadinessPolicy({ policyFile, root, packet, identity }) {
  policyFile = path.resolve(policyFile);
  if (inside(root, policyFile)) return policyFile;
  const bundle = path.dirname(policyFile);
  assert.equal(await fs.realpath(bundle), bundle, 'Readiness policy directory cannot be redirected');
  const approval = await readDeploymentPolicy(policyFile, bundle, identity);
  assert.ok(inside(await fs.realpath(root), await fs.realpath(packet)), 'Readiness packet escaped checkout');
  const output = path.join(packet, 'private-readiness-policy');
  await fs.mkdir(output, { mode: 0o700 }); // A second attempt cannot inherit prior policy bytes.
  const policy = structuredClone(approval.policy);
  for (const name of ['backup', 'acceptance']) {
    const bytes = await fs.readFile(approval.scripts[name]);
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      policy[name].sha256,
      'Readiness adapter changed during preparation',
    );
    const file = path.join(output, `${name}.mjs`);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    policy[name].script = path.relative(root, file);
  }
  const file = path.join(output, 'policy.json');
  await fs.writeFile(file, JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
  await readDeploymentPolicy(file, root, identity);
  return file;
}
