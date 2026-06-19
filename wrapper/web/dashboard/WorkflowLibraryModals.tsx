import type { FC } from 'react';
import { AboutModal } from './AboutModal';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { RuntimeLibrariesModal } from './RuntimeLibrariesModal';
import { RunRecordingsModal } from './RunRecordingsModal';
import { WorkflowPublishedVersionHistoryModal } from './WorkflowPublishedVersionHistoryModal';
import { WorkflowProjectVersionModal } from './WorkflowProjectVersionModal';
import { useWorkflowLibraryController } from './useWorkflowLibraryController';

type WorkflowLibraryController = ReturnType<typeof useWorkflowLibraryController>;

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
}> = ({ controller }) => {
  const {
    settingsModalOpen,
    settingsModalProject,
    publishedHistoryProject,
    allProjects,
    closeSettingsModal,
    openPublishedHistoryModal,
    closePublishedHistoryModal,
    refresh,
    handlePublishedVersionRestored,
    onDeleteProject,
    runtimeLibsOpen,
    setRuntimeLibsOpen,
    runRecordingsOpen,
    runRecordingsResetToken,
    hideRunRecordingsModal,
    closeRunRecordingsModal,
    handleRunRecordingsFoundCountChange,
    aboutOpen,
    setAboutOpen,
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
      {settingsModalOpen && settingsModalProject ? (
        <ProjectSettingsModal
          activeProject={settingsModalProject}
          allProjects={allProjects}
          isOpen={settingsModalOpen}
          onClose={closeSettingsModal}
          onRefresh={() => refresh(false)}
          onDeleteProject={onDeleteProject}
          onOpenPublishedHistory={openPublishedHistoryModal}
        />
      ) : null}
      <WorkflowPublishedVersionHistoryModal
        isOpen={publishedHistoryProject != null}
        project={publishedHistoryProject}
        onClose={closePublishedHistoryModal}
        onPreviewVersion={onOpenPublishedVersionPreview}
        onRestored={handlePublishedVersionRestored}
      />
      <RuntimeLibrariesModal
        isOpen={runtimeLibsOpen}
        onClose={() => setRuntimeLibsOpen(false)}
      />
      <RunRecordingsModal
        isOpen={runRecordingsOpen}
        resetToken={runRecordingsResetToken}
        onDismiss={hideRunRecordingsModal}
        onClose={closeRunRecordingsModal}
        onOpenRecording={onOpenRecording}
        onFoundCountChange={handleRunRecordingsFoundCountChange}
      />
      <AboutModal
        isOpen={aboutOpen}
        onClose={() => setAboutOpen(false)}
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
