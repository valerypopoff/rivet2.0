import { css } from '@emotion/react';
import { DATA_BUS_FULL_ROW_HEIGHT_PX } from './dataBusRailLayout.js';

export const dataBusRailStyles = css`
  position: absolute;
  top: calc(46px * var(--ui-font-scale, 1));
  right: 0;
  left: var(--data-bus-full-row-left, 0px);
  z-index: 10002;
  display: flex;
  align-items: center;
  gap: calc(6px * var(--ui-font-scale, 1));
  box-sizing: border-box;
  width: max-content;
  max-width: calc(100% - var(--data-bus-full-row-left, 0px) - 32px);
  margin: 0 auto;
  padding: 0 calc(6px * var(--ui-font-scale, 1));
  overflow-x: auto;
  overflow-y: hidden;
  pointer-events: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  &.full-row {
    position: fixed;
    top: var(--project-selector-height);
    right: 0;
    left: var(--data-bus-full-row-left, 0px);
    box-sizing: border-box;
    width: auto;
    height: var(--data-bus-full-row-height, 0px);
    max-width: none;
    margin: 0;
    flex-direction: column;
    align-items: stretch;
    justify-content: flex-start;
    gap: 0;
    padding: 0;
    overflow: hidden;
    transform: none;
    background: transparent;
  }

  .data-bus-group {
    position: relative;
    display: flex;
    align-items: stretch;
    flex: 0 0 auto;
    min-width: 0;
    max-width: min(70vw, calc(760px * var(--ui-font-scale, 1)));
    overflow: hidden;
    border: 1px solid var(--app-panel-border, var(--grey));
    border-radius: calc(7px * var(--ui-font-scale, 1));
    background: var(--app-panel-bg, var(--grey-darkest));
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24);
    color: var(--foreground);
  }

  &.full-row .data-bus-group {
    flex: 0 0 calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    width: 100%;
    height: calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    max-width: none;
    overflow: hidden;
    border: 0;
    border-bottom: 1px solid var(--app-panel-border, var(--grey));
    border-radius: 0;
    background: var(--app-panel-bg, var(--grey-darkest));
    box-shadow: none;
  }

  .data-bus-group-content {
    display: flex;
    align-items: stretch;
    flex: 1 1 auto;
    min-width: 0;
    margin-left: calc(3px * var(--ui-font-scale, 1));
    overflow: hidden;
  }

  &.full-row .data-bus-group-content {
    flex: 0 1 auto;
    width: max-content;
    max-width: calc(100% - 32px * var(--ui-font-scale, 1));
    height: 100%;
    margin: 0 auto;
  }

  &.full-row .data-bus-group.selected,
  &.full-row .data-bus-group.search-match:not(.selected),
  &.full-row .data-bus-group.compare-added,
  &.full-row .data-bus-group.compare-changed {
    border-color: transparent;
    box-shadow: none;
  }

  &.full-row .data-bus-group.selected {
    box-shadow: inset 0 -2px var(--primary);
  }

  &.full-row .data-bus-group.search-match:not(.selected) {
    box-shadow: inset 0 -1px color-mix(in srgb, var(--primary) 65%, transparent);
  }

  &.full-row .data-bus-group.compare-added:not(.selected) {
    box-shadow: inset 0 -2px var(--success);
  }

  &.full-row .data-bus-group.compare-changed:not(.selected) {
    box-shadow: inset 0 -2px var(--warning-light);
  }

  .data-bus-group::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: calc(3px * var(--ui-font-scale, 1));
    background: var(--bus-accent);
  }

  .data-bus-group.selected {
    border-color: var(--primary);
    box-shadow:
      0 0 0 1px var(--primary),
      0 2px 8px rgba(0, 0, 0, 0.24);
  }

  .data-bus-group.search-match:not(.selected) {
    border-color: color-mix(in srgb, var(--primary) 55%, var(--app-panel-border, var(--grey)) 45%);
  }

  .data-bus-group.compare-added {
    border-color: var(--success);
  }

  .data-bus-group.compare-changed {
    border-color: var(--warning-light);
  }

  .data-bus-group.disabled {
    opacity: 0.58;
  }

  .data-bus-group.disabled .data-bus-group-title {
    text-decoration: line-through;
  }

  .data-bus-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex: 0 1 auto;
    gap: calc(5px * var(--ui-font-scale, 1));
    max-width: calc(220px * var(--ui-font-scale, 1));
    min-width: 0;
    min-height: calc(30px * var(--ui-font-scale, 1));
    padding: 0 calc(3px * var(--ui-font-scale, 1)) 0 calc(8px * var(--ui-font-scale, 1));
    border-right: 1px solid var(--app-panel-border, var(--grey));
    color: var(--foreground);
  }

  .data-bus-group-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-family);
    font-size: var(--ui-font-size-2xs);
    font-weight: 700;
    letter-spacing: 0.035em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .data-bus-settings {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: calc(22px * var(--ui-font-scale, 1));
    height: calc(22px * var(--ui-font-scale, 1));
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: currentColor;
    cursor: pointer;
    opacity: 0.72;
  }

  .data-bus-settings:hover,
  .data-bus-settings:focus-visible {
    background: rgba(255, 255, 255, 0.08);
    color: currentColor;
    opacity: 1;
    outline: none;
  }

  .data-bus-settings svg {
    width: calc(15px * var(--ui-font-scale, 1));
    height: calc(15px * var(--ui-font-scale, 1));
  }

  .data-bus-channels {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .data-bus-channels::-webkit-scrollbar {
    display: none;
  }

  .data-bus-channel,
  .data-bus-connect-provider {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto 16px;
    align-items: center;
    gap: calc(6px * var(--ui-font-scale, 1));
    min-height: calc(30px * var(--ui-font-scale, 1));
    padding: 0 calc(7px * var(--ui-font-scale, 1));
  }

  .data-bus-channel {
    flex: 0 0 auto;
    border-right: 1px solid color-mix(in srgb, var(--app-panel-border, var(--grey)) 65%, transparent);
  }

  .data-bus-channel:last-child {
    border-right: 0;
  }

  .data-bus-connect-provider {
    flex: 0 0 auto;
    border-left: 1px solid color-mix(in srgb, var(--app-panel-border, var(--grey)) 65%, transparent);
  }

  .data-bus-channel:hover,
  .data-bus-connect-provider:hover,
  .data-bus-channel.highlighted {
    background: rgba(255, 255, 255, 0.055);
  }

  .data-bus-channel.empty,
  .data-bus-connect-provider {
    grid-template-columns: 16px minmax(0, 1fr);
  }

  .data-bus-channel.missing-provider .data-bus-channel-label,
  .data-bus-channel.multiple-providers .data-bus-channel-label {
    color: var(--warning-light);
  }

  .data-bus-channel .port,
  .data-bus-connect-provider .port {
    z-index: 1;
  }

  .data-bus-channel .port-hover-area,
  .data-bus-connect-provider .port-hover-area {
    left: 50%;
    top: 50%;
  }

  .data-bus-channel .input-port,
  .data-bus-channel .output-port,
  .data-bus-connect-provider .input-port {
    margin: 0;
  }

  .data-bus-channel-label {
    max-width: calc(240px * var(--ui-font-scale, 1));
    min-width: 0;
    overflow: hidden;
    color: var(--foreground);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-2xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .data-bus-channel.empty .data-bus-channel-label,
  .data-bus-connect-provider .data-bus-channel-label {
    color: var(--foreground-dim);
    font-style: italic;
  }

  .data-bus-channel-usage {
    min-width: 18px;
    color: var(--foreground-dim);
    font-family: var(--font-family);
    font-size: var(--ui-font-size-2xs);
    text-align: right;
    white-space: nowrap;
  }
`;
