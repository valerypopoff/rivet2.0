export const PROMO_PROJECT_MANIFEST = {
  agent: {
    file: 'promo-agent.rivet-project',
    graphId: 'promo-agent-main',
    loadingHint: 'Paste your OpenAI API key into the API Key node, then run the project.',
    path: 'rivet-agent-demo.rivet-project',
    projectId: 'rivet-promo-agent',
  },
  'visual-code': {
    file: 'promo-visual-code.rivet-project',
    graphId: 'promo-visual-code-main',
    loadingHint: 'Run the project to see visible policy checks feed one focused routing calculation.',
    path: 'rivet-visual-code-demo.rivet-project',
    projectId: 'rivet-promo-visual-code',
  },
  'web-app': {
    file: 'promo-web-app.rivet-project',
    graphId: 'promo-web-app-main',
    loadingHint: 'Paste your OpenAI API key, then open "Launch brief web app - open this" under Web Apps.',
    path: 'rivet-web-app-demo.rivet-project',
    projectId: 'rivet-promo-web-app',
  },
  workflow: {
    file: 'promo-workflow.rivet-project',
    graphId: 'promo-workflow-main',
    loadingHint: 'Paste your OpenAI API key into the API Key node, then run the project.',
    path: 'rivet-workflow-demo.rivet-project',
    projectId: 'rivet-promo-workflow',
  },
} as const;

export type PromoProjectKey = keyof typeof PROMO_PROJECT_MANIFEST;

export function isPromoProjectKey(value: string): value is PromoProjectKey {
  return Object.prototype.hasOwnProperty.call(PROMO_PROJECT_MANIFEST, value);
}
