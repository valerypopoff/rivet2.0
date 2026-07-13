export const RIVET_WEB_APP_RENDERER_CSS = `
.rivet-web-app-root {
  --rivet-web-app-background: var(--grey-dark-colorish, #1c222b);
  --rivet-web-app-foreground: var(--foreground, #ffffff);
  --rivet-web-app-card-background: color-mix(in srgb, var(--modal-surface-bg, #252b34) 88%, var(--foreground, #ffffff) 4%);
  --rivet-web-app-card-border: var(--foldable-section-border, rgba(255, 255, 255, 0.04));
  --rivet-web-app-control-background: var(--form-control-bg, #20252d);
  --rivet-web-app-control-border: var(--form-control-border, rgba(255, 255, 255, 0.14));
  --rivet-web-app-button-radius: var(--rivet-web-app-host-button-radius, 6px);
  --rivet-web-app-button-background: var(--success, #3ba85b);
  --rivet-web-app-button-foreground: var(--grey-lightest, #ffffff);
  --rivet-web-app-output-title: var(--rivet-web-app-foreground, #ffffff);
  --rivet-web-app-error-color: var(--error, #ff6b5f);
  --rivet-web-app-font-size: var(--rivet-web-app-host-font-size, 15px);
  --rivet-web-app-chat-min-height: clamp(360px, calc(100vh - 136px), 540px);
  box-sizing: border-box;
  height: 100%;
  background: var(--rivet-web-app-background);
  color: var(--rivet-web-app-foreground);
  overflow: auto;
  font-family: Inter, system-ui, sans-serif;
  font-size: var(--rivet-web-app-font-size);
  line-height: 1.4;
}

.rivet-web-app-root *,
.rivet-web-app-root *::before,
.rivet-web-app-root *::after {
  box-sizing: border-box;
}

.rivet-web-app-surface {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
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

.rivet-web-app-text {
  background: transparent;
}

.rivet-web-app-gap {
  width: 100%;
  border: 0;
  background: transparent;
}

.rivet-web-app-gap-small {
  height: 8px;
}

.rivet-web-app-gap-medium {
  height: 24px;
}

.rivet-web-app-gap-large {
  height: 48px;
}

.rivet-web-app-component-frame {
  flex: 0 0 auto;
  border-radius: 12px;
  margin: -5px;
  padding: 4px;
}

.rivet-web-app-component-frame[data-rivet-web-app-component-type='chat'] {
  display: flex;
  flex: 1 0 var(--rivet-web-app-chat-min-height);
  min-height: var(--rivet-web-app-chat-min-height);
}

.rivet-web-app-component-frame.active {
  background: color-mix(in srgb, var(--modal-surface-bg, #252b34) 75%, var(--primary, #ff9e2c) 16%);
}

.rivet-web-app-field {
  display: grid;
  gap: 8px;
  color: var(--rivet-web-app-foreground);
  font-size: inherit;
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

.rivet-web-app-chat {
  display: grid;
  flex: 1;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--rivet-web-app-card-border);
  border-radius: 14px;
  background: var(--rivet-web-app-card-background);
}

.rivet-web-app-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  border-bottom: 1px solid var(--rivet-web-app-card-border);
  padding: 0 18px;
  font-weight: 700;
}

.rivet-web-app-chat-status {
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 56%, transparent);
  font-size: 12px;
  font-weight: 500;
}

.rivet-web-app-chat-messages {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 18px;
  scrollbar-gutter: stable;
}

.rivet-web-app-chat-messages > :first-child {
  margin-top: auto;
}

.rivet-web-app-chat-empty {
  display: grid;
  place-content: center;
  gap: 6px;
  flex: 1;
  min-height: 220px;
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 56%, transparent);
  text-align: center;
}

.rivet-web-app-chat-empty strong {
  color: var(--rivet-web-app-foreground);
  font-size: 17px;
}

.rivet-web-app-chat-message {
  width: fit-content;
  max-width: min(82%, 620px);
  border: 1px solid var(--rivet-web-app-card-border);
  border-radius: 14px;
  padding: 10px 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.rivet-web-app-chat-message-user {
  align-self: flex-end;
  border-bottom-right-radius: 5px;
  background: color-mix(in srgb, var(--rivet-web-app-button-background) 72%, var(--rivet-web-app-card-background));
  color: var(--rivet-web-app-button-foreground);
}

.rivet-web-app-chat-message-assistant {
  align-self: flex-start;
  border-bottom-left-radius: 5px;
  background: var(--rivet-web-app-control-background);
}

.rivet-web-app-chat-thinking {
  display: flex;
  gap: 5px;
  align-items: center;
  min-width: 52px;
  min-height: 38px;
}

.rivet-web-app-chat-thinking span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.35;
  animation: rivet-web-app-chat-thinking 1.1s ease-in-out infinite;
}

.rivet-web-app-chat-thinking span:nth-child(2) {
  animation-delay: 0.14s;
}

.rivet-web-app-chat-thinking span:nth-child(3) {
  animation-delay: 0.28s;
}

.rivet-web-app-chat-error {
  border-top: 1px solid var(--rivet-web-app-card-border);
  color: var(--rivet-web-app-error-color);
  padding: 10px 18px 0;
  font-size: 13px;
  font-weight: 600;
}

.rivet-web-app-chat-composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  border-top: 1px solid var(--rivet-web-app-card-border);
  padding: 14px;
}

.rivet-web-app-chat-error + .rivet-web-app-chat-composer {
  border-top: 0;
}

.rivet-web-app-chat-composer textarea {
  field-sizing: content;
  flex: 1;
  min-width: 0;
  min-height: 42px;
  max-height: 160px;
  border: 1px solid var(--rivet-web-app-control-border);
  border-radius: 12px;
  outline: none;
  background: var(--rivet-web-app-control-background);
  color: var(--rivet-web-app-foreground);
  font: inherit;
  line-height: 1.35;
  padding: 10px 12px;
  resize: none;
}

.rivet-web-app-chat-composer textarea:focus {
  border-color: color-mix(in srgb, var(--rivet-web-app-foreground) 34%, transparent);
}

.rivet-web-app-chat-send {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 50%;
  background: var(--rivet-web-app-button-background);
  color: var(--rivet-web-app-button-foreground);
  cursor: pointer;
  font: inherit;
  font-size: 21px;
  font-weight: 700;
  line-height: 1;
  padding: 0 0 2px;
}

.rivet-web-app-chat-send:disabled {
  cursor: default;
  opacity: 0.42;
}

@keyframes rivet-web-app-chat-thinking {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  30% {
    transform: translateY(-3px);
    opacity: 0.9;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rivet-web-app-chat-thinking span {
    animation: none;
  }
}

@media (max-width: 600px) {
  .rivet-web-app-root {
    --rivet-web-app-chat-min-height: clamp(320px, calc(100vh - 64px), 540px);
  }

  .rivet-web-app-chat {
    border-radius: 10px;
  }

  .rivet-web-app-chat-message {
    max-width: 90%;
  }
}

.rivet-web-app-output {
  display: grid;
  gap: 8px;
  position: relative;
}

.rivet-web-app-output-title {
  color: var(--rivet-web-app-output-title);
  font-weight: 700;
  padding-right: 32px;
}

.rivet-web-app-output-has-download .rivet-web-app-output-title {
  padding-right: 64px;
}

.rivet-web-app-output-action-button {
  position: absolute;
  top: 11px;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 68%, transparent);
  cursor: pointer;
  padding: 0;
}

.rivet-web-app-output-copy-button {
  right: 11px;
}

.rivet-web-app-output-download-button {
  right: 39px;
}

.rivet-web-app-output-copy-button::before,
.rivet-web-app-output-copy-button::after {
  content: "";
  position: absolute;
  width: 10px;
  height: 12px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}

.rivet-web-app-output-copy-button::before {
  top: 5px;
  left: 8px;
}

.rivet-web-app-output-copy-button::after {
  top: 8px;
  left: 5px;
  background: var(--rivet-web-app-card-background);
}

.rivet-web-app-output-download-button::before,
.rivet-web-app-output-download-button::after {
  content: "";
  position: absolute;
}

.rivet-web-app-output-download-button::before {
  top: 5px;
  left: 8px;
  width: 8px;
  height: 8px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
}

.rivet-web-app-output-download-button::after {
  top: 16px;
  left: 6px;
  width: 12px;
  height: 4px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  border-left: 1.5px solid currentColor;
  border-radius: 0 0 2px 2px;
}

.rivet-web-app-output-action-button:hover,
.rivet-web-app-output-action-button:focus-visible {
  color: var(--primary, #ff9e2c);
  outline: none;
  background: color-mix(in srgb, var(--rivet-web-app-foreground) 8%, transparent);
}

.rivet-web-app-output pre {
  margin: 0;
  background: transparent;
  border-radius: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: inherit;
  padding: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.rivet-web-app-markdown,
.rivet-web-app-output-markdown {
  word-break: break-word;
}

.rivet-web-app-markdown.markdown-body {
  background: transparent;
  font-family: inherit;
  min-width: 0;
}

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

.rivet-web-app-markdown.markdown-body code,
.rivet-web-app-output-markdown.markdown-body code {
  border-radius: 4px;
  background: color-mix(in srgb, var(--rivet-web-app-control-background) 70%, var(--rivet-web-app-foreground) 6%);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  padding: 1px 4px;
}

.rivet-web-app-markdown.markdown-body pre,
.rivet-web-app-output-markdown.markdown-body pre {
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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

.rivet-web-app-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.46);
  background: color-mix(in srgb, var(--rivet-web-app-background) 78%, transparent);
  padding: 20px;
}

.rivet-web-app-modal {
  display: grid;
  gap: 18px;
  width: min(420px, 100%);
  border: 1px solid var(--rivet-web-app-card-border);
  border-radius: 12px;
  background: var(--rivet-web-app-card-background);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.32);
  color: var(--rivet-web-app-foreground);
  padding: 22px;
}

.rivet-web-app-modal-message {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
}

.rivet-web-app-modal-button {
  justify-self: start;
}

.rivet-web-app-clipboard-fallback {
  position: fixed;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
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
