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
  await loadHostedRuntimeConfig().catch((error) => {
    console.warn('Failed to load hosted runtime config; using bundled defaults.', error);
  });
  const { default: ReactDOM } = await import('react-dom/client');
  const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
  if (new URLSearchParams(window.location.search).has('editor')) {
    const { HostedEditorApp } = await import('./dashboard/HostedEditorApp');
    root.render(<HostedEditorApp />);
  } else {
    const { DashboardPage } = await import('./dashboard/DashboardPage');
    root.render(<DashboardPage />);
  }
}
