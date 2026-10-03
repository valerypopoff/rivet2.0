// Keep this entry independent of React/CSS so a failed nested import can show
// a useful retry action instead of leaving the dashboard loading forever.
declare global {
  interface Window {
    __rivetEditorBootstrapState?: 'starting' | 'ready' | 'failed';
    __rivetShowBootstrapFailure: () => void;
  }
}
window.__rivetEditorBootstrapState = 'starting';
try {
  const { bootstrapApp } = await import('./bootstrapApp');
  await bootstrapApp();
  if (window.parent === window) window.__rivetEditorBootstrapState = 'ready';
} catch (error) {
  console.error('Rivet frontend bootstrap failed:', error);
  window.__rivetShowBootstrapFailure();
}

export {};
