export const RIVET_WEB_APP_RENDERER_CSS = `
.rivet-web-app-root {
  --rivet-web-app-background: var(--grey-dark-colorish, #1c222b);
  --rivet-web-app-foreground: var(--foreground, #ffffff);
  --rivet-web-app-card-background: color-mix(in srgb, var(--modal-surface-bg, #252b34) 88%, var(--foreground, #ffffff) 4%);
  --rivet-web-app-card-border: var(--foldable-section-border, rgba(255, 255, 255, 0.04));
  --rivet-web-app-control-background: var(--form-control-bg, #20252d);
  --rivet-web-app-control-border: var(--form-control-border, rgba(255, 255, 255, 0.14));
  --rivet-web-app-button-radius: var(--rivet-web-app-host-button-radius, var(--ui-button-radius, 6px));
  --rivet-web-app-button-height: calc(32px * var(--ui-font-scale, 1));
  --rivet-web-app-button-background: var(--success, #3ba85b);
  --rivet-web-app-button-foreground: var(--grey-lightest, #ffffff);
  --rivet-web-app-output-title: var(--rivet-web-app-foreground, #ffffff);
  --rivet-web-app-error-color: var(--error, #ff6b5f);
  --rivet-web-app-font-size: var(--rivet-web-app-host-font-size, 15px);
  --rivet-web-app-chat-min-height: clamp(360px, calc(100vh - 136px), 540px);
  box-sizing: border-box;
  position: relative;
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

.rivet-web-app-toolbar {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 1;
}

.rivet-web-app-reset-button {
  position: relative;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 64%, transparent);
  cursor: pointer;
  padding: 0;
}

.rivet-web-app-reset-button::before {
  content: "↻";
  display: block;
  font-family: Arial, sans-serif;
  font-size: 23px;
  line-height: 28px;
}

.rivet-web-app-reset-button:hover,
.rivet-web-app-reset-button:focus-visible {
  background: color-mix(in srgb, var(--rivet-web-app-foreground) 8%, transparent);
  color: var(--primary, #ff9e2c);
  outline: none;
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
  height: 32px;
}

.rivet-web-app-gap-large {
  height: 96px;
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
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font: inherit;
  font-family: var(--font-family, Inter, system-ui, sans-serif);
  font-size: var(--ui-font-size-base, var(--rivet-web-app-font-size));
  height: var(--rivet-web-app-button-height);
  margin: 0;
  padding: 0.5rem 1rem;
  corner-shape: squircle;
}

.rivet-web-app-button:disabled {
  background: var(--rivet-web-app-button-background);
  color: var(--rivet-web-app-button-foreground);
  cursor: wait;
  opacity: 0.55;
}

.rivet-web-app-button:hover:not(:disabled) {
  background: var(--success-dark, #009624);
}

.rivet-web-app-running-indicator {
  box-sizing: border-box;
  color: currentColor;
  display: inline-block;
  width: calc(16px * var(--ui-font-scale, 1));
  height: calc(16px * var(--ui-font-scale, 1));
  border: calc(2px * var(--ui-font-scale, 1)) solid currentColor;
  border-right-color: transparent;
  border-bottom-color: transparent;
  border-radius: 50%;
  flex: 0 0 auto;
  pointer-events: none;
  animation: rivet-web-app-running-indicator-spin 0.8s linear infinite;
}

@keyframes rivet-web-app-running-indicator-spin {
  to {
    transform: rotate(360deg);
  }
}

.rivet-web-app-action-stack {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
}

.rivet-web-app-action-stack-running > .rivet-web-app-button,
.rivet-web-app-action-stack-running > .rivet-web-app-abort-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: var(--rivet-web-app-button-height);
  min-height: var(--rivet-web-app-button-height);
  padding: 0.5rem 1rem;
}

.rivet-web-app-action-stack-running > .rivet-web-app-button {
  gap: 8px;
  white-space: nowrap;
}

.rivet-web-app-action-stack .rivet-web-app-progress {
  flex: 0 0 100%;
}

.rivet-web-app-abort-button {
  flex: 0 0 auto;
  border: 1px solid var(--rivet-web-app-control-border);
  border-radius: var(--rivet-web-app-button-radius);
  background: transparent;
  color: var(--rivet-web-app-foreground);
  cursor: pointer;
  font: inherit;
  font-size: var(--ui-font-size-base, var(--rivet-web-app-font-size));
  padding: 6px 10px;
}

.rivet-web-app-abort-button:hover,
.rivet-web-app-abort-button:focus-visible {
  border-color: color-mix(in srgb, var(--rivet-web-app-foreground) 40%, transparent);
  outline: none;
}

.rivet-web-app-progress {
  display: grid;
  gap: 5px;
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 68%, transparent);
  font-size: 13px;
  min-width: 0;
}

.rivet-web-app-progress progress {
  width: min(320px, 100%);
  height: 6px;
  accent-color: var(--rivet-web-app-button-background);
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

.rivet-web-app-chat-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rivet-web-app-chat > .rivet-web-app-progress {
  border-top: 1px solid var(--rivet-web-app-card-border);
  padding: 10px 14px 0;
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
  opacity: 0.2;
  animation: rivet-web-app-chat-thinking 0.9s ease-in-out infinite;
}

.rivet-web-app-chat-thinking span:nth-child(2) {
  animation-delay: 0.13s;
}

.rivet-web-app-chat-thinking span:nth-child(3) {
  animation-delay: 0.26s;
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
  100% {
    opacity: 0.2;
    box-shadow: 0 0 0 transparent;
  }
  30% {
    opacity: 1;
    box-shadow: 0 0 6px currentColor;
  }
  55% {
    opacity: 0.2;
    box-shadow: 0 0 0 transparent;
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
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 48px;
  max-height: min(80vh, 800px);
  overflow: hidden;
  padding: 0;
}

.rivet-web-app-output-has-value:not(.rivet-web-app-output-collapsed) {
  resize: vertical;
}

.rivet-web-app-output-collapsed {
  height: auto !important;
  resize: none;
}

.rivet-web-app-output-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  border-radius: 9px;
  padding: 8px 18px;
}

button.rivet-web-app-output-header {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

button.rivet-web-app-output-header:hover,
button.rivet-web-app-output-header:focus-visible {
  outline: none;
  background: color-mix(in srgb, var(--rivet-web-app-foreground) 7%, transparent);
}

.rivet-web-app-output:not(.rivet-web-app-output-collapsed) .rivet-web-app-output-header {
  border-bottom: 1px solid var(--rivet-web-app-card-border);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.rivet-web-app-output-title {
  color: var(--rivet-web-app-output-title);
  flex: 1 1 auto;
  font-weight: 700;
  min-width: 0;
}

.rivet-web-app-output-toggle-icon {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 68%, transparent);
  transform: rotate(-135deg);
  transition: transform 120ms ease;
}

.rivet-web-app-output-toggle-icon.collapsed {
  transform: rotate(45deg);
}

.rivet-web-app-output-action-button {
  position: relative;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 68%, transparent);
  cursor: pointer;
  padding: 0;
}

.rivet-web-app-output-content {
  position: relative;
  min-height: 0;
  overflow: hidden;
  padding: 12px 0 16px 16px;
}

.rivet-web-app-output-content-actions {
  position: absolute;
  top: 10px;
  right: calc(10px + 1em);
  z-index: 1;
  display: flex;
  gap: 2px;
}

.rivet-web-app-output-content-body {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 0;
  scrollbar-gutter: stable;
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
  background: color-mix(in srgb, #000 48%, transparent);
}

.rivet-web-app-output-content-body pre {
  margin: 0;
  background: transparent;
  border-radius: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: inherit;
  padding: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.rivet-web-app-output-content-body pre.rivet-web-app-output-json {
  overflow-wrap: normal;
  word-break: break-all;
}

.rivet-web-app-output-image {
  display: block;
  width: auto;
  max-width: 100%;
  height: auto;
  max-height: min(70vh, 720px);
  margin: 0 auto;
  border-radius: 6px;
  object-fit: contain;
}

.rivet-web-app-output-image-placeholder {
  color: color-mix(in srgb, var(--rivet-web-app-foreground) 56%, transparent);
  font-size: 13px;
}

.rivet-web-app-output-image-placeholder:empty {
  display: none;
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
