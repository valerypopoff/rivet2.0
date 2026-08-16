import { type Project } from '@valerypopoff/rivet2-core';
import { type EvaluationProjectFileData, type IOProvider, isPathBasedIOProvider } from '../io/IOProvider.js';

type ProjectSaveWithoutPromptProvider = IOProvider & {
  saveProjectDataNoPrompt(project: Project, evaluation: EvaluationProjectFileData, path: string): Promise<void>;
  canSaveProjectDataNoPrompt?(path: string): boolean;
};

export function canSaveProjectDataNoPrompt(
  ioProvider: IOProvider,
  path: string | null,
): ioProvider is ProjectSaveWithoutPromptProvider {
  if (!path || typeof (ioProvider as Partial<ProjectSaveWithoutPromptProvider>).saveProjectDataNoPrompt !== 'function') {
    return false;
  }

  const canSave = (ioProvider as Partial<ProjectSaveWithoutPromptProvider>).canSaveProjectDataNoPrompt;
  if (typeof canSave === 'function') {
    return canSave.call(ioProvider, path);
  }

  return isPathBasedIOProvider(ioProvider);
}
