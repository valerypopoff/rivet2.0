import { css } from '@emotion/react';

export const nodeStyles = css`
  .node {
    --node-card-radius: calc(20px * var(--ui-font-scale));
    --node-card-corner-shape: squircle;
    --node-output-min-height: 46px;
    --node-output-collapsed-max-height: calc(3 * 1.4em + 200px);
    --node-output-hover-max-height: calc(20 * 1.4em + 36px);
    --node-output-multi-collapsed-max-height: calc(3 * 1.4em + 60px);
    --node-output-multi-hover-max-height: calc(20 * 1.4em + 60px);
    background-color: var(--node-body-bg);
    background-clip: padding-box;
    border-radius: var(--node-card-radius);
    corner-shape: var(--node-card-corner-shape);
    /* border: 2px solid transparent; */
    box-shadow: var(--node-resting-shadow);
    display: flex;
    flex-direction: column;
    position: absolute;
    /* min-width: 300px; */
    /* max-width: 500px; */
    width: 450px;
    padding: 12px;
    font-family: var(--font-family-monospace);
    /* transition-duration: 0.2s; TODO */
    transition-timing-function: ease-out;
    transition-property: box-shadow;
    transform-origin: top left;
    contain: layout;
    isolation: isolate;
    pointer-events: auto;
  }

  @supports not (corner-shape: squircle) {
    .node {
      --node-card-radius: calc(10px * var(--ui-font-scale));
    }
  }

  .node:focus {
    outline: none;
  }

  .node:focus-visible:not(.selected):not(.hovered):not(.overlayNode) {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .node.changed-added {
    --node-frame-border-color: var(--success);
  }

  .node.changed {
    --node-frame-border-color: var(--warning);
  }

  .node.not-changed {
    opacity: 0.5;
  }

  .node.compare-added {
    --node-frame-border-color: var(--success);
    box-shadow:
      0 0 0 2px var(--success),
      var(--node-resting-shadow);
  }

  .node.compare-changed {
    --node-frame-border-color: var(--warning-light);
    box-shadow:
      0 0 0 2px var(--warning-light),
      var(--node-resting-shadow);
  }

  .node.compare-removed {
    --node-frame-border-color: var(--error);
    filter: grayscale(0.45);
    opacity: 0.58;
    pointer-events: none;
  }

  .node.compare-removed .node-title {
    background-image: repeating-linear-gradient(
      -45deg,
      color-mix(in srgb, var(--error) 22%, transparent) 0 8px,
      transparent 8px 16px
    );
  }

  .node.compare-removed .node-output,
  .node.compare-removed .node-resize-handles,
  .node.compare-removed .title-controls {
    display: none;
  }

  .node-skeleton {
    background: var(--node-skeleton-bg);
    height: 100px;
  }

  .node.isComment {
    background-color: var(--node-comment-bg);
    pointer-events: auto;
    padding: 0;
  }

  .node.isComment .node-body {
    pointer-events: auto;
  }

  .node.isComment .node-body * {
    pointer-events: none;
  }

  .node.zoomedOut {
    min-width: 200px;
  }

  .node.overlayNode {
    --node-frame-border-color: var(--primary);
    transition-duration: 0;
    pointer-events: none;
    box-shadow: var(--node-overlay-shadow);
  }

  .node.selected:not(.isComment) {
    --node-frame-border-color: var(--primary);
    z-index: 10000 !important;
  }

  /* Keep selected Comment nodes behind normal nodes so overlapping node headers stay grabbable. */
  .node.isComment.selected {
    --node-frame-border-color: var(--primary);
  }

  .node.hovered:not(.isComment) {
    --node-frame-border-color: var(--primary);
    z-index: 10001 !important;
  }

  .node.searchMatch:not(.selected):not(.hovered) {
    --node-frame-border-color: color-mix(in srgb, var(--primary) 55%, var(--node-border) 45%);
  }

  .node-border-overlay {
    position: absolute;
    inset: 0;
    border: 2px solid var(--node-frame-border-color, transparent);
    border-radius: inherit;
    corner-shape: inherit;
    pointer-events: none;
    z-index: 2;
    transition: border-color 0.2s ease-out;
  }

  .node.hasCustomBorderColor .node-border-overlay {
    border-color: var(--node-frame-border-color, var(--node-border));
  }

  .node.compare-added .node-border-overlay,
  .node.compare-changed .node-border-overlay {
    inset: -12px;
    border-width: 4px;
    border-radius: calc(var(--node-card-radius) + 12px);
  }

  .node.compare-added .node-border-overlay {
    border-color: var(--success);
  }

  .node.compare-changed .node-border-overlay {
    border-color: var(--warning-light);
  }

  .node-title {
    background-color: var(--node-bg);
    font-family: var(--font-family);
    color: var(--node-bg-foreground);
    padding: 14px 14px 12px 14px;
    margin: -12px -12px 8px -12px;
    border-radius: var(--node-card-radius) var(--node-card-radius) 0 0;
    corner-shape: var(--node-card-corner-shape);
    letter-spacing: 0.05em;
    display: flex;
    justify-content: space-between;
    position: relative;
    user-select: none;
    overflow: hidden;
    word-break: break-word;
    hyphens: auto;
    cursor: pointer;
  }

  .node-title.grabbable {
    cursor: grab;
  }

  .node-title.grabbable:active,
  .node.dragging .node-title.grabbable,
  .node.overlayNode .node-title.grabbable {
    cursor: grabbing;
  }

  .node.isSplit::before,
  .node.isSplit::after {
    content: '';
    position: absolute;
    border-radius: var(--node-card-radius) var(--node-card-radius) 0 0;
    corner-shape: var(--node-card-corner-shape);
    pointer-events: none;
  }

  .node.isSplit::before {
    top: calc(-11px * var(--ui-font-scale));
    height: calc(10px * var(--ui-font-scale));
    left: calc(8px * var(--ui-font-scale));
    right: calc(8px * var(--ui-font-scale));
    background: var(--node-bg);
    background: var(--node-stack-front-bg);
    opacity: var(--node-stack-front-opacity);
    z-index: -1;
  }

  .node.isSplit::after {
    top: calc(-20px * var(--ui-font-scale));
    height: calc(8px * var(--ui-font-scale));
    left: calc(17px * var(--ui-font-scale));
    right: calc(17px * var(--ui-font-scale));
    background: var(--node-bg);
    background: var(--node-stack-back-bg);
    opacity: var(--node-stack-back-opacity);
    z-index: -2;
  }

  .node.node.isComment .node-title {
    align-items: center;
    padding: calc(4px * var(--ui-font-scale)) calc(8px * var(--ui-font-scale));
    background-color: var(--node-comment-title-bg);
    pointer-events: auto;
    margin: 0;
  }

  .node.node.isComment .node-title * {
    pointer-events: auto;
  }

  .node.isComment .node-border-overlay {
    display: none;
  }

  .node.isComment.selected .node-border-overlay,
  .node.isComment.overlayNode .node-border-overlay,
  .node.isComment.searchMatch .node-border-overlay {
    display: block;
  }

  .node.isComment.overlayNode {
    box-shadow: none;
  }

  .node.isComment.overlayNode .node-title,
  .node.isComment.overlayNode .node-title *,
  .node.isComment.overlayNode .node-body,
  .node.isComment.overlayNode .node-body * {
    pointer-events: none;
  }

  .node.zoomedOut .node-title {
    padding: 24px;
    line-height: 35px;
  }

  .grab-area {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: -12px;
    margin-bottom: -12px;
    padding: 12px 0;
  }

  .node:not(.isComment) .grab-area {
    padding-right: var(--node-title-header-padding, calc(66px * var(--ui-font-scale)));
  }

  .node.hasHeaderWarning:not(.isComment) .grab-area {
    padding-right: calc(108px * var(--ui-font-scale));
  }

  .node.hasCompareChange:not(.isComment) .grab-area {
    padding-right: calc(108px * var(--ui-font-scale));
  }

  .node.hasHeaderWarning.hasCompareChange:not(.isComment) .grab-area {
    padding-right: calc(138px * var(--ui-font-scale));
  }

  .split-run-mode-icon {
    flex: 0 0 auto;
    width: calc(16px * var(--ui-font-scale));
    height: calc(16px * var(--ui-font-scale));
  }

  .split-run-mode-icon-sequential {
    width: calc(20px * var(--ui-font-scale));
  }

  .subgraph-link-button {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--node-bg-foreground);
    cursor: pointer;
    transition: color 0.2s ease-out;

    svg {
      position: absolute;
      left: calc(12px * var(--ui-font-scale));
      top: calc(12px * var(--ui-font-scale));
      width: 20px;
      height: 20px;
    }
  }

  .subgraph-link-button:hover {
    color: var(--primary-text);
  }

  .subgraph-link-tooltip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: stretch;
    width: calc(41px * var(--ui-font-scale));
    margin: 0;
    z-index: 4;
  }

  .grab-area.has-subgraph-header-link {
    padding-left: calc(27px * var(--ui-font-scale));
  }

  .title-text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 3px;
    min-width: 0;
  }

  .title-text-label {
    min-width: 0;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
    font-weight: bold;
    font-size: var(--ui-font-size-base);
    text-transform: uppercase;
  }

  .global-node-title-icon,
  .knowledge-node-title-icon {
    display: inline-block;
    width: 1em;
    height: 1em;
    margin-right: 0.35em;
    vertical-align: -0.14em;
    color: currentColor;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .title-text-label .tool-call-continuation-tooltip {
    display: inline-flex;
    margin-right: 0.35em;
    pointer-events: auto;
    vertical-align: -0.14em;
  }

  .title-text-label .tool-call-continuation-indicator {
    align-items: center;
    color: currentColor;
    cursor: help;
    display: inline-flex;
    height: 1em;
    justify-content: center;
    width: 1em;

    svg {
      height: 1em;
      width: 1em;
    }
  }

  .node .node-title .title-text-description {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: currentColor;
    font-size: var(--ui-font-size-xs);
    font-weight: 300;
    line-height: 1.25;
    letter-spacing: 0;
    opacity: 0.72;
    overflow-wrap: anywhere;
    text-transform: none;
  }

  .split-run-summary-tooltip {
    display: inline-flex;
  }

  .split-run-summary {
    display: flex;
    align-items: center;
    gap: calc(6px * var(--ui-font-scale));
    min-height: calc(24px * var(--ui-font-scale));
    padding: 0.2em 0.6em 0.1em 0.4em;
    border: 0;
    border-radius: 0.8em;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 0.4em;
    }
    background: color-mix(in srgb, var(--node-bg-foreground) 85%, transparent);
    color: var(--node-bg);
    cursor: pointer;
    width: max-content;
    white-space: nowrap;
    font-family: inherit;
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
    line-height: 1.3;
    text-transform: none;
    margin-top: calc(6px * var(--ui-font-scale));
    margin-left: -0.1em;
  }

  .split-run-summary svg {
    margin-bottom: 0.1em;
  }

  .split-run-summary-mode {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: calc(1px * var(--ui-font-scale));
  }

  .split-run-summary:hover {
    background: var(--primary);
    color: black;
  }

  .node.isComment .title-text {
    display: none;
  }

  .node.isComment .title-controls {
    align-items: center;
    flex: 0 0 calc(66px * var(--ui-font-scale));
    margin-right: 0;
    margin-top: 0;
    min-height: calc(30px * var(--ui-font-scale));
    width: calc(66px * var(--ui-font-scale));

    .changed-button,
    .edit-button {
      height: calc(30px * var(--ui-font-scale));
      margin: 0;
    }
  }

  .node.zoomedOut .title-text-label {
    font-size: calc(var(--ui-font-size-xl) * 1.25);
  }

  .node.zoomedOut .title-text-description {
    font-size: var(--ui-font-size-compact);
  }

  .title-controls {
    display: flex;
    align-items: flex-start;
    gap: calc(6px * var(--ui-font-scale));
    justify-content: flex-end;
    min-height: calc(22px * var(--ui-font-scale));
    margin-right: calc(-8px * var(--ui-font-scale));
    margin-top: -0.2em;
    flex: 0 0 66px;
    width: calc(66px * var(--ui-font-scale));
    position: relative;
    pointer-events: none;

    .changed-button,
    .edit-button,
    .node-prefab-instance-indicator,
    .node-header-warning {
      background-color: transparent;
      border: none;
      color: var(--node-bg-foreground);
      cursor: pointer;
      font-size: calc(var(--ui-font-size-base) * 1.2857142857);
      transition: color 0.2s ease-out;
      margin: calc(-12px * var(--ui-font-scale)) 0;
      width: calc(30px * var(--ui-font-scale));
      height: calc(46px * var(--ui-font-scale));
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;

      svg {
        width: calc(18px * var(--ui-font-scale));
        height: calc(18px * var(--ui-font-scale));
      }
    }

    .node-header-warning {
      cursor: help;
      pointer-events: auto;
      width: calc(20px * var(--ui-font-scale));
    }

    .node-prefab-instance-indicator {
      cursor: pointer;
      pointer-events: auto;
      width: calc(26px * var(--ui-font-scale));
    }

    .changed-button:hover {
      color: var(--primary-text);
    }

    .node-prefab-instance-indicator:hover {
      color: var(--primary-text);
    }

    .edit-button:hover {
      color: var(--node-bg-foreground);
    }
  }

  .node:not(.isComment) .title-controls {
    flex: none;
    margin-right: 0;
    position: absolute;
    right: 6px;
    top: 14px;
    z-index: 4;
  }

  .node.hasHeaderWarning:not(.isComment) .title-controls {
    gap: calc(3px * var(--ui-font-scale));
    min-width: calc(66px * var(--ui-font-scale));
    width: max-content;
  }

  .node.hasPrefabIndicator:not(.isComment) .title-controls {
    gap: calc(3px * var(--ui-font-scale));
    min-width: calc(66px * var(--ui-font-scale));
    width: max-content;
  }

  .node.hasCompareChange:not(.isComment) .title-controls {
    min-width: calc(66px * var(--ui-font-scale));
    width: max-content;
  }

  .node.hasHeaderWarning:not(.isComment):not(:hover):not(.hovered):not(.showHoverControls):not(:focus-within)
    .title-controls {
    right: calc(11px * var(--ui-font-scale));
  }

  .title-controls .node-running-indicator {
    color: var(--node-bg-foreground);
    margin-top: calc(3px * var(--ui-font-scale));
  }

  .node:not(:hover):not(.hovered):not(:focus-within) .title-controls .node-running-indicator {
    margin-right: 8px;
  }

  .title-controls > :not(.node-running-indicator) {
    pointer-events: auto;
  }

  .title-controls .tooltip {
    display: flex;
    align-items: center;
  }

  .title-controls .node-header-warning-tooltip {
    position: static;
    opacity: 1;
    pointer-events: auto;
  }

  .title-controls .node-prefab-instance-tooltip {
    position: static;
    opacity: 1;
    pointer-events: auto;
  }

  .title-controls .edit-button-tooltip,
  .title-controls > .edit-button {
    opacity: 0;
    position: absolute;
    right: 0;
    pointer-events: none;
  }

  .title-controls .edit-button {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease-out;
  }

  .node:is(:hover, .hovered, .showHoverControls, :focus-within)
    .title-controls
    :is(.edit-button, .edit-button-tooltip) {
    opacity: 1;
    position: static;
    pointer-events: auto;
  }

  .node.zoomedOut .title-controls {
    position: absolute;
    right: 10px;
    top: 10px;
  }

  .node-body {
    color: var(--foreground);
    font-family: inherit;
    font-size: var(--ui-font-size-sm);
    margin-bottom: 12px;
    line-height: 1.4;
  }

  .node-body:empty {
    margin-bottom: 0;
  }

  .node-body-readonly {
    pointer-events: none;
  }

  .node-body pre {
    font-family: inherit;
  }

  .node.isComment .node-body {
    border-radius: 0 0 var(--node-card-radius) var(--node-card-radius);
    corner-shape: var(--node-card-corner-shape);
    flex: 1;
    height: auto;
    margin-bottom: 0;
    min-height: 0;
    overflow: hidden;
  }

  .node.isComment .node-body > * {
    border-radius: inherit;
    corner-shape: inherit;
  }

  .node-title-ports {
    position: absolute;
    left: 12px;
    top: 16px;
    display: flex;
    justify-content: space-between;
    margin: 0 0 0 -12px;
    z-index: 3;
  }

  .node-title-ports.conditional-if-port {
    pointer-events: none;
  }

  .node-title-ports.conditional-if-port .port {
    pointer-events: auto;
  }

  .conditional-if-port-label {
    color: var(--node-port-label-color);
    font-size: var(--ui-font-size-2xs);
    left: -32px;
    line-height: 16px;
    opacity: 0.5;
    padding: 0 3px;
    pointer-events: none;
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    user-select: none;
    white-space: nowrap;
    z-index: 4;
  }

  .conditional-if-port-label.connected {
    background: color-mix(in srgb, var(--canvas-background-color, var(--grey-darker)) 82%, transparent);
    border-radius: calc(4px * var(--ui-font-scale));
    color: var(--port-connected-label-color);
    opacity: var(--port-connected-label-opacity);
  }

  .node.selected .conditional-if-port-label.connected,
  .node.overlayNode .conditional-if-port-label.connected,
  .node.hovered .conditional-if-port-label.connected {
    opacity: 1;
  }

  .node-ports {
    display: flex;
    justify-content: space-between;
    margin: 0 -12px 0 -12px;
    position: relative;
    z-index: 3;
  }

  .node-ports-groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .node-ports-group {
    display: flex;
    flex-direction: column;
    gap: 8px;

    > header {
      background: var(--node-bg);
      color: var(--node-bg-foreground);
      align-self: flex-start;
      padding: 4px 8px;
      margin-left: -12px;
      font-size: var(--ui-font-size-sm);
      font-family: inherit;
      border-radius: 0 8px 8px 0;
      corner-shape: squircle;
      @supports not (corner-shape: squircle) {
        border-radius: 0 4px 4px 0;
      }
      user-select: none;
    }
  }

  .input-ports,
  .output-ports {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  /* Regex Match exposes Test and a Values group label before its paired
   * Per-output inputs. Keep the case outputs on those paired input rows. */
  .node-ports.match-per-output-values .output-ports {
    padding-top: 52px;
  }

  .regex-match-values-label {
    color: var(--node-port-label-color);
    font-size: var(--ui-font-size-2xs);
    line-height: 16px;
    margin: 4px 4px 0 12px;
    opacity: 0.5;
    pointer-events: none;
    user-select: none;
  }

  .regex-match-value-connection-guides {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
  }

  .regex-match-value-connection-guide {
    position: absolute;
    border-top: 1px dotted color-mix(in srgb, var(--node-port-border) 62%, transparent);
    transform: translateY(-50%);
  }

  .input-ports .port {
    flex-direction: row;
    justify-content: flex-start;
  }

  .output-ports .port {
    flex-direction: row-reverse;
    justify-content: flex-start;
  }

  .port {
    display: flex;
    align-items: center;
    position: relative;
    z-index: 3;
  }

  .port-label-uppercase {
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .port-label {
    color: var(--node-port-label-color);
    font-size: var(--ui-font-size-2xs);
    line-height: 16px;
    margin: 0 4px;
    white-space: nowrap;
    user-select: none;
    opacity: 0.5;
    cursor: default;
  }

  .port.reorderable .port-label {
    background: var(--node-port-reorder-label-bg);
    border: 1px solid var(--node-port-reorder-label-border);
    border-radius: calc(6px * var(--ui-font-scale));
    color: var(--node-port-reorder-label-color);
    cursor: grab;
    opacity: 1;
    padding: 2px 6px;
    corner-shape: squircle;

    @supports not (corner-shape: squircle) {
      border-radius: calc(4px * var(--ui-font-scale));
    }
  }

  .port.reorderable .port-label:active {
    cursor: grabbing;
  }

  .port.reorder-dragging-source .port-label {
    visibility: hidden;
  }

  body.port-reorder-dragging,
  body.port-reorder-dragging * {
    cursor: grabbing !important;
    user-select: none !important;
  }

  .node.zoomedOut .port-label {
    display: none;
  }

  .node.selected .port-label,
  .node.overlayNode .port-label,
  .port-label:hover {
    opacity: 1;
  }

  .node.zoomedOut .port:hover .port-label {
    display: block;
    font-size: var(--ui-font-size-xl);
    line-height: 12px;
  }

  .input-port {
    margin-left: -8px;
  }

  .output-port {
    margin-right: -8px;
  }

  .port-circle {
    position: relative;
  }

  .data-bus-antenna {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 24px;
    height: 24px;
    overflow: visible;
    pointer-events: none;
    transform: translateY(-50%);
    z-index: 0;

    path {
      fill: none;
      stroke: var(--node-port-border);
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
  }

  .input-port .data-bus-antenna {
    right: 50%;
    left: auto;
  }

  .port:hover .data-bus-antenna path {
    stroke: var(--primary);
  }

  .data-bus-antenna-count {
    position: absolute;
    left: 19px;
    bottom: 10px;
    min-width: 13px;
    height: 13px;
    padding: 0 3px;
    box-sizing: border-box;
    border-radius: 7px;
    background: var(--primary);
    color: var(--foreground-on-primary);
    font-family: var(--font-family);
    font-size: 9px;
    font-weight: 700;
    line-height: 13px;
    text-align: center;
    pointer-events: none;
  }

  .input-port .data-bus-antenna-count {
    right: 19px;
    left: auto;
  }

  .input-port,
  .output-port {
    background-color: var(--node-port-bg);
    border: 2px solid var(--node-port-border);
    border-radius: 50%;
    height: 16px;
    width: 16px;
    transition: all 0.2s ease-in-out;
  }

  .input-port:hover,
  .output-port:hover {
    border-color: var(--primary);
    cursor: pointer;
  }

  .input-ports .port-label {
    text-align: left;
    position: static;
  }

  .output-ports .port-label {
    text-align: right;
    position: static;
  }

  .node.zoomedOut .input-ports .port-label {
    text-align: right;
    position: absolute;
    right: calc(100% + 8px);
  }

  .node.zoomedOut .output-ports .port-label {
    text-align: left;
    position: absolute;
    left: calc(100% + 8px);
  }

  .port.connected .port-circle,
  .port.closest .port-circle {
    background-color: var(--primary);
    border: 2px solid var(--primary-dark);
  }

  .port.compatible:not(.connected) .port-circle {
    border: 2px solid var(--success);
  }

  .port.coerced .port-circle {
    border: 2px solid var(--warning);
  }

  .port.incompatible .port-circle {
    border: 2px solid var(--error);
  }

  .port.connected .port-label {
    color: var(--port-connected-label-color);
    opacity: var(--port-connected-label-opacity);
  }

  .node.selected .port.connected .port-label,
  .node.overlayNode .port.connected .port-label,
  .port.connected .port-label:hover {
    opacity: 1;
  }

  .node-output {
    position: relative;
    z-index: 0;
  }

  .node.isComment .node-output {
    display: none;
  }

  .node-output-inner,
  .multi-node-output {
    /*
     * Inline output action controls:
     * - actions-gap is the baseline spacing between every action
     * - each *-margin-left/right value independently adds/subtracts space for
     *   that action without replacing the baseline gap
     * - actions-* otherwise moves/sizes the visible button group
     * - action-exclusion-* reserves text-wrapping space at that group position
     * - *-icon-size and *-icon-offset-* tune each SVG without changing hit targets
     */
    --node-output-actions-top: 3px;
    --node-output-actions-right: 4px;
    --node-output-actions-gap: calc(5px * var(--ui-font-scale));
    --node-output-action-hit-size: calc(24px * var(--ui-font-scale));
    --node-output-surface-padding: 12px;
    --node-output-action-exclusion-width: calc(88px * var(--ui-font-scale));
    --node-output-action-exclusion-height: var(--node-output-action-hit-size);
    --node-output-action-exclusion-top: calc(var(--node-output-actions-top) - var(--node-output-surface-padding));
    --node-output-action-exclusion-right: var(--node-output-actions-right);
    --node-output-action-exclusion-left-gap: 0;
    --node-output-action-icon-size: 80%;
    --node-output-action-icon-offset-x: 0px;
    --node-output-action-icon-offset-y: 0px;
    --node-output-unfold-icon-size: var(--node-output-action-icon-size);
    --node-output-unfold-icon-offset-x: var(--node-output-action-icon-offset-x);
    --node-output-unfold-icon-offset-y: 0.03em;
    --node-output-unfold-margin-left: 0px;
    --node-output-unfold-margin-right: 0px;
    --node-output-copy-icon-size: calc(var(--node-output-action-icon-size) * 0.9);
    --node-output-copy-icon-offset-x: 0.06em;
    --node-output-copy-icon-offset-y: var(--node-output-action-icon-offset-y);
    --node-output-copy-margin-left: 0px;
    --node-output-copy-margin-right: 0px;
    --node-output-response-inspector-icon-size: var(--node-output-action-icon-size);
    --node-output-response-inspector-icon-offset-x: var(--node-output-action-icon-offset-x);
    --node-output-response-inspector-icon-offset-y: var(--node-output-action-icon-offset-y);
    --node-output-response-inspector-margin-left: calc(3.5px * var(--ui-font-scale));
    --node-output-response-inspector-margin-right: calc(-2px * var(--ui-font-scale));
    --node-output-prompt-designer-icon-size: var(--node-output-action-icon-size);
    --node-output-prompt-designer-icon-offset-x: var(--node-output-action-icon-offset-x);
    --node-output-prompt-designer-icon-offset-y: var(--node-output-action-icon-offset-y);
    --node-output-prompt-designer-margin-left: 0px;
    --node-output-prompt-designer-margin-right: 0px;
    --node-output-fullscreen-icon-size: calc(var(--node-output-action-icon-size) * 0.85);
    --node-output-fullscreen-icon-offset-x: var(--node-output-action-icon-offset-x);
    --node-output-fullscreen-icon-offset-y: var(--node-output-action-icon-offset-y);
    --node-output-fullscreen-margin-left: 0px;
    --node-output-fullscreen-margin-right: 0px;

    background-color: var(--node-output-surface-bg);
    border-radius: 0 0 var(--node-card-radius) var(--node-card-radius);
    corner-shape: var(--node-card-corner-shape);
    border-top: 2px solid var(--node-output-success-border);
    color: var(--foreground);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    margin: 8px -12px -12px -12px;
    min-height: var(--node-output-min-height);
    padding: var(--node-output-surface-padding);
    position: relative;
    transition: border-color 0.2s ease-out;
    transition: max-height 0.2s ease-out;
    overflow: hidden;
  }

  .node-output-inner {
    max-height: var(--node-output-collapsed-max-height);
  }

  .node-output-inner.has-extra-output-action {
    --node-output-action-exclusion-width: calc(120px * var(--ui-font-scale));
  }

  .multi-node-output {
    padding: 0;
    margin-bottom: -8px;
    max-height: var(--node-output-multi-collapsed-max-height);
  }

  .node-output-warnings {
    background-color: var(--node-output-warning-bg-start);
    background-image: linear-gradient(
      to bottom,
      var(--node-output-warning-bg-start) 0%,
      var(--node-output-warning-bg-end) 100%
    );
    border-radius: 0 0 var(--node-card-radius) var(--node-card-radius);
    corner-shape: var(--node-card-corner-shape);
    border-top: 2px solid var(--warning-light);
    color: var(--foreground-bright);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    margin: -2px -12px -12px -12px;
    padding: 12px;
    position: relative;
    transition: border-color 0.2s ease-out;
    margin-top: 8px;
    max-height: var(--node-output-collapsed-max-height);
    transition: max-height 0.2s ease-out;
    overflow: hidden;
  }

  .node-output-error-message {
    color: var(--error-light);
    margin-bottom: 12px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .node.running .node-output:not(.multi) .node-output-inner,
  .node.running .multi-node-output {
    border-top-color: var(--primary);
  }

  .node.error,
  .node.interrupted {
    --node-output-status-bg: var(--node-output-error-bg);
    --node-output-status-border: var(--node-output-error-border);
  }

  .node.success .node-output:not(.multi) .node-output-inner,
  .node.success .multi-node-output {
    border-top-color: var(--node-output-success-border);
  }

  .node.frozen.success:not(.running) .node-output:not(.multi) .node-output-inner,
  .node.frozen.success:not(.running) .multi-node-output {
    background-color: var(--node-frozen-output-bg);
    border-top-color: var(--node-frozen-output-accent);
  }

  .frozen-output-notice {
    align-items: center;
    color: var(--node-frozen-output-accent);
    display: flex;
    font-family: var(--font-family);
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
    gap: 6px;
    letter-spacing: 0.08em;
    line-height: 1.2;
    margin-bottom: 10px;
    min-height: 18px;
    padding-right: 96px;
    position: relative;
    text-transform: uppercase;
    z-index: 2;

    svg {
      flex: 0 0 auto;
      height: 15px;
      transform: translateY(-1px);
      width: 15px;
    }
  }

  .node-output-content-fade {
    position: relative;
    z-index: 2;
  }

  .node-output-inner.has-output-actions .node-output-content-fade::before {
    content: '';
    float: right;
    width: var(--node-output-action-exclusion-width);
    height: var(--node-output-action-exclusion-height);
    margin-top: var(--node-output-action-exclusion-top);
    margin-right: var(--node-output-action-exclusion-right);
    margin-left: var(--node-output-action-exclusion-left-gap);
    pointer-events: none;
  }

  .node.frozen.success:not(.running) .node-output:not(.multi) .node-output-inner::after,
  .node.frozen.success:not(.running) .multi-node-output::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 120px;
    z-index: 1;
    pointer-events: none;
    background: linear-gradient(to bottom, rgba(109, 213, 255, 0.1) 0%, rgba(109, 213, 255, 0) 100%);
    -webkit-mask-image: linear-gradient(-60deg, transparent 0 38%, #000 38%);
    mask-image: linear-gradient(-60deg, transparent 0 38%, #000 38%);
    -webkit-mask-repeat: no-repeat;
    mask-repeat: no-repeat;
  }

  .node.error .node-output:not(.multi) .node-output-inner,
  .node.interrupted .node-output:not(.multi) .node-output-inner,
  .node.error .multi-node-output,
  .node.interrupted .multi-node-output {
    background-color: var(--node-output-status-bg);
    background-image: none;
    border-top-color: var(--node-output-status-border);
  }

  .node.not-ran .node-output:not(.multi) .node-output-inner,
  .node.not-ran .multi-node-output {
    border-top-style: dashed;
    border-top-color: var(--node-output-not-ran-border);
  }

  .node-output.multi .node-output-inner.node-output-inner {
    border-top: 1px solid var(--node-output-multi-border);
  }

  .node:is(:hover, .hovered, .showHoverControls) .node-output-inner,
  .node:is(:hover, .hovered, .showHoverControls) .node-output-warnings {
    max-height: var(--node-output-hover-max-height);
  }

  .node:is(:hover, .hovered, .showHoverControls) .multi-node-output {
    max-height: var(--node-output-multi-hover-max-height);
  }

  .node.isOutputExpanded .node-output-inner {
    max-height: unset;
    overflow: auto;
  }

  .node.isOutputExpanded .multi-node-output {
    max-height: unset;
    overflow: visible;
  }

  .node .node-output.errored:not(.multi) {
    border-top: 2px solid var(--error-light);
  }

  .node-output.multi:before {
    top: 2px;
  }

  .node-output:before {
    content: '';
    position: absolute;
    top: 1px;
    left: 50%;
    z-index: 2;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 8px solid var(--node-output-success-border);
  }

  .node.success .node-output:before {
    border-top-color: var(--node-output-success-border);
  }

  .node.frozen.success:not(.running) .node-output:before {
    border-top-color: var(--node-frozen-output-accent);
  }

  .node.error .node-output:before,
  .node.interrupted .node-output:before {
    border-top-color: var(--node-output-status-border);
  }

  .node.not-ran .node-output:before {
    border-top-color: var(--node-output-not-ran-border);
  }

  .node-output.errored:before {
    border-top: 8px solid var(--error-light);
  }

  .node.running .node-output:before {
    border-top-color: var(--primary);
  }

  .overlay-buttons {
    position: absolute;
    top: var(--node-output-actions-top);
    right: var(--node-output-actions-right);
    display: flex;
    gap: var(--node-output-actions-gap);
    z-index: 10;
  }

  .copy-button,
  .expand-button,
  .output-toggle-button,
  .response-inspector-button,
  .prompt-designer-button {
    width: var(--node-output-action-hit-size);
    height: var(--node-output-action-hit-size);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--ui-font-size-2xl);
    opacity: var(--node-output-action-opacity);
    cursor: pointer;
    transition:
      opacity 0.2s,
      background-color 0.2s,
      box-shadow 0.2s;
    z-index: 1;
  }

  .node:is(:hover, .hovered, .showHoverControls) .copy-button,
  .node:is(:hover, .hovered, .showHoverControls) .expand-button,
  .node:is(:hover, .hovered, .showHoverControls) .output-toggle-button,
  .node:is(:hover, .hovered, .showHoverControls) .response-inspector-button,
  .node:is(:hover, .hovered, .showHoverControls) .prompt-designer-button {
    opacity: var(--node-output-action-node-hover-opacity);
  }

  .node .copy-button:hover,
  .node .expand-button:hover,
  .node .output-toggle-button:hover,
  .node .response-inspector-button:hover,
  .node .prompt-designer-button:hover {
    opacity: 1;
  }

  .output-toggle-button {
    margin-left: var(--node-output-unfold-margin-left);
    margin-right: var(--node-output-unfold-margin-right);
  }

  .copy-button {
    margin-left: var(--node-output-copy-margin-left);
    margin-right: var(--node-output-copy-margin-right);
  }

  .response-inspector-button {
    margin-left: var(--node-output-response-inspector-margin-left);
    margin-right: var(--node-output-response-inspector-margin-right);
  }

  .prompt-designer-button {
    margin-left: var(--node-output-prompt-designer-margin-left);
    margin-right: var(--node-output-prompt-designer-margin-right);
  }

  .expand-button {
    margin-left: var(--node-output-fullscreen-margin-left);
    margin-right: var(--node-output-fullscreen-margin-right);
  }

  .output-toggle-button svg {
    width: var(--node-output-unfold-icon-size);
    height: var(--node-output-unfold-icon-size);
    transform: translate(var(--node-output-unfold-icon-offset-x), var(--node-output-unfold-icon-offset-y));
  }

  .copy-button svg {
    width: var(--node-output-copy-icon-size);
    height: var(--node-output-copy-icon-size);
    transform: translate(var(--node-output-copy-icon-offset-x), var(--node-output-copy-icon-offset-y));
  }

  .response-inspector-button svg {
    width: var(--node-output-response-inspector-icon-size);
    height: var(--node-output-response-inspector-icon-size);
    transform: translate(
      var(--node-output-response-inspector-icon-offset-x),
      var(--node-output-response-inspector-icon-offset-y)
    );
  }

  .prompt-designer-button svg {
    width: var(--node-output-prompt-designer-icon-size);
    height: var(--node-output-prompt-designer-icon-size);
    transform: translate(
      var(--node-output-prompt-designer-icon-offset-x),
      var(--node-output-prompt-designer-icon-offset-y)
    );
  }

  .expand-button svg {
    width: var(--node-output-fullscreen-icon-size);
    height: var(--node-output-fullscreen-icon-size);
    transform: translate(var(--node-output-fullscreen-icon-offset-x), var(--node-output-fullscreen-icon-offset-y));
  }

  .node.isOutputExpanded .output-toggle-button {
    opacity: 1;
    background-color: transparent;
    box-shadow: none;
    color: var(--primary);
  }

  .node .running {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .node-resize-handles {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
  }

  .resize-handle {
    position: absolute;
    background: transparent;
    pointer-events: auto;
    touch-action: none;
  }

  .resize-handle-left,
  .resize-handle-right {
    top: 0;
    bottom: 0;
    width: 12px;
  }

  .resize-handle-left {
    left: -8px;
    cursor: var(--resize-edge-horizontal-cursor);
  }

  .resize-handle-right {
    right: -8px;
    cursor: var(--resize-edge-horizontal-cursor);
  }

  .resize-handle-top,
  .resize-handle-bottom {
    left: 0;
    right: 0;
    height: 12px;
  }

  .resize-handle-top {
    top: -8px;
    cursor: var(--resize-edge-vertical-cursor);
  }

  .resize-handle-bottom {
    bottom: -8px;
    cursor: var(--resize-edge-vertical-cursor);
  }

  .resize-handle-top-left,
  .resize-handle-top-right,
  .resize-handle-bottom-left,
  .resize-handle-bottom-right {
    width: 18px;
    height: 18px;
    z-index: 1;
  }

  .resize-handle-top-left {
    top: -9px;
    left: -9px;
    cursor: var(--resize-edge-diagonal-down-cursor);
  }

  .resize-handle-top-right {
    top: -9px;
    right: -9px;
    cursor: var(--resize-edge-diagonal-up-cursor);
  }

  .resize-handle-bottom-left {
    bottom: -9px;
    left: -9px;
    cursor: var(--resize-edge-diagonal-up-cursor);
  }

  .resize-handle-bottom-right {
    right: -9px;
    bottom: -9px;
    cursor: var(--resize-edge-diagonal-down-cursor);
  }

  .node.isComment .resize-handle {
    pointer-events: auto;
  }

  .node.runningGlow {
    box-shadow:
      0 0 16px var(--shadow-primary-bright),
      0 8px 16px rgba(0, 0, 0, 0.4);
  }

  .split-output {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .picker {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--node-output-picker-border);
    user-select: none;
    height: 32px;

    .picker-left,
    .picker-right {
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      cursor: pointer;
      border: 0;
      margin: 0;
      padding: 0;
      width: 32px;
      height: 32px;

      &:hover {
        background: var(--node-output-picker-hover-bg);
      }
    }

    .picker-left {
      border-right: 1px solid var(--node-output-picker-border);
    }

    .picker-right {
      border-left: 1px solid var(--node-output-picker-border);
    }
  }

  .multi-node-output-inner {
    padding: 12px;
  }

  .port-hover-area {
    width: 100px;
    height: 100px;
    border-radius: 50%;
    position: absolute;
    left: 8px;
    top: 8px;
    transform: translate(-50%, -50%);
    /* background-color: rgba(1, 1, 1, 0.5); */
  }

  .node-output .function-call,
  .node-output .function-calls {
    h4 {
      margin-top: 0;
      margin-bottom: 0;
      text-decoration: none;
      font-size: var(--ui-font-size-sm);
      font-weight: normal;
      color: var(--primary-text);
    }
  }

  .node.disabled {
    opacity: 0.5;

    .node-title {
      text-decoration: line-through;
    }
  }
`;
