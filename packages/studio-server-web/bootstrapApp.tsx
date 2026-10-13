import './shims/install-process-shim';
import { initializeFeatureGates } from './shims/initialize-feature-gates';

// Explicit promise ownership survives the top-level-await Rollup transform.
// A side-effect-only async module can otherwise finish importing before its
// initialization IIFE completes, bypassing entry's error handler.
export async function bootstrapApp(): Promise<void> {
  await import('../app/src/host.css');
  await import('./hosted-editor.css');
  await initializeFeatureGates();
  const { loadHostedRuntimeConfig } = await import('../studio-server-shared/hosted-env');
  const config = await loadHostedRuntimeConfig().catch((error) => {
    console.warn('Failed to load hosted runtime config; using bundled defaults.', error);
  });
  const { bindRestoreWorkspaceEpoch } = await import('./restore-workspace-epoch');
  bindRestoreWorkspaceEpoch(config?.legacyRestoreEpoch);
  const { default: ReactDOM } = await import('react-dom/client');
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  if (
    config?.legacyRestoreMaintenance === true ||
    new URLSearchParams(window.location.search).has('restore-legacy-backup')
  ) {
    const { LegacyRestorePanel } = await import('./dashboard/app-settings/tabs/LegacyRestorePanel');
    root.render(
      <main style={{ maxWidth: 800, margin: '40px auto', padding: 24 }}>
        <LegacyRestorePanel />
      </main>,
    );
  } else if (new URLSearchParams(window.location.search).has('editor')) {
    const { HostedEditorApp } = await import('./dashboard/HostedEditorApp');
    root.render(<HostedEditorApp />);
  } else {
    const { DashboardPage } = await import('./dashboard/DashboardPage');
    root.render(<DashboardPage />);
  }
}
