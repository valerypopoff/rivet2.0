import { createContext, type ReactNode } from 'react';

export type NodeCodeEditorFooterActionBridge = {
  setFooterLeftAction(action: ReactNode | null): void;
  setSelectedTextGetter(getter: (() => string | undefined) | undefined): void;
  getSelectedText(): string | undefined;
};

export const NodeCodeEditorFooterActionContext = createContext<NodeCodeEditorFooterActionBridge | undefined>(
  undefined,
);
