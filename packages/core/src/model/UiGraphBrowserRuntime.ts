import { getUiGraphJsonOutputFilename } from './UiGraphRuntimeModel.js';

/** Copies rendered web-app output without requiring the modern Clipboard API. */
export async function copyUiGraphText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Preview hosts and non-secure origins may not expose the Clipboard API.
  }

  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.style.opacity = '0';
  textArea.style.position = 'fixed';
  try {
    document.body.append(textArea);
    textArea.select();
    return document.execCommand?.('copy') ?? false;
  } catch {
    return false;
  } finally {
    textArea.remove();
  }
}

/** Downloads the exact JSON string rendered by a web-app output component. */
export function downloadUiGraphJsonOutput(value: string, appName: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = getUiGraphJsonOutputFilename(appName);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
