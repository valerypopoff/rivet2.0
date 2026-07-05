import { createContext, type ReactNode } from 'react';

export type NodeCodeEditorFooterActionBridge = {
  setFooterLeftAction(action: ReactNode | null): void;
};

export const NodeCodeEditorFooterActionContext = createContext<NodeCodeEditorFooterActionBridge | undefined>(
  undefined,
);
