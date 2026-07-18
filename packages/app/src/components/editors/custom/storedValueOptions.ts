import type { NodeGraph, Project } from '@valerypopoff/rivet2-core';
import { getStaticStoredValueKeys } from '../../../domain/graphEditing/storedValues.js';

export type StoredValueOption = { label: string; value: string };

export function getStoredValueOptions(
  project: Pick<Project, 'graphs'> | undefined,
  liveGraph?: NodeGraph,
): StoredValueOption[] {
  return [...getStaticStoredValueKeys(project, liveGraph)]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => ({ label: key, value: key }));
}
