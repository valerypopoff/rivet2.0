import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import type { FC } from 'react';

import { RuntimeLibrariesJobPanel } from './RuntimeLibrariesJobPanel';
import { RuntimeLibrariesPackagesPanel } from './RuntimeLibrariesPackagesPanel';
import { useRuntimeLibrariesModalState } from './useRuntimeLibrariesModalState';
import './RuntimeLibrariesModal.css';

interface RuntimeLibrariesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const RuntimeLibrariesModal: FC<RuntimeLibrariesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    loading,
    error,
    addName,
    addVersion,
    showInstallForm,
    displayedJob,
    logEntries,
    jobResult,
    cancellingJob,
    isJobActive,
    isStalled,
    nowMs,
    packages,
    logPanelRef,
    setAddName,
    setAddVersion,
    setShowInstallForm,
    handleInstall,
    handleRemove,
    handleCancel,
    handleKeyDown,
  } = useRuntimeLibrariesModalState(isOpen);

  if (!isOpen) {
    return null;
  }

  return (
    <ModalTransition>
      <ModalDialog
        testId="runtime-libraries-modal"
        width="medium"
        label="Runtime libraries"
        onClose={onClose}
      >
        <ModalBody>
          <div className="project-settings-modal-shell runtime-libraries-shell">
            <div className="project-settings-modal-header-row runtime-libraries-header-row">
              <div className="project-settings-modal-heading runtime-libraries-heading">
                <div className="project-settings-modal-title runtime-libraries-title">Runtime libraries</div>
                <div className="runtime-libraries-help runtime-libraries-header-help">
                  Installed runtime libraries are available to Code nodes
                </div>
              </div>
              <button
                type="button"
                className="project-settings-close-button"
                onClick={onClose}
                aria-label="Close runtime libraries"
              >
                X
              </button>
            </div>

            <div className="project-settings-modal-content runtime-libraries-content">
              {error ? (
                <div className="project-settings-error runtime-libraries-status failed">{error}</div>
              ) : null}

              {loading ? (
                <div className="runtime-libraries-empty-state">Loading runtime libraries...</div>
              ) : (
                <>
                  <RuntimeLibrariesPackagesPanel
                    packages={packages}
                    showInstallForm={showInstallForm}
                    addName={addName}
                    addVersion={addVersion}
                    isJobActive={isJobActive}
                    onAddNameChange={setAddName}
                    onAddVersionChange={setAddVersion}
                    onShowInstallForm={setShowInstallForm}
                    onInstall={() => void handleInstall()}
                    onRemove={(packageName) => void handleRemove(packageName)}
                    onKeyDown={handleKeyDown}
                    displayedJobType={displayedJob?.type}
                  />

                  <RuntimeLibrariesJobPanel
                    displayedJob={displayedJob}
                    logEntries={logEntries}
                    jobResult={jobResult}
                    isJobActive={isJobActive}
                    isStalled={isStalled}
                    nowMs={nowMs}
                    cancellingJob={cancellingJob}
                    logPanelRef={logPanelRef}
                    onCancel={() => void handleCancel()}
                  />
                </>
              )}
            </div>
          </div>
        </ModalBody>
      </ModalDialog>
    </ModalTransition>
  );
};
