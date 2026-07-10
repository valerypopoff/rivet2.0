import type { FC } from 'react';
import type { Project, UiComponentId, UiGraphComponent } from '@valerypopoff/rivet2-core';
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
      onFocusCapture={() => onActivate(component.id)}
      onPointerDownCapture={() => onActivate(component.id)}
    >
      <div className="ui-graph-component-card-title">
        <span className="ui-graph-component-card-title-main">
          <span>{getUiGraphComponentLabel(component.type)}</span>
        </span>
        <button
          type="button"
          className="ui-graph-component-delete-button"
          aria-label="Delete component"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onDelete}
        >
          &times;
        </button>
      </div>
      <Settings {...settingsProps} />
    </div>
  );
};
