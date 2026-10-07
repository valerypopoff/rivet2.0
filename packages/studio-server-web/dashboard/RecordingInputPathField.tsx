import { useId, useRef, useState } from 'react';

export function RecordingInputPathField({
  value,
  paths,
  onChange,
  onDelete,
  onRefresh,
}: {
  value: string;
  paths: string[];
  onChange: (value: string) => void;
  onDelete: (value: string) => void;
  onRefresh: () => void;
}) {
  const menuId = useId();
  const inputId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const showHistory = () => {
    onRefresh();
    setOpen(true);
  };
  const visible = open && paths.length > 0;

  return (
    <div
      className="run-recordings-input-filter-field run-recordings-input-path-field"
      ref={containerRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && visible) {
          event.preventDefault();
          event.stopPropagation();
          inputRef.current?.focus();
          setOpen(false);
        }
      }}
    >
      <label className="run-recordings-field-label" htmlFor={inputId}>
        Input JSON path
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={showHistory}
        onClick={showHistory}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && paths.length > 0) {
            event.preventDefault();
            setOpen(true);
            // Focus after the menu has mounted when reopening with the keyboard.
            requestAnimationFrame(() => {
              if (document.activeElement === inputRef.current) {
                containerRef.current?.querySelector<HTMLButtonElement>('.run-recordings-input-path-select')?.focus();
              }
            });
          }
        }}
        placeholder="$.foo"
        autoComplete="off"
        role="combobox"
        aria-haspopup="dialog"
        aria-autocomplete="none"
        aria-expanded={visible}
        aria-controls={visible ? menuId : undefined}
      />
      {visible ? (
        <div
          id={menuId}
          className="run-recordings-input-path-history"
          role="dialog"
          tabIndex={-1}
          aria-label="Saved input JSON paths"
        >
          {paths.map((path) => (
            <div key={path} className="run-recordings-input-path-history-row">
              <button
                type="button"
                className="run-recordings-input-path-select"
                onClick={() => {
                  onChange(path);
                  inputRef.current?.focus();
                  setOpen(false);
                }}
              >
                {path}
              </button>
              <button
                type="button"
                className="run-recordings-input-path-delete"
                aria-label={`Delete saved path ${path}`}
                title="Delete saved path"
                onClick={() => {
                  inputRef.current?.focus();
                  onDelete(path);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
