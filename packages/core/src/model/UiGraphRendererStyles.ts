export const RIVET_WEB_APP_RENDERER_CSS = `
.rivet-web-app-root {
  --rivet-web-app-background: var(--grey-dark-colorish, #1c222b);
  --rivet-web-app-foreground: var(--foreground, #ffffff);
  --rivet-web-app-card-background: color-mix(in srgb, var(--modal-surface-bg, #252b34) 88%, var(--foreground, #ffffff) 4%);
  --rivet-web-app-card-border: var(--foldable-section-border, rgba(255, 255, 255, 0.04));
  --rivet-web-app-control-background: var(--form-control-bg, #20252d);
  --rivet-web-app-control-border: var(--form-control-border, rgba(255, 255, 255, 0.14));
  --rivet-web-app-button-radius: var(--ui-button-radius, 6px);
  --rivet-web-app-button-background: var(--success, #3ba85b);
  --rivet-web-app-button-foreground: var(--grey-lightest, #ffffff);
  --rivet-web-app-output-title: var(--primary-text, #ff9e2c);
  --rivet-web-app-error-color: var(--error, #ff6b5f);
  box-sizing: border-box;
  height: 100%;
  background: var(--rivet-web-app-background);
  color: var(--rivet-web-app-foreground);
  overflow: auto;
  font-family: Inter, system-ui, sans-serif;
}

.rivet-web-app-root *,
.rivet-web-app-root *::before,
.rivet-web-app-root *::after {
  box-sizing: border-box;
}

.rivet-web-app-surface {
  display: grid;
  gap: 16px;
  margin: 0 auto;
  max-width: 760px;
  padding: 48px 20px;
}

.rivet-web-app-card,
.rivet-web-app-field {
  border: 1px solid var(--rivet-web-app-card-border);
  border-radius: 10px;
  background: var(--rivet-web-app-card-background);
  padding: 16px;
}

.rivet-web-app-component-frame {
  border-radius: 12px;
  margin: -5px;
  padding: 4px;
}

.rivet-web-app-component-frame.active {
  background: color-mix(in srgb, var(--modal-surface-bg, #252b34) 75%, var(--primary, #ff9e2c) 16%);
}

.rivet-web-app-field {
  display: grid;
  gap: 8px;
  color: var(--rivet-web-app-foreground);
  font-size: var(--ui-font-size-base, 13px);
  font-weight: 600;
}

.rivet-web-app-field input,
.rivet-web-app-field textarea {
  appearance: none;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--rivet-web-app-control-border);
  border-radius: 8px;
  background: var(--rivet-web-app-control-background);
  color: var(--rivet-web-app-foreground);
  font: inherit;
  font-weight: 400;
  padding: 10px 12px;
}

.rivet-web-app-field textarea {
  min-height: 110px;
  resize: vertical;
}

.rivet-web-app-button {
  width: fit-content;
  border: 0;
  border-radius: var(--rivet-web-app-button-radius);
  background: var(--rivet-web-app-button-background);
  color: var(--rivet-web-app-button-foreground);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 10px 16px;
}

.rivet-web-app-button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.rivet-web-app-output {
  display: grid;
  gap: 8px;
}

.rivet-web-app-output-title {
  color: var(--rivet-web-app-output-title);
  font-weight: 700;
}

.rivet-web-app-output pre {
  margin: 0;
  background: transparent;
  border-radius: 0;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.rivet-web-app-markdown,
.rivet-web-app-output-markdown {
  word-break: break-word;
}

.rivet-web-app-markdown.markdown-body,
.rivet-web-app-output-markdown.markdown-body {
  background: transparent;
  font-family: inherit;
  min-width: 0;
}

.rivet-web-app-markdown h1,
.rivet-web-app-output-markdown h1 {
  margin: 0 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--rivet-web-app-card-border);
  font-size: 24px;
  line-height: 1.22;
}

.rivet-web-app-markdown h2,
.rivet-web-app-output-markdown h2 {
  margin: 0 0 10px;
  font-size: 20px;
  line-height: 1.25;
}

.rivet-web-app-markdown p,
.rivet-web-app-output-markdown p,
.rivet-web-app-markdown ul,
.rivet-web-app-output-markdown ul {
  margin: 0 0 12px;
}

.rivet-web-app-markdown code,
.rivet-web-app-output-markdown code {
  border-radius: 4px;
  background: color-mix(in srgb, var(--rivet-web-app-control-background) 70%, var(--rivet-web-app-foreground) 6%);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  padding: 1px 4px;
}

.rivet-web-app-markdown pre,
.rivet-web-app-output-markdown pre {
  background: transparent;
  padding: 0;
  white-space: pre-wrap;
}

.rivet-web-app-markdown > :first-child,
.rivet-web-app-output-markdown > :first-child {
  margin-top: 0;
}

.rivet-web-app-markdown > :last-child,
.rivet-web-app-output-markdown > :last-child {
  margin-bottom: 0;
}

.rivet-web-app-error {
  color: var(--rivet-web-app-error-color);
  font-weight: 700;
}
`;

export const RIVET_WEB_APP_DOCUMENT_CSS = `
html,
body {
  height: 100%;
  margin: 0;
}

body {
  min-height: 100vh;
  background: #1c222b;
}

#app {
  min-height: 100vh;
}
`;
