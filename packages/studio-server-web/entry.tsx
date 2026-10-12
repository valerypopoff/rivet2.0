// Keep this entry independent of React/CSS so a failed nested import can show
// a useful retry action instead of leaving the dashboard loading forever.
declare global {
  interface Window {
    __rivetEditorBootstrapState?: 'starting' | 'ready' | 'failed';
    __rivetShowBootstrapFailure: () => void;
  }
}
window.__rivetEditorBootstrapState = 'starting';
// Dashboard embeds inherit its retention connection. A directly opened editor
// has no dashboard, so it must retain its own lazy chunks across rebuilds.
const generation = document.querySelector<HTMLMetaElement>('meta[name="rivet-dev-generation"]')?.content;
if (
  import.meta.env.VITE_TUNNEL_DEV === 'true' &&
  generation &&
  window.parent === window &&
  new URLSearchParams(window.location.search).has('editor')
) {
  const url = `/__rivet_dev/events?generation=${encodeURIComponent(generation)}`;
  let retention = new EventSource(url);
  window.addEventListener('pagehide', () => retention.close());
  window.addEventListener('pageshow', () => {
    if (retention.readyState === EventSource.CLOSED) retention = new EventSource(url);
  });
}
try {
  const { bootstrapApp } = await import('./bootstrapApp');
  await bootstrapApp();
  if (window.parent === window) window.__rivetEditorBootstrapState = 'ready';
} catch (error) {
  console.error('Rivet frontend bootstrap failed:', error);
  window.__rivetShowBootstrapFailure();
}

export {};
