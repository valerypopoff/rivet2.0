import { atom } from 'jotai';
import type { NodePrefabId } from '@valerypopoff/rivet2-core';

export const nodeLibraryOpenState = atom(false);

export const editingNodePrefabIdState = atom<NodePrefabId | undefined>(undefined);
