import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
let operationId = null;
let state = 'serving';
const server = createServer(async (req, res) => {
  if (req.url === '/crash') {
    res.end(JSON.stringify({ pid: process.pid }));
    setImmediate(() => process.exit(7));
    return;
  }
  if (req.url === '/internal/ha/runtime-contract') {
    res.end(
      JSON.stringify({
        maintenanceOwner: true,
        maintenanceReady: true,
        housekeepingIdentity: {
          podUid: process.env.RIVET_POD_UID,
          incarnation: process.env.RIVET_PROCESS_INCARNATION,
        },
      }),
    );
    return;
  }
  if (req.url === '/internal/housekeeping/handover') {
    const busy = await fs.stat(path.join(process.env.RIVET_LEGACY_RESTORE_ROOT, 'busy')).then(
      () => true,
      () => false,
    );
    res.end(JSON.stringify({ protocol: 1, operationId: req.headers['x-rivet-housekeeping-operation'], idle: !busy }));
    return;
  }
  if (req.url === '/readyz') {
    if (process.env.RIVET_FIXTURE_RESTORE_MAINTENANCE === '1') {
      res.writeHead(503).end(JSON.stringify({ restoreMaintenance: true }));
      return;
    }
    res.writeHead(state === 'serving' ? 200 : 503).end();
    return;
  }
  if (
    req.url === '/internal/process-retirement' &&
    req.headers['x-rivet-retirement-token'] === process.env.RIVET_ROLLING_RETIREMENT_TOKEN
  ) {
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      operationId = JSON.parse(Buffer.concat(chunks)).operationId;
      state = 'drained';
    }
    res.end(JSON.stringify({ protocol: 1, incarnation: process.env.RIVET_PROCESS_INCARNATION, operationId, state }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close());
