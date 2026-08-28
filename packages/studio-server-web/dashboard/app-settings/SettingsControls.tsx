import Button, { LoadingButton } from '@atlaskit/button';
import type { ReactNode } from 'react';

import { SegmentedControl, SegmentedControlButton } from '../SegmentedControl';

export function ActionStatus({
  error,
  pending,
  saved,
  savedMessage = 'Saved.',
}: {
  error?: string | null;
  pending?: string;
  saved?: boolean;
  savedMessage?: string;
}) {
  if (error) {
    return <div className="project-settings-error app-settings-action-status">{error}</div>;
  }
  if (pending) {
    return <div className="project-settings-muted app-settings-action-status">{pending}</div>;
  }
  if (saved) {
    return <div className="project-settings-success app-settings-action-status">{savedMessage}</div>;
  }
  return null;
}

export function SettingsActions({
  changed,
  disabled,
  error,
  loading,
  onRevert,
  onSave,
  pending,
  saved,
  savedMessage,
}: {
  changed: boolean;
  disabled: boolean;
  error?: string | null;
  loading: boolean;
  onRevert: () => void;
  onSave: () => unknown;
  pending?: string;
  saved?: boolean;
  savedMessage?: string;
}) {
  return (
    <div className="app-settings-actions-row">
      <LoadingButton
        appearance="primary"
        className="app-settings-action-button button-size-l"
        isLoading={loading}
        isDisabled={disabled || !changed}
        onClick={onSave}
      >
        Save
      </LoadingButton>
      <Button
        appearance="subtle"
        className="app-settings-action-button button-size-l"
        isDisabled={disabled || !changed}
        onClick={onRevert}
      >
        Revert
      </Button>
      <ActionStatus error={error} pending={pending} saved={saved} savedMessage={savedMessage} />
    </div>
  );
}

export function ModeButton({
  active,
  children,
  disabled,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <SegmentedControlButton
      className="app-settings-mode-tab"
      selected={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </SegmentedControlButton>
  );
}

export function ModeGroup({
  children,
  label,
  wide = false,
}: {
  children: ReactNode;
  label: string;
  wide?: boolean;
}) {
  return (
    <SegmentedControl
      className={`app-settings-mode-tabs${wide ? ' app-settings-wide-mode-tabs' : ''}`}
      label={label}
    >
      {children}
    </SegmentedControl>
  );
}

export function BooleanSetting({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="app-settings-checkbox-field">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="app-settings-checkbox-label">{label}</span>
    </label>
  );
}
