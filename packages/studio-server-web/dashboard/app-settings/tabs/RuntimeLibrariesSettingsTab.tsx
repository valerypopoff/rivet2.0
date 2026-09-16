import { RuntimeLibrariesJobPanel } from '../../RuntimeLibrariesJobPanel';
import { RuntimeLibrariesPackagesPanel } from '../../RuntimeLibrariesPackagesPanel';
import { useRuntimeLibrariesState } from '../../useRuntimeLibrariesState';
import '../RuntimeLibrariesSettingsTab.css';

export function RuntimeLibrariesSettingsTab() {
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
  } = useRuntimeLibrariesState();

  return (
    <section className="app-settings-runtime-libraries-panel" aria-label="Runtime libraries">
      <div className="runtime-libraries-help">
        Installed runtime libraries are available to Code nodes
      </div>

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
    </section>
  );
}
