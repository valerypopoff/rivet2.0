import path from 'node:path';
import { productionServer } from '../../../packages/studio-server-web/production/server.mjs';
import { listenLocal, closeLocal } from './support.mjs';

const [directory, requestedPort = '0'] = process.argv.slice(2);
if (!directory) throw new Error('Usage: serve.mjs <production-dist> [local-port]');
const { server } = await productionServer({ root: path.resolve(directory) });
console.log(`Local benchmark assets: http://127.0.0.1:${await listenLocal(server, Number(requestedPort))}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void closeLocal(server);
  });
