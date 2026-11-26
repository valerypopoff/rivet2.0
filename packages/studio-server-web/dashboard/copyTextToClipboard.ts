export async function copyTextToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // HTTP deployments may not expose the Clipboard API.
    const activeElement = document.activeElement;
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    // Keep the fallback within the active modal's focus boundary.
    const container = activeElement?.closest('[role="dialog"]') ?? document.body;
    container.append(input);
    try {
      input.focus({ preventScroll: true });
      input.select();
      if (!document.execCommand('copy')) {
        throw new Error('Clipboard access was denied.');
      }
    } finally {
      input.remove();
      if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    }
  }
}
