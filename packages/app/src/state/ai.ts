import {
  defaultAiAssistModelSelectorValue,
  type AiAssistModelSelectorValue,
} from '../utils/aiAssistModelSettings';
import { createHybridStorage } from './storage';
import { atomWithStorage } from 'jotai/utils';

const { storage } = createHybridStorage('ai');

export const selectedAssistModelState = atomWithStorage<AiAssistModelSelectorValue>(
  'selectAssistModel',
  defaultAiAssistModelSelectorValue,
  storage,
);

export const aiAssistCustomProviderBaseURLState = atomWithStorage<string>(
  'aiAssistCustomProviderBaseURL',
  '',
  storage,
);

export const aiAssistCustomModelState = atomWithStorage<string>('aiAssistCustomModel', '', storage);
