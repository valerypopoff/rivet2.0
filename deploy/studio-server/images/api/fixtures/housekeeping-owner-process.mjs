import { createHousekeepingSupervisor } from '../housekeeping-supervisor.mjs';
import fs from 'node:fs/promises';
// Crash precisely during descriptor publication, not before the readiness probe.
if (process.env.RIVET_FIXTURE_CRASH_DURING_PUBLICATION === '1') {
  const rename = fs.rename;
  fs.rename = async (...args) => {
    const response = await fetch(`http://127.0.0.1:${process.env.RIVET_HOUSEKEEPING_PORT}/crash`);
    const { pid } = await response.json();
    const deadline = Date.now() + 3000;
    while (true) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      if (Date.now() >= deadline) throw Error('Fixture worker did not exit.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await rename(...args);
  };
}
const owner = createHousekeepingSupervisor({
  env: process.env,
  incarnation: process.env.RIVET_PROCESS_INCARNATION,
  token: process.env.RIVET_ROLLING_RETIREMENT_TOKEN,
  timeoutMs: 3000,
  command: [process.execPath, new URL('./housekeeping-api.mjs', import.meta.url).pathname],
});
await owner.command('acquire', process.env.RIVET_PROCESS_INCARNATION).catch((error) => {
  if (process.env.RIVET_FIXTURE_CRASH_DURING_PUBLICATION !== '1') throw error;
});
process.send({ state: owner.snapshot().state });
setInterval(() => process.send({ state: owner.snapshot().state }), 100);
