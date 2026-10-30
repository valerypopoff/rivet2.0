// Public only during HTTP-01 preparation: no credentials, filesystem serving,
// arbitrary requests, application proxying or execution commands.
import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export function temporaryAcmeServer(file) {
  return http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ready');
    try {
      const bytes = await fs.readFile(file);
      if (bytes.length > 2048) throw Error('Invalid challenge');
      const { token, validation } = JSON.parse(bytes);
      if (
        req.method !== 'GET' ||
        !/^[a-zA-Z0-9_-]{20,256}$/.test(token) ||
        !/^[a-zA-Z0-9_.-]{30,512}$/.test(validation) ||
        req.url !== `/.well-known/acme-challenge/${token}`
      )
        throw Error('Not a challenge');
      res.setHeader('content-type', 'text/plain');
      res.end(validation);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  temporaryAcmeServer('/acme/challenge.json').listen(8080, '0.0.0.0');
