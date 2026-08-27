import './shims/install-process-shim';
import { initializeFeatureGates } from './shims/initialize-feature-gates';

await import('../../rivet/packages/app/src/host.css');
await import('./hosted-editor.css');
await initializeFeatureGates();

const { loadHostedRuntimeConfig } = await import('../shared/hosted-env');
await loadHostedRuntimeConfig().catch((error) => {
  console.warn('Failed to load hosted runtime config; using bundled defaults.', error);
});

const isEditorFrame = new URLSearchParams(window.location.search).has('editor');

const { default: ReactDOM } = await import('react-dom/client');
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

if (isEditorFrame) {
  // Inside the iframe - render the normal Rivet editor + message bridge
  const { HostedEditorApp } = await import('./dashboard/HostedEditorApp');
  root.render(<HostedEditorApp />);
} else {
  // Top-level page - render dashboard with sidebar + editor iframe
  const { DashboardPage } = await import('./dashboard/DashboardPage');
  root.render(<DashboardPage />);
}

export {};
