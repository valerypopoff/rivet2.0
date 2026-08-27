// Override for rivet/packages/app/src/hooks/useLoadPackagePlugin.ts
// Uses API-backed install + load flow instead of Tauri fs/http/shell/invoke

import { type PackagePluginLoadSpec } from '../../../../rivet/packages/core/src/model/PluginLoadSpec';
import { type RivetPlugin } from '@valerypopoff/rivet2-core';
import * as Rivet from '@valerypopoff/rivet2-core';
import { useState } from 'react';
import { RIVET_API_BASE_URL } from '../../../shared/hosted-env';

const API = RIVET_API_BASE_URL;

export function useLoadPackagePlugin(options: { onLog?: (message: string) => void } = {}) {
  const [packageInstallLog, setPackageInstallLog] = useState('');

  const log = (message: string) => {
    setPackageInstallLog((prev) => `${prev}${message}`);
    options.onLog?.(message);
  };

  const loadPackagePlugin = async (spec: PackagePluginLoadSpec): Promise<RivetPlugin> => {
    log(`Installing plugin: ${spec.package}@${spec.tag}\n`);

    // Step 1: Install via API (server-side download, extract, pnpm install)
    const installResp = await fetch(`${API}/plugins/install-package`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: spec.package, tag: spec.tag }),
    });

    if (!installResp.ok) {
      const text = await installResp.text();
      throw new Error(`Plugin install failed: ${text}`);
    }

    const installResult = await installResp.json();
    if (installResult.log) {
      log(installResult.log);
    }

    if (!installResult.success) {
      throw new Error(`Plugin install failed: ${installResult.log ?? 'Unknown error'}`);
    }

    log(`Plugin installed successfully: ${spec.package}@${spec.tag}\n`);

    // Step 2: Load plugin main file via API
    log(`Loading plugin main file: ${spec.package}@${spec.tag}\n`);

    const loadResp = await fetch(`${API}/plugins/load-package-main`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: spec.package, tag: spec.tag }),
    });

    if (!loadResp.ok) {
      const text = await loadResp.text();
      throw new Error(`Plugin load failed: ${text}`);
    }

    const loadResult = await loadResp.json();
    const mainContents = loadResult.contents;

    if (!mainContents) {
      throw new Error(`Plugin main file empty: ${spec.package}@${spec.tag}`);
    }

    // Step 3: Convert to base64 data URL and dynamic-import (same as upstream)
    log(`Converting plugin main file to base64\n`);
    const b64Contents = await Rivet.uint8ArrayToBase64(new TextEncoder().encode(mainContents));

    try {
      log(`Initializing plugin: ${spec.package}@${spec.tag}\n`);
      const pluginInitializer = (await import(
        /* @vite-ignore */ `data:application/javascript;base64,${b64Contents}`
      )) as {
        default: Rivet.RivetPluginInitializer;
      };

      if (typeof pluginInitializer.default !== 'function') {
        throw new Error(`Plugin ${spec.package}@${spec.tag} is not a function`);
      }

      const initializedPlugin = pluginInitializer.default(Rivet);
      return initializedPlugin;
    } catch (e) {
      throw new Error(`Error loading plugin: ${spec.package}@${spec.tag}: ${Rivet.getError(e).message}`);
    }
  };

  return {
    loadPackagePlugin,
    packageInstallLog,
    setPackageInstallLog,
  };
}
