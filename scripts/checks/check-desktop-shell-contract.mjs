import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tauriRoot = join(repoRoot, 'packages', 'app', 'src-tauri');
const config = JSON.parse(readFileSync(join(tauriRoot, 'tauri.conf.json'), 'utf8'));
const mainSource = readFileSync(join(tauriRoot, 'src', 'main.rs'), 'utf8');
const mainWindow = config.tauri?.windows?.[0];
const failures = [];

if (mainWindow?.minWidth !== 800 || mainWindow?.minHeight !== 600) {
  failures.push('the desktop main window minimum size must remain 800x600');
}
if (!/configure_windows_frameless_window\(app\)/.test(mainSource)) {
  failures.push('Windows must configure the custom frameless main window');
}

const macMenu = /#\[cfg\(target_os = "macos"\)\]\s+fn create_macos_menu\(\) -> Menu \{(?<body>[\s\S]*?)\n\}/.exec(
  mainSource,
)?.groups?.body;
if (!macMenu || !/CustomMenuItem::new\("quit", "Exit"\)/.test(macMenu)) {
  failures.push('macOS system menu must keep the Exit item');
}
if (macMenu && /"File"|"Edit"|"Run"|"Debug"|"Help"|"Window"/.test(macMenu)) {
  failures.push('macOS workflow commands belong in the in-app Menu, not the system menu');
}

if (failures.length > 0) {
  console.error('Desktop shell contract check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Desktop shell window and macOS menu contracts are valid.');
}
