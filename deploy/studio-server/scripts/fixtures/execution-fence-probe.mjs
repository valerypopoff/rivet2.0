// Local Kubernetes protocol probe, NOT a replacement for application/storage acceptance.
import fs from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const name = process.env.POD_NAME;
if (process.env.STARTUP_FENCE === name) throw Error('Matching ordinal is startup-fenced.');
const state = { protocol: 1, withdrawalProtocol: 1, incarnation: randomUUID(), state: 'serving', operationId: null };
const active = () => Number(fs.existsSync('/tmp/active') ? fs.readFileSync('/tmp/active', 'utf8') : 0);
createServer(async (req, res) => {
  if (state.state === 'draining' && active() === 0) state.state = 'drained';
  if (req.url === '/metrics')
    return res.end(
      `rivet_published_execution_active_runs ${active()}\nrivet_published_execution_admission_limit{mode="enforce"} 10\n`,
    );
  if (req.url === '/readyz') {
    res.statusCode = state.state === 'serving' ? 200 : 503;
    return res.end('probe');
  }
  if (req.method === 'POST') {
    let body = '';
    for await (const data of req) body += data;
    const input = JSON.parse(body);
    if (input.incarnation !== state.incarnation || (state.operationId && state.operationId !== input.operationId)) {
      res.statusCode = 409;
      return res.end('{}');
    }
    state.operationId = input.operationId;
    state.state = input.action === '--withdraw-only' ? 'withdrawing' : active() ? 'draining' : 'drained';
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(state));
}).listen(8080, '0.0.0.0');
