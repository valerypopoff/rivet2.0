import { css } from '@emotion/react';
import { DATA_BUS_FULL_ROW_HEIGHT_PX } from './dataBusRailLayout.js';

export const dataBusRailStyles = css`
  position: fixed;
  top: var(--project-selector-height);
  right: 0;
  left: var(--data-bus-full-row-left, 0px);
  z-index: 10002;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  box-sizing: border-box;
  width: auto;
  height: var(--data-bus-full-row-height, 0px);
  max-width: none;
  margin: 0;
  padding: 0;
  overflow: hidden;
  pointer-events: auto;
  scrollbar-width: none;
  transform: none;
  background: transparent;

  &::-webkit-scrollbar {
    display: none;
  }

  .data-bus-group {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: stretch;
    flex: 0 0 calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    min-width: 0;
    width: 100%;
    height: calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    max-width: none;
    overflow: hidden;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--foreground);
    box-shadow: none;
  }

  .data-bus-group::after {
    content: '';
    position: absolute;
    z-index: -1;
    top: 0;
    right: 0;
    bottom: calc(8px * var(--ui-font-scale, 1));
    left: 0;
    border: 0;
    border-bottom: 1px solid var(--app-panel-border, var(--grey));
    border-radius: 0;
    background: var(--app-panel-bg, var(--grey-darkest));
    box-shadow: none;
  }

  .data-bus-group-content {
    display: flex;
    align-items: stretch;
    flex: 0 1 auto;
    min-width: 0;
    width: max-content;
    max-width: calc(100% - 32px * var(--ui-font-scale, 1));
    height: 100%;
    margin: 0 auto;
    overflow: hidden;
  }

  .data-bus-group.selected::after,
  .data-bus-group.search-match:not(.selected)::after,
  .data-bus-group.compare-added::after,
  .data-bus-group.compare-changed::after {
    border-color: transparent;
    box-shadow: none;
  }

  .data-bus-group.selected::after {
    box-shadow: inset 0 -2px var(--primary);
  }

  .data-bus-group.search-match:not(.selected)::after {
    box-shadow: inset 0 -1px color-mix(in srgb, var(--primary) 65%, transparent);
  }

  .data-bus-group.compare-added:not(.selected)::after {
    box-shadow: inset 0 -2px var(--success);
  }

  .data-bus-group.compare-changed:not(.selected)::after {
    box-shadow: inset 0 -2px var(--warning-light);
  }

  .data-bus-group::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: calc(8px * var(--ui-font-scale, 1));
    left: 0;
    width: calc(3px * var(--ui-font-scale, 1));
    background: var(--bus-accent);
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
    height: calc(${DATA_BUS_FULL_ROW_HEIGHT_PX - 8}px * var(--ui-font-scale, 1));
    min-height: calc(${DATA_BUS_FULL_ROW_HEIGHT_PX - 8}px * var(--ui-font-scale, 1));
    padding: 0 calc(3px * var(--ui-font-scale, 1)) 0 calc(8px * var(--ui-font-scale, 1));
    box-sizing: border-box;
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
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: calc(6px * var(--ui-font-scale, 1));
    box-sizing: border-box;
    min-height: calc(${DATA_BUS_FULL_ROW_HEIGHT_PX}px * var(--ui-font-scale, 1));
    padding: calc(3px * var(--ui-font-scale, 1)) calc(7px * var(--ui-font-scale, 1)) calc(8px * var(--ui-font-scale, 1));
  }

  .data-bus-channel {
    flex: 0 0 auto;
    padding-top: calc(2px * var(--ui-font-scale, 1));
  }

  .data-bus-connect-provider {
    grid-template-columns: minmax(0, 1fr);
    flex: 0 0 auto;
  }

  .data-bus-connect-provider .data-bus-channel-label {
    align-self: center;
  }

  .data-bus-channel:not(:last-child)::after,
  .data-bus-connect-provider::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: calc(8px * var(--ui-font-scale, 1));
    width: 1px;
    background: color-mix(in srgb, var(--app-panel-border, var(--grey)) 65%, transparent);
    pointer-events: none;
  }

  .data-bus-channel:not(:last-child)::after {
    right: 0;
  }

  .data-bus-connect-provider::after {
    left: 0;
  }

  .data-bus-channel:hover,
  .data-bus-connect-provider:hover,
  .data-bus-channel.highlighted {
    background: linear-gradient(
      to bottom,
      rgba(255, 255, 255, 0.055) 0 calc(100% - 8px * var(--ui-font-scale, 1)),
      transparent calc(100% - 8px * var(--ui-font-scale, 1))
    );
  }

  .data-bus-channel.missing-provider .data-bus-channel-label,
  .data-bus-channel.multiple-providers .data-bus-channel-label {
    color: var(--warning-light);
  }

  .data-bus-channel-port {
    position: absolute;
    bottom: calc(8px * var(--ui-font-scale, 1) - 8px);
    z-index: 2;
  }

  .data-bus-channel-port.input {
    left: calc(8px * var(--ui-font-scale, 1));
  }

  .data-bus-channel-port.output {
    right: calc(8px * var(--ui-font-scale, 1));
  }

  .data-bus-channel .port-hover-area,
  .data-bus-connect-provider .port-hover-area {
    left: 50%;
    top: 50%;
  }

  .data-bus-channel-port .input-port,
  .data-bus-channel-port .output-port {
    margin: 0;
  }

  .data-bus-channel-port-count {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: grid;
    place-items: center;
    color: var(--foreground-dim);
    font-family: var(--font-family);
    font-size: 8px;
    font-weight: 700;
    line-height: 1;
    pointer-events: none;
  }

  .data-bus-channel-port.connected .data-bus-channel-port-count {
    color: var(--foreground-on-primary);
  }

  .data-bus-channel-port-count.two-digits {
    font-size: 7px;
  }

  .data-bus-channel-port-count.three-or-more-digits {
    font-size: 6px;
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
    padding-top: 0.45em;
    padding-right: 0.65em;
  }

  .data-bus-provider-label {
    display: flex;
    flex-direction: column;
    gap: calc(2px * var(--ui-font-scale, 1));
    min-width: 0;
    line-height: 1;
  }

  .data-bus-provider-label > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .data-bus-provider-source {
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .data-bus-channel.empty .data-bus-channel-label,
  .data-bus-connect-provider .data-bus-channel-label {
    color: var(--foreground-dim);
    font-style: italic;
  }
`;
