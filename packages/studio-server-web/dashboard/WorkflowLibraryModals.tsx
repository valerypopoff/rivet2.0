import { lazy, Suspense, useState, type Dispatch, type FC, type SetStateAction } from 'react';
import { AppSettingsModal } from './AppSettingsModal';
import { LocalStorageUpgradePrompt } from './LocalStorageUpgradePrompt';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { PublishedItemsModal } from './PublishedItemsModal';
import { RunRecordingsModal } from './RunRecordingsModal';
import { WorkflowProjectVersionModal } from './WorkflowProjectVersionModal';
import { WorkflowProjectBundleModal } from './WorkflowProjectBundleModal';
import type { HostedRouteConfig } from './types';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';

type WorkflowLibraryController = ReturnType<typeof useWorkflowLibraryController>;

const RunStatisticsModal = lazy(async () => {
  const module = await import('./RunStatisticsModal');
  return { default: module.RunStatisticsModal };
});

function getProjectVersionActionLabel(mode: WorkflowLibraryController['projectModalMode']) {
  if (mode === 'download') {
    return 'Download';
  }

  if (mode === 'duplicate') {
    return 'Duplicate';
  }

  return 'Compare';
}

export const WorkflowLibraryModals: FC<{
  controller: WorkflowLibraryController;
  scheduledRunsOpen?: boolean;
  routeConfig: HostedRouteConfig;
  onRouteConfigChange?: Dispatch<SetStateAction<HostedRouteConfig>>;
}> = ({ controller, routeConfig, onRouteConfigChange, scheduledRunsOpen }) => {
  const [upgradeTabRequested, setUpgradeTabRequested] = useState(false);
  const {
    settingsModalOpen,
    settingsModalProject,
    allProjects,
    closeSettingsModal,
    refresh,
    handlePublishedVersionRestored,
    onDeleteProject,
    runRecordingsOpen,
    runRecordingsResetToken,
    hideRunRecordingsModal,
    closeRunRecordingsModal,
    handleRunRecordingsFoundCountChange,
    runStatisticsOpen,
    setRunStatisticsOpen,
    publishedItemsOpen,
    setPublishedItemsOpen,
    openPublishedItemProject,
    appSettingsOpen,
    setAppSettingsOpen,
    onOpenRecording,
    onOpenPublishedVersionPreview,
    projectModalProject,
    projectModalMode,
    projectModalActiveVersion,
    closeProjectModal,
    handleProjectModalSelectPublished,
    handleProjectModalSelectUnpublishedChanges,
  } = controller;

  return (
    <>
      {controller.bundleProject ? (
        <WorkflowProjectBundleModal
          key={controller.bundleProject.id}
          project={controller.bundleProject}
          isOpen={controller.bundleOpen}
          onClose={controller.closeBundleModal}
        />
      ) : null}
      <LocalStorageUpgradePrompt
        suppressed={
          scheduledRunsOpen ||
          controller.bundleOpen ||
          appSettingsOpen ||
          settingsModalOpen ||
          runRecordingsOpen ||
          runStatisticsOpen ||
          publishedItemsOpen ||
          projectModalProject != null
        }
        onStart={() => {
          setUpgradeTabRequested(true);
          setAppSettingsOpen(true);
        }}
      />
      {settingsModalOpen && settingsModalProject ? (
        <ProjectSettingsModal
          key={settingsModalProject.id}
          activeProject={settingsModalProject}
          allProjects={allProjects}
          isOpen={settingsModalOpen}
          onClose={closeSettingsModal}
          onRefresh={() => refresh(false, { preserveVisibleTreeOnError: true })}
          onDeleteProject={onDeleteProject}
          onPreviewPublishedVersion={onOpenPublishedVersionPreview}
          onPublishedVersionRestored={handlePublishedVersionRestored}
          onOpenRecording={onOpenRecording}
          routeConfig={routeConfig}
        />
      ) : null}
      <RunRecordingsModal
        isOpen={runRecordingsOpen}
        resetToken={runRecordingsResetToken}
        onDismiss={hideRunRecordingsModal}
        onClose={closeRunRecordingsModal}
        onOpenRecording={onOpenRecording}
        onFoundCountChange={handleRunRecordingsFoundCountChange}
      />
      {runStatisticsOpen ? (
        <Suspense fallback={null}>
          <RunStatisticsModal isOpen={runStatisticsOpen} onClose={() => setRunStatisticsOpen(false)} />
        </Suspense>
      ) : null}
      <PublishedItemsModal
        isOpen={publishedItemsOpen}
        projects={allProjects}
        routeConfig={routeConfig}
        onClose={() => setPublishedItemsOpen(false)}
        onOpenProject={openPublishedItemProject}
      />
      <AppSettingsModal
        isOpen={appSettingsOpen}
        initialTab={upgradeTabRequested ? 'local-upgrade' : 'general'}
        onClose={() => {
          setAppSettingsOpen(false);
          setUpgradeTabRequested(false);
        }}
        routeConfig={routeConfig}
        onRouteConfigChange={onRouteConfigChange}
      />
      <WorkflowProjectVersionModal
        isOpen={projectModalProject != null}
        project={projectModalProject}
        actionLabel={getProjectVersionActionLabel(projectModalMode)}
        activeVersion={projectModalActiveVersion}
        onClose={closeProjectModal}
        onSelectPublished={handleProjectModalSelectPublished}
        onSelectUnpublishedChanges={handleProjectModalSelectUnpublishedChanges}
      />
    </>
  );
};
