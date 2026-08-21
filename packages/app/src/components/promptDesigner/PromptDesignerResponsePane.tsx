import { type FC } from 'react';

export const PromptDesignerResponsePane: FC<{
  response: string | undefined;
}> = ({ response }) => {
  return <pre className="pre-wrap response-text">{response ?? ''}</pre>;
};
