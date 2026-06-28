import { atom } from 'jotai';
import type { UiGraphId } from '@valerypopoff/rivet2-core';

export const selectedUiGraphIdState = atom<UiGraphId | undefined>(undefined);
