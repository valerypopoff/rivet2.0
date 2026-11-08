import assert from 'node:assert/strict';

/** Collection is best effort; it must never prevent removal of owned resources. */
export async function cleanupConnectionResetLocal({ docker, names, namespace, writeLog, removeTls }) {
  const errors = [];
  let cleanupVerified = true;
  const cleanupFailed = (error) => {
    cleanupVerified = false;
    errors.push(error);
  };
  for (const name of names.toReversed()) {
    try {
      const found = await docker(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
      if (!found.stdout.trim()) continue;
      const info = JSON.parse((await docker(['inspect', name])).stdout)[0];
      assert.equal(info.Config.Labels['rivet.connection-diagnostic'], namespace);
      assert.match(info.Id, /^[a-f0-9]{64}$/);
      try {
        const logs = await docker(['logs', info.Id]);
        await writeLog(name, logs.stdout + logs.stderr);
      } catch (error) {
        errors.push(error);
      }
      await docker(['rm', '-f', info.Id]);
    } catch (error) {
      cleanupFailed(error);
    }
  }
  try {
    const found = await docker(['network', 'ls', '--filter', `name=^${namespace}$`, '--format', '{{.ID}}']);
    if (found.stdout.trim()) {
      const network = JSON.parse((await docker(['network', 'inspect', namespace])).stdout)[0];
      assert.equal(network.Labels['rivet.connection-diagnostic'], namespace);
      assert.match(network.Id, /^[a-f0-9]{64}$/);
      await docker(['network', 'rm', network.Id]);
    }
  } catch (error) {
    cleanupFailed(error);
  }
  try {
    await removeTls();
  } catch (error) {
    cleanupFailed(error);
  }
  return { errors, cleanupVerified };
}
