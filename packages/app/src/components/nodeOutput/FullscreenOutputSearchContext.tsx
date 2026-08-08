import { createContext, useContext } from 'react';
import type { SearchProvider } from './fullscreenOutputSearch.js';

type FullscreenOutputSearchContextValue = {
  query: string;
  registerProvider: (provider: SearchProvider) => () => void;
};

export const FullscreenOutputSearchContext = createContext<FullscreenOutputSearchContextValue | null>(null);

export function useFullscreenOutputSearchContext(): FullscreenOutputSearchContextValue | null {
  return useContext(FullscreenOutputSearchContext);
}
