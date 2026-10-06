import type { WorkflowProjectItem } from './types';

export type ScheduledProjectOption = {
  value: string;
  label: string;
  path: string;
  kind: 'folder' | 'project';
  depth: number;
  expanded?: boolean;
  unavailable?: boolean;
};

type ProjectChoice = Pick<WorkflowProjectItem, 'id' | 'name' | 'relativePath'>;
type Folder = { path: string; name: string; folders: Map<string, Folder>; projects: ProjectChoice[] };

// Match the Subgraph picker: folders toggle in place; search reveals descendants
// without changing the user's expansion state. No graph picker is needed here.
export function scheduledProjectOptions(
  projects: ReadonlyArray<ProjectChoice>,
  expanded: ReadonlySet<string>,
  search: string,
): ScheduledProjectOption[] {
  const root: Folder = { path: '', name: '', folders: new Map(), projects: [] };
  for (const project of projects) {
    const path = project.relativePath.replaceAll('\\', '/');
    let parent = root;
    for (const name of path.split('/').slice(0, -1)) {
      const folderPath = parent.path ? `${parent.path}/${name}` : name;
      let folder = parent.folders.get(name);
      if (!folder) {
        folder = { path: folderPath, name, folders: new Map(), projects: [] };
        parent.folders.set(name, folder);
      }
      parent = folder;
    }
    parent.projects.push({ ...project, relativePath: path });
  }
  const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;
  const query = search.trim().toLocaleLowerCase();
  const visit = (folder: Folder, depth: number): ScheduledProjectOption[] => {
    const options: ScheduledProjectOption[] = [];
    for (const child of [...folder.folders.values()].sort((a, b) => compare(a.name, b.name))) {
      const open = !!query || expanded.has(child.path);
      const children = open ? visit(child, depth + 1) : [];
      if (query && !children.length) continue;
      options.push({
        value: `folder:${child.path}`,
        label: child.name,
        path: child.path,
        kind: 'folder',
        depth,
        expanded: open,
      });
      if (open) options.push(...children);
    }
    for (const project of [...folder.projects].sort(
      (a, b) => compare(a.name, b.name) || compare(a.relativePath, b.relativePath),
    )) {
      if (query && !`${project.name} ${project.relativePath}`.toLocaleLowerCase().includes(query)) continue;
      options.push({ value: project.id, label: project.name, path: project.relativePath, kind: 'project', depth });
    }
    return options;
  };
  return visit(root, 0);
}
