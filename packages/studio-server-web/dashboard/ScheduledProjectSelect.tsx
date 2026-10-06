import { useMemo, useState } from 'react';
import Select from '@atlaskit/select';
import FolderIcon from 'majesticons/line/folder-line.svg?react';
import FileIcon from 'majesticons/line/file-line.svg?react';
import type { WorkflowProjectItem } from './types';
import { scheduledProjectOptions, type ScheduledProjectOption } from './scheduledProjectOptions';

export function ScheduledProjectSelect({
  projects,
  value,
  disabled,
  onChange,
  onMenuChange,
}: {
  projects: WorkflowProjectItem[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  onMenuChange(id: string, open: boolean): void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const options = useMemo(() => scheduledProjectOptions(projects, expanded, search), [projects, expanded, search]);
  const project = projects.find((item) => item.id === value);
  const selected: ScheduledProjectOption | null = value
    ? {
        value,
        label: project?.name ?? 'Unavailable project',
        path: project?.relativePath.replaceAll('\\', '/') ?? value,
        kind: 'project',
        depth: 0,
        unavailable: !project,
      }
    : null;
  const close = () => {
    setOpen(false);
    setSearch('');
    onMenuChange('scheduled-run-project', false);
  };
  return (
    <Select<ScheduledProjectOption>
      inputId="scheduled-run-project"
      onMenuOpen={() => {
        if (disabled) return;
        if (selected && !selected.unavailable)
          setExpanded((current) => {
            const next = new Set(current);
            const parts = selected.path.split('/').slice(0, -1);
            for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join('/'));
            return next;
          });
        setOpen(true);
        onMenuChange('scheduled-run-project', true);
      }}
      onMenuClose={close}
      aria-label="Project"
      aria-describedby="scheduled-run-project-help"
      options={options}
      value={selected}
      isDisabled={disabled}
      isSearchable
      menuIsOpen={open && !disabled}
      closeMenuOnSelect={false}
      inputValue={search}
      onInputChange={(text, meta) => {
        if (meta.action === 'input-change') setSearch(text);
      }}
      filterOption={() => true}
      menuPlacement="auto"
      classNamePrefix="scheduled-select"
      placeholder="Browse or search projects…"
      noOptionsMessage={() => 'No matching projects'}
      onChange={(option) => {
        if (!option || disabled) return;
        if (option.kind === 'folder') {
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(option.path)) next.delete(option.path);
            else next.add(option.path);
            return next;
          });
        } else {
          onChange(option.value);
          close();
        }
      }}
      formatOptionLabel={(option, { context }) => (
        <span className="scheduled-project-option" style={{ paddingLeft: context === 'menu' ? option.depth * 12 : 0 }}>
          {option.kind === 'folder' ? (
            <>
              <span aria-hidden="true">{option.expanded ? '▾' : '▸'}</span>
              <FolderIcon aria-hidden="true" />
            </>
          ) : (
            <FileIcon aria-hidden="true" />
          )}
          <span>
            <span className="scheduled-project-name">{option.label}</span>
            {option.kind === 'project' ? (
              <span className="scheduled-project-path" title={option.path}>
                {option.path}
              </span>
            ) : null}
          </span>
          {option.unavailable && context === 'value' ? <span className="scheduled-run-status">Missing</span> : null}
        </span>
      )}
    />
  );
}
