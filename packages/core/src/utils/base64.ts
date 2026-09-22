function encodeWithBtoa(bytes: Uint8Array): string {
  const chunks: string[] = [];
  // Every non-final chunk must contain a multiple of three bytes so its padding
  // cannot interrupt the combined base64 stream.
  for (let offset = 0; offset < bytes.length; offset += 0x6000) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
  }
  return chunks.join('');
}

export async function uint8ArrayToBase64(uint8Array: Uint8Array): Promise<string> {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8Array).toString('base64');
  }
  if (typeof FileReader !== 'undefined') {
    const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('Failed to encode bytes as base64'));
      reader.readAsDataURL(blob);
    });
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }
  // Browser workers have btoa but neither window nor FileReader.
  return encodeWithBtoa(uint8Array);
}

export function uint8ArrayToBase64Sync(uint8Array: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8Array).toString('base64');
  }
  return encodeWithBtoa(uint8Array);
}

export function base64ToUint8Array(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
