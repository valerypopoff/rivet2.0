import { css } from '@emotion/react';
import type { FC } from 'react';

type LLMNodeBodySection = Readonly<{
  id: string;
  fields: readonly Readonly<{ label: string; value: string }>[];
  snippet?: Readonly<{ label: string; text: string }> | undefined;
}>;

const llmNodeBodyStyles = css`
  display: flex;
  flex-direction: column;
  max-width: 100%;
  min-width: 0;

  .llm-node-body-section {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
  }

  .llm-node-body-section + .llm-node-body-section {
    border-top: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent);
    margin-top: 8px;
    padding-top: 8px;
  }

  .llm-node-body-field {
    line-height: 1.4;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .llm-node-body-field + .llm-node-body-field {
    margin-top: 3px;
  }

  .llm-node-body-label {
    opacity: 0.6;
  }

  .llm-node-body-snippet-label {
    line-height: 1.4;
    margin-top: 4px;
    opacity: 0.6;
  }

  .llm-node-body-snippet {
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
    border-radius: 3px;
    font-family: var(--font-family-monospace);
    line-height: 1.35;
    margin: 3px 0 0;
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
    padding: 4px 5px;
    white-space: pre-wrap;
  }
`;

export const LLMNodeBody: FC<{ sections: readonly LLMNodeBodySection[] }> = ({ sections }) => (
  <div css={llmNodeBodyStyles}>
    {sections.map((section) => (
      <div className="llm-node-body-section" key={section.id}>
        {section.fields.map((field) => (
          <div className="llm-node-body-field" key={field.label}>
            <span className="llm-node-body-label">{field.label}:</span> {field.value}
          </div>
        ))}
        {section.snippet ? (
          <>
            <div className="llm-node-body-snippet-label">{section.snippet.label}:</div>
            <pre className="llm-node-body-snippet">{section.snippet.text}</pre>
          </>
        ) : null}
      </div>
    ))}
  </div>
);
