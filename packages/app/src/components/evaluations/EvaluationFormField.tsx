import { css } from '@emotion/react';
import { type FC, type ReactNode, useId } from 'react';

const fieldStyles = css`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;

  .evaluation-field-label {
    color: var(--foreground);
    font-size: var(--ui-font-size-sm);
    font-weight: 600;
    line-height: 1.3;
  }

  .evaluation-field-description {
    margin: -2px 0 2px;
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    line-height: 1.35;
  }
`;

export const EvaluationFormField: FC<{
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  label: ReactNode;
}> = ({ children, className, description, label }) => {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <div
      css={fieldStyles}
      className={className}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={description == null ? undefined : descriptionId}
    >
      <span id={labelId} className="evaluation-field-label">
        {label}
      </span>
      {description == null ? null : (
        <span id={descriptionId} className="evaluation-field-description">
          {description}
        </span>
      )}
      {children}
    </div>
  );
};
