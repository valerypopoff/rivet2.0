import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { toast } from 'react-toastify';
import {
  deleteWorkflowProject,
  publishWorkflowProject,
  unpublishWorkflowProject,
} from './workflowApi';
import { validateEndpointName } from './projectSettingsForm';
import type {
  WorkflowProjectItem,
  WorkflowProjectSettingsDraft,
} from './types';

type UseProjectSettingsActionsOptions = {
  activeProject: WorkflowProjectItem;
  allProjects: WorkflowProjectItem[];
  isOpen: boolean;
  onClose: () => void;
  onDeleteProject: (path: string, projectId?: string | null) => void;
  onRefresh: () => void | Promise<void>;
};

export function useProjectSettingsActions(options: UseProjectSettingsActionsOptions) {
  const {
    activeProject,
    allProjects,
    isOpen,
    onClose,
    onDeleteProject,
    onRefresh,
  } = options;
  const [settingsDraft, setSettingsDraft] = useState<WorkflowProjectSettingsDraft>({ endpointName: '' });
  const [showPublishSettings, setShowPublishSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  useEffect(() => {
    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
    setShowPublishSettings(false);
  }, [activeProject, isOpen]);

  const trimmedDraftEndpointName = useMemo(() => settingsDraft.endpointName.trim(), [settingsDraft.endpointName]);
  const endpointLookupName = useMemo(() => trimmedDraftEndpointName.toLowerCase(), [trimmedDraftEndpointName]);

  const endpointDuplicateProject = useMemo(() => {
    if (!endpointLookupName) {
      return null;
    }

    return allProjects.find(
      (project) =>
        project.absolutePath !== activeProject.absolutePath &&
        project.settings.status !== 'unpublished' &&
        project.settings.endpointName.trim().toLowerCase() === endpointLookupName,
    ) ?? null;
  }, [activeProject.absolutePath, allProjects, endpointLookupName]);

  const endpointValidationError = useMemo(() => {
    return validateEndpointName(
      trimmedDraftEndpointName,
      endpointDuplicateProject?.fileName ?? null,
    );
  }, [endpointDuplicateProject, trimmedDraftEndpointName]);

  const handleSettingsDraftChange =
    <K extends keyof WorkflowProjectSettingsDraft>(key: K) =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value as WorkflowProjectSettingsDraft[K];
      setSettingsDraft((prev) => ({
        ...prev,
        [key]: value,
      }));
    };

  const handleShowPublishSettings = () => {
    if (savingSettings || deletingProject) {
      return;
    }

    setShowPublishSettings(true);
  };

  const handleCancelPublishSettings = () => {
    if (savingSettings || deletingProject) {
      return;
    }

    setSettingsDraft({ endpointName: activeProject.settings.endpointName });
    setShowPublishSettings(false);
  };

  const handlePublishProject = async (publishChanges = false) => {
    setSavingSettings(true);

    try {
      await publishWorkflowProject(activeProject.relativePath, {
        endpointName: publishChanges ? activeProject.settings.endpointName : settingsDraft.endpointName,
      });
      await onRefresh();
      setShowPublishSettings(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleUnpublishProject = async () => {
    const shouldProceed = window.confirm(`Unpublish project "${activeProject.fileName}"?`);
    if (!shouldProceed) {
      return;
    }

    setSavingSettings(true);

    try {
      await unpublishWorkflowProject(activeProject.relativePath);
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update project publication state');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleDeleteActiveProject = async () => {
    const shouldDelete = window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`);
    if (!shouldDelete) {
      return;
    }

    setDeletingProject(true);

    try {
      const deletedProject = await deleteWorkflowProject(activeProject.relativePath);
      onDeleteProject(activeProject.absolutePath, deletedProject.projectId);
      onClose();
      await onRefresh();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setDeletingProject(false);
    }
  };

  return {
    settingsDraft,
    showPublishSettings,
    savingSettings,
    deletingProject,
    trimmedDraftEndpointName,
    endpointValidationError,
    handleSettingsDraftChange,
    handleShowPublishSettings,
    handleCancelPublishSettings,
    handlePublishProject,
    handleUnpublishProject,
    handleDeleteActiveProject,
  };
}
