import { mountRivetWebApp, readEmbeddedConfig } from './webAppClientRenderer.js';
import type { WebAppClientConfig } from './webAppClientTypes.js';

declare global {
  interface Window {
    __RIVET_WEB_APP__?: WebAppClientConfig;
  }
}

const root = document.getElementById('app');
const config = window.__RIVET_WEB_APP__ ?? readEmbeddedConfig(root);
if (root && config) mountRivetWebApp(root, config);
