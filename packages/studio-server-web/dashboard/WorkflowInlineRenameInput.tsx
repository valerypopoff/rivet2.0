import { type FC, useEffect, useRef, useState } from 'react';

type WorkflowInlineRenameInputProps = {
  classNamePrefix: 'folder' | 'project';
  initialValue: string;
  identityKey: string;
  ariaLabel: string;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
};

export const WorkflowInlineRenameInput: FC<WorkflowInlineRenameInputProps> = ({
  classNamePrefix,
  initialValue,
  identityKey,
  ariaLabel,
  onSubmit,
  onCancel,
}) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [identityKey]);

  return (
    <form
      className={`${classNamePrefix}-rename-form`}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void onSubmit(value);
      }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        className={`${classNamePrefix}-rename-input`}
        value={value}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onBlur={onCancel}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      />
    </form>
  );
};
