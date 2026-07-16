import type { RivetMarkdownSanitizerPolicy, UiGraph } from '@valerypopoff/rivet2-core/web-app-runtime';

export type WebAppClientConfig = {
  actionPath?: string;
  actionTransport?: { type: 'http'; actionPath: string } | { type: 'websocket'; socketPath: string };
  initialState: Record<string, unknown>;
  markdownSanitizerPolicy: RivetMarkdownSanitizerPolicy;
  revisionKey?: string;
  uiGraph: UiGraph;
};
