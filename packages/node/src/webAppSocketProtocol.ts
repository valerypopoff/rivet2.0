import WebSocket, { type RawData } from 'ws';
import type { RivetWebAppServerMessage } from '@valerypopoff/rivet2-core';

export function sendWebAppSocketMessage(socket: WebSocket, message: RivetWebAppServerMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export function sendWebAppSocketBinary(socket: WebSocket, frame: Uint8Array): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(frame, { binary: true });
    return true;
  } catch {
    return false;
  }
}

export function parseWebAppSocketMessage(raw: RawData): unknown {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return undefined;
  }
}

export function getWebAppSocketMessageByteLength(raw: RawData): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw);
  if (Array.isArray(raw)) return raw.reduce((total, chunk) => total + chunk.byteLength, 0);
  return raw.byteLength;
}

export function readWebAppSocketRequestId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('requestId' in value)) return undefined;
  return typeof value.requestId === 'string' ? value.requestId : undefined;
}

export function isWebAppSocketMessageType(value: unknown, type: string): boolean {
  return Boolean(value && typeof value === 'object' && 'type' in value && value.type === type);
}
