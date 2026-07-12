import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import type { FC, KeyboardEvent, PointerEvent } from 'react';
import type { Project, UiComponentId, UiGraphComponent } from '@valerypopoff/rivet2-core';
import { Tooltip } from '../Tooltip.js';
import {
  getUiGraphComponentDescriptor,
  getUiGraphComponentLabel,
  type UiGraphComponentSettingsProps,
} from './componentDescriptors.js';
import { getUniqueDataKeyOptions, isDataKeyAlreadyUsedEarlier, type UiGraphDataKeyUsage } from './dataKeys.js';

export const UiGraphComponentEditor: FC<{
  activeComponentId: UiComponentId | undefined;
  component: UiGraphComponent;
  dataKeyUsages: readonly UiGraphDataKeyUsage[];
  onActivate(componentId: UiComponentId): void;
  onDelete(): void;
  onUpdate(updater: (component: UiGraphComponent) => void): void;
  project: Project;
}> = ({ activeComponentId, component, dataKeyUsages, onActivate, onDelete, onUpdate, project }) => {
  const Settings = getUiGraphComponentDescriptor(component.type).Settings;
  const settingsProps: UiGraphComponentSettingsProps = {
    component,
    dataKeyOptions: getUniqueDataKeyOptions(dataKeyUsages),
    isDataKeyAlreadyUsed: (key, currentUsage) => isDataKeyAlreadyUsedEarlier(dataKeyUsages, key, currentUsage),
    onUpdate,
    project,
  };

  return (
    <div
      className={`ui-graph-component-card${activeComponentId === component.id ? ' active' : ''}`}
      data-ui-graph-component-id={component.id}
      onFocusCapture={() => onActivate(component.id)}
      onPointerDownCapture={() => onActivate(component.id)}
    >
      <div className="ui-graph-component-card-title">
        <span className="ui-graph-component-card-title-main">
          <span>{getUiGraphComponentLabel(component.type)}</span>
        </span>
        <Tooltip content="Delete component" tag="span">
          <DeleteIcon
            className="ui-graph-component-delete-icon"
            role="button"
            tabIndex={0}
            aria-label="Delete component"
            onPointerDown={(event: PointerEvent<SVGSVGElement>) => event.stopPropagation()}
            onClick={onDelete}
            onKeyDown={(event: KeyboardEvent<SVGSVGElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onDelete();
              }
            }}
          />
        </Tooltip>
      </div>
      <Settings {...settingsProps} />
    </div>
  );
};
