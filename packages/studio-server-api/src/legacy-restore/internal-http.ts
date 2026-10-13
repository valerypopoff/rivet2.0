import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Deployment-owned coordination must never inherit restored outbound proxy settings. */
export function requestRestoreEndpoint(
  url: string,
  { supervisorToken, timeoutMs = 3000 }: { supervisorToken?: string; timeoutMs?: number } = {},
): Promise<{ status: number; restoreWarmup: boolean }> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('Invalid restore coordination endpoint.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid restore coordination deadline.');
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      {
        method: supervisorToken === undefined ? 'GET' : 'POST',
        agent: false,
        headers: supervisorToken === undefined ? undefined : { 'x-rivet-supervisor-token': supervisorToken },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024) {
            const error = new Error('Restore coordination response exceeds its limit.');
            reject(error);
            request.destroy(error);
            response.destroy();
          } else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          let restoreWarmup = false;
          try {
            restoreWarmup = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.restoreWarmup === true;
          } catch {
            // Empty supervisor acknowledgements are valid; malformed health JSON cannot certify warmup.
          }
          resolve({ status: response.statusCode ?? 0, restoreWarmup });
        });
      },
    );
    const deadline = setTimeout(() => request.destroy(new Error('Restore coordination timed out.')), timeoutMs);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject);
    request.end();
  });
}
