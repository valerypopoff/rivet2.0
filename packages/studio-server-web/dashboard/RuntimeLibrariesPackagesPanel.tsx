import Button, { LoadingButton } from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import type { FC, KeyboardEvent as ReactKeyboardEvent } from 'react';

import type { RuntimeLibraryEntry } from './runtimeLibrariesApi';

interface RuntimeLibrariesPackagesPanelProps {
  packages: RuntimeLibraryEntry[];
  showInstallForm: boolean;
  addName: string;
  addVersion: string;
  isJobActive: boolean;
  onAddNameChange: (value: string) => void;
  onAddVersionChange: (value: string) => void;
  onShowInstallForm: (value: boolean) => void;
  onInstall: () => void;
  onRemove: (packageName: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  displayedJobType?: 'install' | 'remove';
}

export const RuntimeLibrariesPackagesPanel: FC<RuntimeLibrariesPackagesPanelProps> = ({
  packages,
  showInstallForm,
  addName,
  addVersion,
  isJobActive,
  onAddNameChange,
  onAddVersionChange,
  onShowInstallForm,
  onInstall,
  onRemove,
  onKeyDown,
  displayedJobType,
}) => {
  return (
    <>
      {packages.length > 0 ? (
        <>
          <div className="project-settings-field runtime-libraries-section">
            <div className="runtime-libraries-installed-list">
              {packages.map((pkg) => (
                <div key={pkg.name} className="runtime-libraries-installed-item">
                  <div className="runtime-libraries-package-info">
                    <span className="runtime-libraries-package-name">{`${pkg.name}: ${pkg.version}`}</span>
                  </div>
                  <Button
                    appearance="subtle"
                    spacing="compact"
                    className="runtime-libraries-remove-button project-settings-secondary-button button-size-s"
                    isDisabled={isJobActive}
                    onClick={() => onRemove(pkg.name)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
          {showInstallForm ? <div className="runtime-libraries-section-divider" aria-hidden="true" /> : null}
        </>
      ) : null}

      {showInstallForm ? (
        <div className="project-settings-field runtime-libraries-section">
          <label className="project-settings-label" htmlFor="runtime-library-package-name">
            Install library
          </label>
          <div className="runtime-libraries-form-grid">
            <div className="project-settings-field">
              <TextField
                id="runtime-library-package-name"
                className="project-settings-input text-field-size-l"
                value={addName}
                onChange={(e) => onAddNameChange(e.currentTarget.value)}
                onKeyDown={onKeyDown}
                isDisabled={isJobActive}
                placeholder="NPM package name"
                spellCheck={false}
              />
            </div>
            <div className="project-settings-field">
              <TextField
                id="runtime-library-package-version"
                className="project-settings-input text-field-size-l"
                value={addVersion}
                onChange={(e) => onAddVersionChange(e.currentTarget.value)}
                onKeyDown={onKeyDown}
                isDisabled={isJobActive}
                placeholder="version"
                spellCheck={false}
              />
            </div>
            <div className="runtime-libraries-form-action">
              <LoadingButton
                appearance="primary"
                className="project-settings-primary-button runtime-libraries-install-button button-size-l"
                onClick={onInstall}
                isDisabled={isJobActive || !addName.trim()}
                isLoading={isJobActive && displayedJobType === 'install'}
              >
                Install
              </LoadingButton>
            </div>
          </div>
        </div>
      ) : (
        <Button
          appearance="primary"
          className="runtime-libraries-add-button button-size-l"
          onClick={() => onShowInstallForm(true)}
          isDisabled={isJobActive}
        >
          Add library...
        </Button>
      )}
    </>
  );
};
