import { RIVET_WEB_APP_PREVIEW_PARAM } from '../components/rivetWebApps/rivetWebAppPreviewContract.js';

export type PromoRootMode = 'editor' | 'web-app-preview';

export function getPromoRootMode(search: string): PromoRootMode {
  return new URLSearchParams(search).has(RIVET_WEB_APP_PREVIEW_PARAM) ? 'web-app-preview' : 'editor';
}
