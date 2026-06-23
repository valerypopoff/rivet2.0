export function isWindowsPlatform(): boolean {
  return /Windows|Win32|Win64|WOW64/i.test(getBrowserPlatformText());
}

export function isMacOSPlatform(): boolean {
  return /Macintosh|MacIntel|MacPPC|Mac68K|Mac OS X/i.test(getBrowserPlatformText());
}

function getBrowserPlatformText(): string {
  if (typeof navigator === 'undefined') {
    return '';
  }

  const userAgentDataPlatform =
    'userAgentData' in navigator && typeof navigator.userAgentData === 'object'
      ? (navigator.userAgentData as { platform?: string } | null)?.platform
      : undefined;

  return [userAgentDataPlatform, navigator.userAgent, navigator.platform].filter(Boolean).join(' ');
}
