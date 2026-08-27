import { resolve } from 'node:path';

export function createTauriShimAliases(shimDir: string) {
  return [
    { find: '@tauri-apps/api/app', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
    { find: '@tauri-apps/api/dialog', replacement: resolve(shimDir, 'tauri-apps-api-dialog.ts') },
    { find: '@tauri-apps/api/fs', replacement: resolve(shimDir, 'tauri-apps-api-fs.ts') },
    { find: '@tauri-apps/api/globalShortcut', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
    { find: '@tauri-apps/api/http', replacement: resolve(shimDir, 'tauri-apps-api-http.ts') },
    { find: '@tauri-apps/api/path', replacement: resolve(shimDir, 'tauri-apps-api-path.ts') },
    { find: '@tauri-apps/api/process', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
    { find: '@tauri-apps/api/shell', replacement: resolve(shimDir, 'tauri-apps-api-shell.ts') },
    { find: '@tauri-apps/api/tauri', replacement: resolve(shimDir, 'tauri-apps-api-tauri.ts') },
    { find: '@tauri-apps/api/updater', replacement: resolve(shimDir, 'tauri-noop-shims.ts') },
    { find: '@tauri-apps/api/window', replacement: resolve(shimDir, 'tauri-apps-api-window.ts') },
    { find: '@tauri-apps/api', replacement: resolve(shimDir, 'tauri-apps-api.ts') },
  ];
}

export function createModuleOverrideAliases(overrideDir: string) {
  return [
    { find: /^\.\.?\/(?:.*\/)?tauri(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/tauri.ts') },
    { find: /^\.\.?\/(?:.*\/)?deserializeProject(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'utils/deserializeProject.ts') },
    { find: /^\.\.?\/(?:.*\/)?savedGraphs(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'state/savedGraphs.ts') },
    { find: /^\.\.?\/(?:.*\/)?settings(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'state/settings.ts') },
    { find: /^\.\.?\/(?:.*\/)?useCheckForUpdate(\.js|\.ts|\.tsx)?$/, replacement: resolve(overrideDir, 'hooks/useCheckForUpdate.tsx') },
    { find: /^\.\.?\/(?:.*\/)?useContextMenu(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useContextMenu.ts') },
    { find: /^\.\.?\/(?:.*\/)?useCopyNodesHotkeys(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useCopyNodesHotkeys.ts') },
    { find: /^\.\.?\/(?:.*\/)?useLoadProject(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useLoadProject.ts') },
    { find: /^\.\.?\/(?:.*\/)?useLoadPackagePlugin(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useLoadPackagePlugin.ts') },
    { find: /^\.\.?\/(?:.*\/)?useSyncCurrentStateIntoOpenedProjects(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'hooks/useSyncCurrentStateIntoOpenedProjects.ts') },
    { find: /^\.\.?\/(?:.*\/)?TauriNativeApi(\.js|\.ts)?$/, replacement: resolve(overrideDir, 'model/native/TauriNativeApi.ts') },
  ];
}

export function createBrowserSubpathAliases(webDir: string) {
  return [
    { find: /^assemblyai$/, replacement: resolve(webDir, 'node_modules/assemblyai/dist/browser.mjs') },
    { find: /^@google\/genai$/, replacement: resolve(webDir, 'node_modules/@google/genai/dist/web/index.mjs') },
    { find: /^@google-cloud\/vertexai$/, replacement: resolve(webDir, 'shims/google-cloud-vertexai.ts') },
    { find: /^jsonpath-plus$/, replacement: resolve(webDir, 'node_modules/jsonpath-plus/dist/index-browser-esm.js') },
    { find: /^nanoid$/, replacement: resolve(webDir, 'node_modules/nanoid/index.browser.js') },
    { find: /^nanoid\/non-secure$/, replacement: resolve(webDir, 'node_modules/nanoid/non-secure/index.js') },
    // Rivet core uses Zod 4 APIs. zod@3.25+ ships that compatibility entrypoint
    // alongside its legacy default export, so always select the V4 surface here.
    { find: /^zod$/, replacement: resolve(webDir, 'node_modules/zod/v4/index.js') },
    { find: /^yaml$/, replacement: resolve(webDir, 'node_modules/yaml/browser/index.js') },
    { find: /^yaml\/util$/, replacement: resolve(webDir, 'node_modules/yaml/browser/dist/util.js') },
  ];
}
