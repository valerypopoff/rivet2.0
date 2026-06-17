import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

test('project top bar owns the graph tree sidebar toggle for the active project workspace', () => {
  const projectSelectorTsx = readFileSync(join(srcDir, 'ProjectSelector.tsx'), 'utf8');
  const leftSidebarTsx = readFileSync(join(srcDir, 'LeftSidebar.tsx'), 'utf8');
  const overlayTabsTsx = readFileSync(join(srcDir, 'OverlayTabs.tsx'), 'utf8');
  const noProjectTsx = readFileSync(join(srcDir, 'NoProject.tsx'), 'utf8');
  const rivetAppSource = readFileSync(join(srcDir, 'RivetApp.tsx'), 'utf8');
  const workspaceTransitionsSource = readFileSync(join(srcDir, '..', 'hooks', 'useWorkspaceTransitions.ts'), 'utf8');
  const setStaticDataSource = readFileSync(join(srcDir, '..', 'hooks', 'useSetStaticData.ts'), 'utf8');
  const savedGraphsSource = readFileSync(join(srcDir, '..', 'state', 'savedGraphs.ts'), 'utf8');
  const colorsCss = readFileSync(join(srcDir, '..', 'colors.css'), 'utf8');

  assert.match(
    projectSelectorTsx,
    /{projectTabsSelected && <GraphTreeSidebarToggle \/>}[\s\S]*{projectTabsSelected && <GraphHistoryControls \/>}[\s\S]*{reserveSidebarColumn && <div className="sidebar-panel-spacer" aria-hidden="true" \/>}[\s\S]*{showFileMenu && <ProjectFileMenu \/>}/,
  );
  assert.match(projectSelectorTsx, /const reserveSidebarColumn = projectTabsSelected && sidebarOpen;/);
  assert.match(
    projectSelectorTsx,
    /const showFileMenu = !isInTauri\(\) \|\| isWindowsPlatform\(\) \|\| isMacOSPlatform\(\);/,
  );
  assert.match(projectSelectorTsx, /const showWindowsWindowControls = isInTauri\(\) && isWindowsPlatform\(\);/);
  assert.match(projectSelectorTsx, /import RivetLogo from '\.\.\/rivet-2-logo-no-background\.svg';/);
  assert.match(projectSelectorTsx, /className={clsx\(\{ 'graph-tree-open': reserveSidebarColumn \}\)}/);
  assert.match(projectSelectorTsx, /--project-selector-strip-bg: var\(--grey-dark-colorish\);/);
  assert.doesNotMatch(colorsCss, new RegExp('blu' + 'ish'));
  assert.match(colorsCss, /--neutral-grey-darker: #303030;/);
  assert.match(
    colorsCss,
    /--grey-darker: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--neutral-grey-darker\) [^)]+\);/,
  );
  assert.match(
    colorsCss,
    /--grey-dark: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--neutral-grey-dark\) [^)]+\);/,
  );
  assert.match(
    colorsCss,
    /--grey-darkish: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--neutral-grey-darkish\) [^)]+\);/,
  );
  assert.match(
    colorsCss,
    /--grey-dark-colorish: color-mix\(in srgb, var\(--secondary\) [^,]+, (?:var\(--neutral-grey-darker\)|rgb\(35, 35, 35\)) [^)]+\);/,
  );
  assert.match(
    colorsCss,
    /--grey-dark-colorish-seethrough: color-mix\(in srgb, var\(--secondary\) [^,]+, rgba\(35, 35, 35, 0\.95\) [^)]+\);/,
  );
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*\.app\.theme-bright \{/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--neutral-grey-darkest: #ffffff;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--foreground: #1d2733;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--foreground-muted: #1d2733;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--foreground-disabled: #708092;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--label-color: #1d2733;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--canvas-background-pattern-rgb: 0, 0, 0;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--settings-range-track-bg: #8090a3;/);
  assert.match(colorsCss, /--rivet-logo-filter: none;/);
  assert.match(colorsCss, /--rivet-logo-opacity: 0\.95;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--rivet-logo-filter: brightness\(0\);/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--rivet-logo-opacity: 1;/);
  assert.match(colorsCss, /--custom-theme-primary: rgba\(255, 153, 0, 1\);/);
  assert.match(colorsCss, /--custom-theme-secondary: var\(--custom-theme-primary\);/);
  assert.match(colorsCss, /:root\.theme-custom,[\s\S]*\.app\.theme-custom \{[\s\S]*--primary: var\(--custom-theme-primary\);/);
  assert.match(colorsCss, /:root\.theme-custom,[\s\S]*\.app\.theme-custom \{[\s\S]*--secondary: var\(--custom-theme-secondary\);/);
  assert.match(
    colorsCss,
    /:root\.theme-custom,[\s\S]*\.app\.theme-custom \{[\s\S]*--primary-dark: color-mix\(in srgb, var\(--custom-theme-primary\) 80%, black 20%\);/,
  );
  assert.match(rivetAppSource, /customThemePrimaryColorState/);
  assert.match(rivetAppSource, /customThemeSecondaryColorState/);
  assert.match(rivetAppSource, /primaryColor: customThemePrimaryColor/);
  assert.match(rivetAppSource, /secondaryColor: customThemeSecondaryColor/);
  assert.match(rivetAppSource, /rootStyle\.setProperty\(name, value\);/);
  assert.match(projectSelectorTsx, /background: var\(--project-selector-strip-bg\);/);
  assert.match(
    projectSelectorTsx,
    /--project-selector-divider-color: color-mix\(in srgb, var\(--grey-light\) 18%, var\(--project-selector-strip-bg\) 82%\);/,
  );
  assert.match(projectSelectorTsx, /&::after \{[\s\S]*left: 0;[\s\S]*right: 0;/);
  assert.match(projectSelectorTsx, /&::after \{[\s\S]*z-index: 2;/);
  assert.match(projectSelectorTsx, /&::after \{[\s\S]*background: var\(--grey-darkish\);/);
  assert.match(projectSelectorTsx, /> \* \{[\s\S]*position: relative;[\s\S]*z-index: 1;/);
  assert.match(projectSelectorTsx, /&\.graph-tree-open::after \{\s+left: var\(--left-sidebar-width\);/);
  assert.match(
    projectSelectorTsx,
    /&\.graph-tree-open \.sidebar-panel-spacer \{[\s\S]*background: var\(--project-selector-strip-bg\);/,
  );
  assert.match(
    projectSelectorTsx,
    /&\.graph-tree-open \.sidebar-toggle-menu:hover,[\s\S]*&\.graph-tree-open \.graph-history-menu:not\(\.disabled\):hover \{[\s\S]*--project-tab-current-bg: var\(--project-tab-hover-bg\);/,
  );
  assert.match(projectSelectorTsx, /aria-controls="graph-tree-sidebar"/);
  assert.match(projectSelectorTsx, /aria-expanded={sidebarOpen}/);
  assert.match(projectSelectorTsx, /const actionLabel = sidebarOpen \? 'Collapse graph tree' : 'Expand graph tree';/);
  assert.match(
    projectSelectorTsx,
    /const actionTitle = `\$\{actionLabel\} \(\$\{GRAPH_TREE_TOGGLE_SHORTCUT_LABEL\}\)`;/,
  );
  assert.match(projectSelectorTsx, /aria-label={actionLabel}/);
  assert.match(
    projectSelectorTsx,
    /<Tooltip content={actionTitle} placement="bottom" className="sidebar-toggle-tooltip">/,
  );
  assert.match(projectSelectorTsx, /\.sidebar-toggle-tooltip {\s+display: flex;\s+width: 100%;\s+height: 100%;/);
  assert.doesNotMatch(projectSelectorTsx, /title={actionTitle}/);
  assert.match(projectSelectorTsx, /const GraphTreeSidebarIcon: FC<{ sidebarOpen: boolean }>/);
  assert.match(projectSelectorTsx, /<rect x="2\.75" y="3\.5" width="10\.5" height="9" rx="1\.25"/);
  assert.match(projectSelectorTsx, /d={sidebarOpen \? 'M5\.25 4\.75v6\.5' : 'M7\.25 4\.75v6\.5'}/);
  assert.match(projectSelectorTsx, /const GraphHistoryControls: FC = \(\) => {/);
  assert.match(projectSelectorTsx, /<GraphHistoryButton[\s\S]*?disabled={!navigationStack\.hasBackward}/);
  assert.match(projectSelectorTsx, /<GraphHistoryButton[\s\S]*?disabled={!navigationStack\.hasForward}/);
  assert.match(projectSelectorTsx, /tooltip={GRAPH_HISTORY_PREVIOUS_TOOLTIP}/);
  assert.match(projectSelectorTsx, /tooltip={GRAPH_HISTORY_NEXT_TOOLTIP}/);
  assert.match(projectSelectorTsx, /<button[\s\S]*?aria-label={label}[\s\S]*?disabled={disabled}/);
  assert.match(projectSelectorTsx, /onClick={disabled \? undefined : onClick}/);
  assert.match(
    projectSelectorTsx,
    /flex: 0 0 max\(0px, calc\(var\(--left-sidebar-width\) - var\(--top-bar-left-controls-width\)\)\);/,
  );
  assert.doesNotMatch(projectSelectorTsx, /no-left-controls/);
  assert.doesNotMatch(projectSelectorTsx, /\.project[\s\S]*?border-bottom:/);
  const sidebarToggleStyles = projectSelectorTsx.match(/\.sidebar-toggle-menu \{(?<styles>[\s\S]*?)\n  \}/)
    ?.groups?.styles;
  const graphHistoryStyles = projectSelectorTsx.match(
    /\.graph-history-menu \{(?<styles>[\s\S]*?)\n  \.sidebar-toggle-tooltip/,
  )?.groups?.styles;
  assert.ok(sidebarToggleStyles);
  assert.ok(graphHistoryStyles);
  assert.doesNotMatch(sidebarToggleStyles, /border-right:/);
  assert.doesNotMatch(graphHistoryStyles, /border-right:/);
  assert.match(
    projectSelectorTsx,
    /\.sidebar-toggle-menu,\s+\.graph-history-menu \{[\s\S]*--project-tab-bg: var\(--project-selector-strip-bg\);[\s\S]*background: var\(--project-tab-current-bg\);[\s\S]*border-radius: 7px;[\s\S]*height: calc\(100% - 9px\);[\s\S]*margin: 4px 0 5px;/,
  );
  assert.match(
    projectSelectorTsx,
    /\.sidebar-toggle-menu:hover,[\s\S]*\.graph-history-menu:not\(\.disabled\):hover,[\s\S]*\.file-menu:hover,[\s\S]*\.file-menu\.open \{[\s\S]*--project-tab-current-bg: var\(--project-tab-hover-bg\);/,
  );
  assert.doesNotMatch(graphHistoryStyles, /opacity: 0\.45;/);
  assert.doesNotMatch(graphHistoryStyles, /\.disabled[\s\S]*background:/);
  assert.match(projectSelectorTsx, /\.graph-history-button \{[\s\S]*&:disabled \{[\s\S]*opacity: 0\.45;/);
  assert.match(projectSelectorTsx, /{showWindowsWindowControls && <WindowsWindowDragRegion \/>}/);
  assert.match(projectSelectorTsx, /{showWindowsWindowControls && <WindowsWindowControls \/>}/);
  assert.match(projectSelectorTsx, /\.projects-container\.empty\.with-window-drag-region \{[\s\S]*flex: 1 1 auto;/);
  assert.match(projectSelectorTsx, /\.window-drag-region \{[\s\S]*flex: 1 0 40px;/);
  assert.match(projectSelectorTsx, /\.windows-window-control \{[\s\S]*width: 46px;/);
  assert.match(projectSelectorTsx, /\.windows-window-control \{[\s\S]*border-radius: 0;/);
  assert.match(projectSelectorTsx, /\.windows-window-control \{[\s\S]*&\.close-window:hover \{[\s\S]*background: #c42b1c;/);
  assert.match(projectSelectorTsx, /const \[isWindowMaximized, setIsWindowMaximized\] = useState\(false\);/);
  assert.match(projectSelectorTsx, /appWindow\?\.listen\?\.\('tauri:\/\/resize'/);
  assert.match(projectSelectorTsx, /isWindowMaximized \? <RestoreWindowIcon \/> : <MaximizeWindowIcon \/>/);
  assert.match(projectSelectorTsx, /d="M5\.25 3\.25h7\.5v7\.5M3\.25 5\.25h8\.5v8\.5h-8\.5z"/);
  const fileMenuStyles = [...projectSelectorTsx.matchAll(/\n  \.file-menu \{(?<styles>[\s\S]*?)\n  \}/g)]
    .map((match) => match.groups?.styles ?? '')
    .find((styles) => styles.includes('--project-tab-bg'));
  assert.ok(fileMenuStyles);
  assert.doesNotMatch(fileMenuStyles, /border-left:/);
  assert.doesNotMatch(fileMenuStyles, /border-right:/);
  assert.match(fileMenuStyles, /--project-tab-bg: var\(--project-selector-strip-bg\);/);
  assert.match(fileMenuStyles, /background: var\(--project-tab-current-bg\);/);
  assert.match(fileMenuStyles, /border-radius: 7px;/);
  assert.match(fileMenuStyles, /height: calc\(100% - 9px\);/);
  assert.match(fileMenuStyles, /margin: 4px 0 5px;/);
  assert.match(
    projectSelectorTsx,
    /\.file-menu:not\(:hover\):not\(\.open\):has\([\s\S]*\+ \.projects-container \.draggableProject:first-child \.project:not\(\.active\):not\(:hover\)[\s\S]*\)::after \{[\s\S]*right: -2px;/,
  );
  assert.match(projectSelectorTsx, /\.file-menu:hover,[\s\S]*\.file-menu\.open \{[\s\S]*--project-tab-current-bg: var\(--project-tab-hover-bg\);/);
  assert.match(projectSelectorTsx, /\.file-menu-button \{[\s\S]*padding: 0 10px;/);
  assert.match(
    projectSelectorTsx,
    /\.file-menu-logo \{[\s\S]*filter: var\(--rivet-logo-filter\);[\s\S]*height: 14px;[\s\S]*opacity: var\(--rivet-logo-opacity\);[\s\S]*width: 16px;/,
  );
  assert.match(noProjectTsx, /\.logo \{[\s\S]*filter: var\(--rivet-logo-filter\);[\s\S]*width: 92px;/);
  assert.match(projectSelectorTsx, /\.projects \{[\s\S]*align-items: flex-end;/);
  assert.match(projectSelectorTsx, /\.projects \{[\s\S]*padding: 4px 10px 0 4px;/);
  assert.match(projectSelectorTsx, /\.projects-container \{[\s\S]*z-index: 3;/);
  assert.match(projectSelectorTsx, /\.file-menu\.open \{[\s\S]*z-index: 10;/);
  assert.match(projectSelectorTsx, /\.file-dropdown \{[\s\S]*z-index: 1000;/);
  assert.match(projectSelectorTsx, /\.draggableProject \{[\s\S]*align-items: flex-start;/);
  assert.match(projectSelectorTsx, /\.draggableProject \{[\s\S]*position: relative;/);
  assert.match(
    projectSelectorTsx,
    /\.draggableProject::after \{[\s\S]*background: var\(--project-selector-divider-color\);/,
  );
  assert.match(projectSelectorTsx, /\.draggableProject::after \{[\s\S]*height: 18px;/);
  assert.match(projectSelectorTsx, /\.draggableProject::after \{[\s\S]*right: -2px;/);
  assert.match(projectSelectorTsx, /\.draggableProject::after \{[\s\S]*top: calc\(50% - 2px\);/);
  assert.match(projectSelectorTsx, /\.draggableProject::after \{[\s\S]*transform: translateY\(-50%\);/);
  assert.match(projectSelectorTsx, /\.draggableProject::after \{[\s\S]*z-index: 3;/);
  assert.match(projectSelectorTsx, /\.draggableProject:last-child::after,/);
  assert.match(projectSelectorTsx, /\.draggableProject:has\(\.project\.active\)::after,/);
  assert.match(projectSelectorTsx, /\.draggableProject:has\(\.project:hover\)::after,/);
  assert.match(projectSelectorTsx, /\.draggableProject:has\(\+ \.draggableProject \.project:hover\)::after,/);
  assert.match(projectSelectorTsx, /\.draggableProject:has\(\+ \.draggableProject \.project\.active\)::after \{[\s\S]*display: none;/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*--project-tab-bg: var\(--project-selector-strip-bg\);/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*--project-tab-hover-bg: var\(--project-tab-active-bg\);/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*--project-tab-current-bg: var\(--project-tab-bg\);/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*background: var\(--project-tab-current-bg\);/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*gap: 0;/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*height: calc\(100% - 5px\);/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*margin-bottom: 5px;/);
  assert.match(projectSelectorTsx, /\.project \{[\s\S]*border-radius: 7px;/);
  assert.doesNotMatch(projectSelectorTsx, /\.project \{[\s\S]*border-left: 1px solid var\(--grey-darkest\);/);
  assert.match(projectSelectorTsx, /&:hover \{[\s\S]*--project-tab-current-bg: var\(--project-tab-hover-bg\);/);
  assert.match(projectSelectorTsx, /&::before,[\s\S]*&::after \{[\s\S]*display: none;/);
  assert.match(projectSelectorTsx, /&::before,[\s\S]*&::after \{[\s\S]*height: var\(--project-tab-shoulder-size\);/);
  assert.match(projectSelectorTsx, /&::before \{[\s\S]*radial-gradient\([\s\S]*circle at 0 0/);
  assert.match(projectSelectorTsx, /&::after \{[\s\S]*radial-gradient\([\s\S]*circle at 100% 0/);
  assert.match(projectSelectorTsx, /&\.active \{[\s\S]*--project-tab-current-bg: var\(--project-tab-active-bg\);/);
  assert.match(projectSelectorTsx, /&\.active \{[\s\S]*align-self: flex-end;/);
  assert.match(projectSelectorTsx, /&\.active \{[\s\S]*border-radius: 8px 8px 0 0;/);
  assert.match(projectSelectorTsx, /&\.active \{[\s\S]*gap: 8px;/);
  assert.match(projectSelectorTsx, /&\.active \{[\s\S]*height: 100%;/);
  assert.match(projectSelectorTsx, /&\.active \{[\s\S]*margin-bottom: 0;/);
  assert.match(projectSelectorTsx, /&\.active::before,[\s\S]*&\.active::after \{[\s\S]*display: block;/);
  assert.doesNotMatch(projectSelectorTsx, /&\.active \{[\s\S]*background-color: var\(--primary\);/);
  assert.ok(projectSelectorTsx.includes("const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();"));
  assert.match(projectSelectorTsx, /const active = projectTabsSelected && currentProject\.metadata\.id === projectId;/);
  assert.ok(
    projectSelectorTsx.includes(
      "const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
    ),
  );
  assert.match(
    projectSelectorTsx,
    /className={clsx\('project', \{ active, unsaved, 'has-unsaved-changes': hasUnsavedChanges \}\)}/,
  );
  assert.match(
    projectSelectorTsx,
    /const hasUnsavedChanges =[\s\S]*projectUnsavedChanges\[projectId\] === true \|\| projectDataUnsavedChanges\[projectId\] === true;/,
  );
  assert.match(projectSelectorTsx, /&\.has-unsaved-changes \.project-name::before \{[\s\S]*display: block;/);
  assert.match(
    savedGraphsSource,
    /export const savedProjectContentDigestsState = atom<Record<ProjectId, string \| undefined>>\(\{\}\);/,
  );
  assert.match(
    savedGraphsSource,
    /export const projectUnsavedChangesState = atom<Record<ProjectId, boolean \| undefined>>\(\{\}\);/,
  );
  assert.match(
    savedGraphsSource,
    /export const projectDataUnsavedChangesState = atom<Record<ProjectId, boolean \| undefined>>\(\{\}\);/,
  );
  assert.doesNotMatch(savedGraphsSource, /projectUnsavedChangesState = atomWithStorage/);
  assert.match(
    workspaceTransitionsSource,
    /if \(projectInfo\.markClean\) \{[\s\S]*markProjectClean\([\s\S]*project: projectInfo\.project,[\s\S]*markProjectDirtyFlag\(previousFlags, targetProjectId, false\)[\s\S]*\}\s+setProject\(transition\.project\);/,
  );
  assert.match(workspaceTransitionsSource, /markClean\?: boolean;/);
  const syncOpenedProjectsSource = readFileSync(
    join(srcDir, '..', 'hooks', 'useSyncCurrentStateIntoOpenedProjects.ts'),
    'utf8',
  );
  assert.match(
    syncOpenedProjectsSource,
    /if \(!savedDigest\) \{[\s\S]*markProjectClean\(previousDigests, snapshot\)[\s\S]*markProjectDirtyFlag\(previousFlags, currentProject\.metadata\.id, false\)[\s\S]*return;/,
  );
  assert.doesNotMatch(
    syncOpenedProjectsSource,
    /markProjectDirtyFlag\(previousFlags, currentProject\.metadata\.id, !loadedProject\.path\)/,
  );
  assert.match(
    syncOpenedProjectsSource,
    /const currentDigest = getProjectContentDigest\(snapshot\);[\s\S]*const isDirty = currentDigest !== savedDigest;[\s\S]*markProjectDirtyFlag\(previousFlags, currentProject\.metadata\.id, isDirty\)/,
  );
  assert.match(
    setStaticDataSource,
    /markProjectDirtyFlag\(previousFlags, currentProject\.metadata\.id, true\)/,
  );
  assert.doesNotMatch(
    syncOpenedProjectsSource,
    /if \(previousFlags\[currentProject\.metadata\.id\]\) \{\s+return previousFlags;\s+\}/,
  );
  assert.match(projectSelectorTsx, /&:not\(\.active\) > \.actions \{[\s\S]*display: none;/);
  assert.match(projectSelectorTsx, /{active && \(\s*<div className="actions">/);
  assert.match(overlayTabsTsx, /background: var\(--project-selector-strip-bg, var\(--grey-dark-colorish\)\);/);
  assert.match(projectSelectorTsx, /<img src={RivetLogo} alt="" aria-hidden="true" className="file-menu-logo" \/>/);
  assert.match(projectSelectorTsx, />\s*Menu\s*<\/button>/);
  assert.doesNotMatch(projectSelectorTsx, />\s*File\s*<\/button>/);
  assert.doesNotMatch(projectSelectorTsx, /\.project::after \{[\s\S]*width: 1px;/);
  assert.doesNotMatch(overlayTabsTsx, /\.menu-item[\s\S]*?border-bottom:/);
  assert.doesNotMatch(overlayTabsTsx, /z-index: 200;/);
  assert.match(overlayTabsTsx, /border-left: 1px solid var\(--project-selector-divider-color, var\(--grey-darkest\)\);/);
  assert.match(overlayTabsTsx, /\.menu-item \{[\s\S]*border-right: 1px solid var\(--project-selector-divider-color, var\(--grey-darkest\)\);/);
  assert.match(leftSidebarTsx, /id="graph-tree-sidebar"/);
  assert.match(leftSidebarTsx, /border-right: 1px solid var\(--grey-darkish\);/);
  assert.match(leftSidebarTsx, /shouldCollapseLeftSidebarDrag\(rawWidth\)/);
  assert.match(leftSidebarTsx, /\{\(sidebarOpen \|\| isResizing\) && \(/);
  assert.match(
    leftSidebarTsx,
    /if \(resizeSidebarOpenRef\.current\) {\s+setPersistedSidebarWidth\(liveSidebarWidthRef\.current\);\s+} else {\s+setLiveSidebarWidth\(clampLeftSidebarWidth\(persistedSidebarWidth\)\);/,
  );
  assert.doesNotMatch(leftSidebarTsx, /SIDEBAR_TRANSITION_EASING|transition:.*transform/);
  assert.doesNotMatch(leftSidebarTsx, /toggle-tab|menu-expand-left-line|menu-expand-right-line/);
});

test('windows and macos desktop use the in-strip Menu dropdown instead of a full native Tauri menubar', () => {
  const projectSelectorTsx = readFileSync(join(srcDir, 'ProjectSelector.tsx'), 'utf8');
  const platformOsSource = readFileSync(join(srcDir, '..', 'utils', 'platform', 'os.ts'), 'utf8');
  const platformCoreSource = readFileSync(join(srcDir, '..', 'utils', 'platform', 'core.ts'), 'utf8');
  const inAppMenuHotkeysSource = readFileSync(join(srcDir, '..', 'hooks', 'useInAppMenuHotkeys.tsx'), 'utf8');
  const rivetAppSource = readFileSync(join(srcDir, 'RivetApp.tsx'), 'utf8');
  const tauriMainSource = readFileSync(join(srcDir, '..', '..', 'src-tauri', 'src', 'main.rs'), 'utf8');
  const windowStatePluginSource = readFileSync(
    join(srcDir, '..', '..', 'src-tauri', 'vendor', 'tauri-plugin-window-state', 'src', 'lib.rs'),
    'utf8',
  );
  const tauriConfig = JSON.parse(readFileSync(join(srcDir, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));

  assert.match(
    projectSelectorTsx,
    /import \{ isMacOSPlatform, isWindowsPlatform \} from '\.\.\/utils\/platform\/os\.js';/,
  );
  assert.match(platformOsSource, /export function isMacOSPlatform\(\): boolean/);
  assert.match(platformOsSource, /Macintosh\|MacIntel\|MacPPC\|Mac68K\|Mac OS X/);
  assert.match(projectSelectorTsx, /import \{ getAppWindowHandle \} from '\.\.\/utils\/platform\/window\.js';/);
  assert.match(
    projectSelectorTsx,
    /const showFileMenu = !isInTauri\(\) \|\| isWindowsPlatform\(\) \|\| isMacOSPlatform\(\);/,
  );
  assert.match(projectSelectorTsx, /const showWindowsWindowControls = isInTauri\(\) && isWindowsPlatform\(\);/);
  assert.match(projectSelectorTsx, /const WindowsWindowControls: FC = \(\) => \{/);
  assert.match(projectSelectorTsx, /appWindow\.minimize\?\.\(\)/);
  assert.match(projectSelectorTsx, /appWindow\.toggleMaximize\?\.\(\)/);
  assert.match(projectSelectorTsx, /appWindow\.isMaximized\?\.\(\)/);
  assert.match(projectSelectorTsx, /appWindow\.close\(\)/);
  assert.match(projectSelectorTsx, /appWindow\?\.startDragging\?\.\(\)/);
  assert.match(projectSelectorTsx, /event\.detail > 1/);
  assert.match(projectSelectorTsx, /onDoubleClick={toggleMaximize}/);
  assert.match(platformCoreSource, /minimize\?\(\): Promise<void>;/);
  assert.match(platformCoreSource, /startDragging\?\(\): Promise<void>;/);
  assert.match(platformCoreSource, /toggleMaximize\?\(\): Promise<void>;/);
  assert.match(platformCoreSource, /isMaximized\?\(\): Promise<boolean>;/);
  assert.match(platformCoreSource, /listen\?<T = unknown>\(event: string, handler: \(event: \{ payload: T \}\) => void\): Promise<NativeWindowListener>;/);
  assert.match(
    inAppMenuHotkeysSource,
    /import \{ isMacOSPlatform, isWindowsPlatform \} from '\.\.\/utils\/platform\/os\.js';/,
  );
  assert.match(inAppMenuHotkeysSource, /import \{ isInTauri \} from '\.\.\/utils\/tauri\.js';/);
  assert.match(
    inAppMenuHotkeysSource,
    /const shouldUseInAppMenuHotkeys = isWindowsPlatform\(\) \|\| \(isInTauri\(\) && isMacOSPlatform\(\)\);/,
  );
  assert.match(inAppMenuHotkeysSource, /__rivetInAppMenuHotkeysCleanup/);
  assert.match(inAppMenuHotkeysSource, /'CmdOrCtrl\+S': 'save_project'/);
  assert.match(inAppMenuHotkeysSource, /'CmdOrCtrl\+ENTER': 'run'/);
  assert.match(inAppMenuHotkeysSource, /window\.addEventListener\('keydown', onKeyDown, hotkeyListenerOptions\)/);
  assert.doesNotMatch(inAppMenuHotkeysSource, /Hotkey Fix|Fix applied for Windows platform/);
  assert.match(rivetAppSource, /import \{ useInAppMenuHotkeys \} from '\.\.\/hooks\/useInAppMenuHotkeys';/);
  assert.match(rivetAppSource, /useInAppMenuHotkeys\(\);/);
  assert.match(
    tauriMainSource,
    /#\[cfg\(any\(target_os = "linux", target_os = "macos"\)\)\]\s+use tauri::\{CustomMenuItem, Menu, Submenu\};/,
  );
  assert.match(tauriMainSource, /#\[cfg\(target_os = "linux"\)\]\s+use tauri::MenuItem;/);
  assert.match(tauriMainSource, /#\[cfg\(target_os = "windows"\)\]\s+use tauri_plugin_window_state::StateFlags;/);
  assert.match(tauriMainSource, /\.plugin\(create_window_state_plugin_builder\(\)\.build\(\)\)/);
  assert.match(tauriMainSource, /#\[cfg\(target_os = "windows"\)\]\s+configure_windows_frameless_window\(app\)\?;/);
  assert.match(tauriMainSource, /state_flags\.remove\(StateFlags::DECORATIONS\);/);
  assert.match(tauriMainSource, /fn configure_windows_frameless_window\(app: &mut tauri::App\) -> tauri::Result<\(\)>/);
  assert.match(tauriMainSource, /const WINDOWS_MIN_WINDOW_WIDTH: f64 = 800\.0;/);
  assert.match(tauriMainSource, /const WINDOWS_MIN_WINDOW_HEIGHT: f64 = 600\.0;/);
  assert.match(tauriMainSource, /window\.set_min_size\(Some\(LogicalSize \{\s+width: WINDOWS_MIN_WINDOW_WIDTH,\s+height: WINDOWS_MIN_WINDOW_HEIGHT,\s+\}\)\)\?;/);
  assert.match(tauriMainSource, /window\.set_decorations\(false\)\?;/);
  assert.equal(tauriConfig.tauri.windows[0].minWidth, 800);
  assert.equal(tauriConfig.tauri.windows[0].minHeight, 600);
  assert.match(windowStatePluginSource, /const MAIN_WINDOW_LABEL: &str = "main";/);
  assert.match(windowStatePluginSource, /const MIN_RESTORED_MAIN_WINDOW_WIDTH: f64 = 800\.0;/);
  assert.match(windowStatePluginSource, /const MIN_RESTORED_MAIN_WINDOW_HEIGHT: f64 = 600\.0;/);
  assert.match(windowStatePluginSource, /fn clamp_restored_window_size\(label: &str, width: f64, height: f64\) -> \(f64, f64\)/);
  assert.match(windowStatePluginSource, /let restored_size = clamp_restored_window_size\(self\.label\(\), state\.width, state\.height\);/);
  assert.match(windowStatePluginSource, /width: restored_size\.0,[\s\S]*height: restored_size\.1,/);
  assert.match(
    tauriMainSource,
    /#\[cfg\(target_os = "macos"\)\]\s+let builder =\s+builder[\s\S]*?\.menu\(create_macos_menu\(\)\)[\s\S]*?\.on_menu_event/,
  );
  assert.match(
    tauriMainSource,
    /#\[cfg\(target_os = "linux"\)\]\s+let builder =\s+builder[\s\S]*?\.menu\(create_linux_menu\(\)\)[\s\S]*?\.on_menu_event/,
  );
  assert.match(tauriMainSource, /#\[cfg\(target_os = "macos"\)\]\s+fn create_macos_menu\(\) -> Menu/);
  assert.match(tauriMainSource, /#\[cfg\(target_os = "linux"\)\]\s+fn create_linux_menu\(\) -> Menu/);

  const macosMenuFunction = tauriMainSource.match(
    /#\[cfg\(target_os = "macos"\)\]\s+fn create_macos_menu\(\) -> Menu \{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body;
  assert.ok(macosMenuFunction);
  assert.match(macosMenuFunction, /CustomMenuItem::new\("quit", "Exit"\)/);
  assert.doesNotMatch(
    macosMenuFunction,
    /"File"|"Edit"|"Run"|"Debug"|"Help"|"Window"|new_project|open_project|save_project|settings|remote_debugger|toggle_devtools/,
  );
});
