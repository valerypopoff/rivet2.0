import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { autoscalerPolicy, reconcileExecutionAutoscaling } from './execution-autoscaler.mjs';
import { createKubernetesTransport, createExecutionAutoscalerIO } from './execution-autoscaler-kubernetes.mjs';

const config = JSON.parse(process.env.RIVET_AUTOSCALER_CONFIG);
const policy = autoscalerPolicy(config.policy);
const transport = createKubernetesTransport({
  origin: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443'}`,
});
const io = createExecutionAutoscalerIO({ ...config, policy, transport });
const runner = randomUUID();
let stopped = false,
  lastCompletedAt = Date.now();
const shutdown = new AbortController();
const server = createServer((req, res) => {
  res.writeHead(Date.now() - lastCompletedAt < Math.max(180000, policy.maxReplicas * 30000) ? 200 : 503);
  res.end('autoscaler\n');
}).listen(9090, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopped = true;
    shutdown.abort();
    server.close();
  });
while (!stopped) {
  const start = Date.now();
  try {
    const result = await reconcileExecutionAutoscaling({ ...config, policy, io, runner, shouldStop: () => stopped });
    console.log(JSON.stringify({ component: 'execution-autoscaler', ...result }));
  } catch (error) {
    // No upstream bodies, bearer tokens or exec output in logs.
    console.error(JSON.stringify({ component: 'execution-autoscaler', state: 'blocked', message: error.message }));
  }
  lastCompletedAt = Date.now();
  if (!stopped)
    await sleep(Math.max(1000, policy.pollSeconds * 1000 - (Date.now() - start)), undefined, {
      signal: shutdown.signal,
    }).catch((error) => {
      if (error.name !== 'AbortError') throw error;
    });
}
