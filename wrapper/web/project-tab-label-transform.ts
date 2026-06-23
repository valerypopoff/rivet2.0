const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hostedProjectTabDisplayNameLine = "const projectDisplayName = project?.title?.trim() || 'Untitled Project';";
const hostedOpeningProjectTabDisplayNameLine = "const projectDisplayName = openingTab.title.trim() || 'Untitled Project';";
const upstreamProjectTabLabelVariants = [
  {
    lines: [
      "const fileName = unsaved ? 'Unsaved' : project.fsPath!.split('/').pop();",
      "const projectDisplayName = `${project?.title}${fileName ? ` [${fileName}]` : ''}`;",
    ],
    replacementLines: [hostedProjectTabDisplayNameLine],
  },
  {
    lines: [
      "const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();",
      'const active = projectTabsSelected && currentProject.metadata.id === projectId;',
      "const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
    ],
    replacementLines: [
      'const active = projectTabsSelected && currentProject.metadata.id === projectId;',
      hostedProjectTabDisplayNameLine,
    ],
  },
  {
    lines: [
      "const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();",
      'const active = projectTabsSelected && currentProject.metadata.id === projectId;',
      'const preview = projectTabUi[projectId]?.preview === true;',
      "const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
    ],
    replacementLines: [
      'const active = projectTabsSelected && currentProject.metadata.id === projectId;',
      'const preview = projectTabUi[projectId]?.preview === true;',
      hostedProjectTabDisplayNameLine,
    ],
  },
  {
    lines: [
      "const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();",
      'const active = projectTabsSelected && selectedOpeningProjectTabId == null && currentProject.metadata.id === projectId;',
      'const preview = projectTabUi[projectId]?.preview === true;',
      "const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
    ],
    replacementLines: [
      'const active = projectTabsSelected && selectedOpeningProjectTabId == null && currentProject.metadata.id === projectId;',
      'const preview = projectTabUi[projectId]?.preview === true;',
      hostedProjectTabDisplayNameLine,
    ],
  },
  {
    lines: [
      'const fileName = openingTab.path?.split(/[\\\\/]/).pop();',
      "const projectDisplayName = active ? `${openingTab.title}${fileName ? ` [${fileName}]` : ''}` : openingTab.title;",
    ],
    replacementLines: [hostedOpeningProjectTabDisplayNameLine],
  },
] as const;

const upstreamProjectTabLabelReplacements = upstreamProjectTabLabelVariants.map(({ lines, replacementLines }) => ({
  pattern: new RegExp(`^([ \\t]*)${lines.map(escapeRegExp).join('[ \\t]*\\r?\\n\\1')}[ \\t]*$`, 'm'),
  replacement: replacementLines.map((line) => `$1${line}`).join('\n'),
}));

export function replaceHostedProjectTabLabelExpression(code: string) {
  let updatedCode = code;

  for (const { pattern, replacement } of upstreamProjectTabLabelReplacements) {
    updatedCode = updatedCode.replace(pattern, replacement);
  }

  return updatedCode === code ? null : updatedCode;
}
