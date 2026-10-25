import { useState } from 'react';
import type { PackagePluginLoadSpec } from '@valerypopoff/rivet2-core';
import { useProviders } from '../providers/ProvidersContext.js';
import { loadDesktopPackagePlugin } from '../utils/loadDesktopPackagePlugin.js';

/** Shared UI/log ownership; hosts replace only the package-loading transport. */
export function useLoadPackagePlugin(options: { onLog?: (message: string) => void } = {}) {
  const [packageInstallLog, setPackageInstallLog] = useState('');
  const { packagePluginLoader = loadDesktopPackagePlugin } = useProviders();
  const loadPackagePlugin = (spec: PackagePluginLoadSpec) =>
    packagePluginLoader(spec, (message) => {
      setPackageInstallLog((previous) => previous + message);
      options.onLog?.(message);
    });
  return { loadPackagePlugin, packageInstallLog, setPackageInstallLog };
}
