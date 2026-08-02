export const PROMO_PROJECT_MANIFEST = {
  agent: {
    file: 'promo-agent.rivet-project',
    graphId: 'promo-agent-main',
    loadingHint: 'Paste your OpenAI API key into the API Key node, then run the project.',
    path: 'rivet-agent-demo.rivet-project',
    projectId: 'rivet-promo-agent',
  },
  'batch-runs': {
    file: 'promo-batch-runs.rivet-project',
    graphId: 'promo-batch-runs-main',
    loadingHint: 'Paste your OpenAI API key, then run the project and inspect the three runs in Classify requests.',
    path: 'rivet-batch-runs-demo.rivet-project',
    projectId: 'rivet-promo-batch-runs',
  },
  'structured-output': {
    file: 'promo-structured-output.rivet-project',
    graphId: 'promo-structured-output-main',
    loadingHint: 'Paste your OpenAI API key, then run the project to see strict structured output become typed fields.',
    path: 'rivet-structured-output-demo.rivet-project',
    projectId: 'rivet-promo-structured-output',
  },
  'web-app': {
    file: 'promo-web-app.rivet-project',
    graphId: 'promo-web-app-chat',
    loadingHint: 'Paste your OpenAI API key, then open “Chat web app — open this” under Web Apps.',
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
