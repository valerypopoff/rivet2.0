import { base64ToUint8Array, uint8ArrayToBase64Sync } from '../../utils/base64.js';
import { classifierDataProperty } from './json.js';
import {
  assertClassifierResourceLimits,
  classifierByteView,
  CLASSIFIER_LIMITS,
  type ClassifierPreparationCheck,
} from './limits.js';

type ImageInfo = { mediaType: string; width: number; height: number };
export type PreparedClassifierImage = ImageInfo & { dataUrl: string };
class InvalidClassifierImageError extends Error {}
const invalidImage = () =>
  new InvalidClassifierImageError(
    'State images must contain inline base64 PNG, JPEG, GIF or WebP image data with valid headers and matching media type.',
  );

function isBase64(value: string): boolean {
  // Avoid repeated regexp groups: they overflow the regexp stack on large images.
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function jpegInfo(
  size: number,
  read: (offset: number, length: number) => Uint8Array,
  check?: ClassifierPreparationCheck,
): ImageInfo | undefined {
  const byte = (offset: number) => read(offset, 1)[0];
  const uint16 = (offset: number) => {
    const bytes = read(offset, 2);
    return (bytes[0]! << 8) + bytes[1]!;
  };
  let offset = 2;
  while (offset + 4 <= size) {
    check?.();
    if (byte(offset++) !== 0xff) break;
    while (byte(offset) === 0xff) {
      if ((offset & 4095) === 0) check?.();
      offset++;
    }
    const marker = byte(offset++);
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > size) break;
    const length = uint16(offset);
    if (length < 2 || offset + length > size) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
      return { mediaType: 'image/jpeg', width: uint16(offset + 5), height: uint16(offset + 3) };
    offset += length;
  }
  return undefined;
}

/** Read image headers without a browser, filesystem access, or a decoder dependency. */
function imageInfo(bytes: Uint8Array, check?: ClassifierPreparationCheck): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  let info: ImageInfo | undefined;
  if (
    bytes.length >= 33 &&
    ascii(0, 8) === '\x89PNG\r\n\x1a\n' &&
    view.getUint32(8) === 13 &&
    ascii(12, 4) === 'IHDR'
  ) {
    info = { mediaType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  } else if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    info = { mediaType: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  } else if (bytes.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    const uint24 = (offset: number) => bytes[offset]! + (bytes[offset + 1]! << 8) + (bytes[offset + 2]! << 16);
    if (chunk === 'VP8X' && bytes.length >= 30)
      info = { mediaType: 'image/webp', width: uint24(24) + 1, height: uint24(27) + 1 };
    else if (chunk === 'VP8 ' && bytes.length >= 30 && ascii(23, 3) === '\x9d\x01\x2a')
      info = {
        mediaType: 'image/webp',
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      info = { mediaType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    info = jpegInfo(bytes.length, (offset, length) => bytes.subarray(offset, offset + length), check);
  }
  if (!info || info.width === 0 || info.height === 0) throw invalidImage();
  return info;
}

function base64ImageInfo(payload: string, check?: ClassifierPreparationCheck): ImageInfo {
  // JPEG metadata may precede its dimensions. Skip segment bodies and decode
  // only the byte windows needed by the same parser used for native images.
  if (payload.startsWith('/9j/')) {
    const size = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
    let start = -1;
    let window = new Uint8Array();
    const info = jpegInfo(
      size,
      (offset, length) => {
        if (offset < start || offset + length > start + window.length) {
          start = Math.floor(offset / 3) * 3;
          // A small cache also bounds decoder calls for runs of JPEG fill bytes.
          window = base64ToUint8Array(payload.slice((start / 3) * 4, (start / 3) * 4 + 4096));
        }
        return window.subarray(offset - start, offset - start + length);
      },
      check,
    );
    if (!info || info.width === 0 || info.height === 0) throw invalidImage();
    return info;
  }
  // PNG/GIF/WebP dimensions are in the first 36 bytes.
  return imageInfo(base64ToUint8Array(payload.slice(0, 48)));
}

export function prepareNativeClassifierImage(
  value: unknown,
  check?: ClassifierPreparationCheck,
): PreparedClassifierImage {
  if (!value || typeof value !== 'object') throw invalidImage();
  const data = classifierDataProperty(value, 'data');
  const mediaType = classifierDataProperty(value, 'mediaType');
  if (!(data instanceof Uint8Array)) throw invalidImage();
  const bytes = classifierByteView(data);
  assertClassifierResourceLimits(bytes, check);
  const info = imageInfo(bytes, check);
  if (info.mediaType !== mediaType) throw invalidImage();
  check?.();
  return { ...info, dataUrl: `data:${info.mediaType};base64,${uint8ArrayToBase64Sync(bytes)}` };
}

export function nativeClassifierImage(value: unknown, check?: ClassifierPreparationCheck): string {
  return prepareNativeClassifierImage(value, check).dataUrl;
}

export function inspectClassifierImage(value: unknown, check?: ClassifierPreparationCheck): ImageInfo {
  check?.();
  if (typeof value !== 'string') throw invalidImage();
  const prefix = /^data:(image\/(?:png|jpeg|gif|webp));base64,/.exec(value);
  if (!prefix) throw invalidImage();
  const payload = value.slice(prefix[0].length);
  if (!isBase64(payload)) throw invalidImage();
  const info = base64ImageInfo(payload, check);
  if (info.mediaType !== prefix[1]) throw invalidImage();
  return info;
}

/** Recognize image bytes, not merely strings using the base64 alphabet. */
export function classifierImageFromText(value: string, check?: ClassifierPreparationCheck): string | undefined {
  return prepareClassifierImageText(value, check)?.dataUrl;
}

export function prepareClassifierImageText(
  value: string,
  check?: ClassifierPreparationCheck,
): PreparedClassifierImage | undefined {
  check?.();
  if (value.length > CLASSIFIER_LIMITS.requestBytes)
    throw new Error('Classifier image/text exceeds the 32 MiB input limit.');
  if (value.startsWith('data:image/')) {
    return { ...inspectClassifierImage(value, check), dataUrl: value };
  }
  if (!/^(?:iVBOR|\/9j\/|R0lGOD|UklGR)/.test(value) || !isBase64(value)) return undefined;
  try {
    const info = base64ImageInfo(value, check);
    return { ...info, dataUrl: `data:${info.mediaType};base64,${value}` };
  } catch (error) {
    if (error instanceof InvalidClassifierImageError) return undefined;
    throw error;
  }
}

export function assertClassifierImages(value: unknown, check?: ClassifierPreparationCheck): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('State must contain at most 128 images.');
  for (const image of value) inspectClassifierImage(image, check);
}

export function assertLiquidImageLimits(
  images: readonly PreparedClassifierImage[],
  check?: ClassifierPreparationCheck,
): void {
  if (images.length > 8) throw new Error('Liquid d1 State must contain at most 8 images.');
  let patches = 0;
  for (const { width, height } of images) {
    check?.();
    if (Math.max(width, height) / Math.min(width, height) > 100)
      throw new Error('Liquid d1 images must have an aspect ratio at most 100:1.');
    patches += Math.ceil(width / 32) * Math.ceil(height / 32);
  }
  if (patches > 10_000)
    throw new Error('Liquid d1 images must contain at most 10,000 patches of 32 by 32 pixels in total.');
}
