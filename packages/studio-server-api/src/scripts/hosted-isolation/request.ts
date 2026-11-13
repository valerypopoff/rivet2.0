import type { PrototypeRequest } from './protocol.js';

/** External HTTP bytes only. Allocate one unpooled, exclusively owned transfer
 * buffer; never detach an HTTP chunk or an existing graph value. */
export function assemblePrototypeInput(
  chunks: readonly Uint8Array[],
  transfer: boolean,
): { request: PrototypeRequest; retainedBytes: number } {
  const retainedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (!transfer) {
    const raw = Buffer.concat(chunks, retainedBytes);
    return {
      request: { inputs: { input: { type: 'any', value: JSON.parse(raw.toString()) as unknown } } },
      retainedBytes,
    };
  }
  const raw = Buffer.allocUnsafeSlow(retainedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (raw.byteOffset !== 0 || raw.buffer.byteLength !== retainedBytes || !(raw.buffer instanceof ArrayBuffer))
    throw new Error('Prototype input did not receive exclusive transfer storage.');
  return { request: { inputJson: raw.buffer }, retainedBytes };
}
