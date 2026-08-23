#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use tauri::LogicalSize;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::MenuItem;
use tauri::{AppHandle, InvokeError, Manager};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::{CustomMenuItem, Menu, Submenu};
#[cfg(target_os = "windows")]
use tauri_plugin_window_state::StateFlags;
mod evaluation_store;
mod plugins;

#[cfg(target_os = "windows")]
const WINDOWS_MIN_WINDOW_WIDTH: f64 = 800.0;
#[cfg(target_os = "windows")]
const WINDOWS_MIN_WINDOW_HEIGHT: f64 = 600.0;

fn main() {
    // Fix $PATH on MacOS and Linux to include the bashrc/zshrc
    if let Err(err) = fix_path_env::fix() {
        eprintln!("Error fixing $PATH: {}", err);
    }

    std::env::remove_var("_VOLTA_TOOL_RECURSION");

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(create_window_state_plugin_builder().build())
        .invoke_handler(tauri::generate_handler![
            get_environment_variable,
            evaluation_store::evaluation_store_get,
            evaluation_store::evaluation_store_set,
            evaluation_store::evaluation_store_delete,
            evaluation_store::evaluation_store_apply_batch,
            evaluation_store::evaluation_store_migration_completed,
            evaluation_store::evaluation_store_import_legacy,
            plugins::extract_package_plugin_tarball,
            allow_data_file_scope,
            read_relative_project_file
        ]);

    #[cfg(target_os = "macos")]
    let builder =
        builder
            .menu(create_macos_menu())
            .on_menu_event(|event| match event.menu_item_id() {
                "quit" => event.window().app_handle().exit(0),
                _ => {}
            });

    #[cfg(target_os = "linux")]
    let builder =
        builder
            .menu(create_linux_menu())
            .on_menu_event(|event| match event.menu_item_id() {
                "toggle_devtools" => {
                    if event.window().is_devtools_open() {
                        event.window().close_devtools();
                    } else {
                        event.window().open_devtools();
                    }
                }
                "quit" => event.window().app_handle().exit(0),
                _ => {}
            });

    builder
        .setup(|app| {
            if let Some(path) = app.path_resolver().app_local_data_dir() {
                app.fs_scope().allow_directory(path, true)?;
            }

            #[cfg(target_os = "windows")]
            configure_windows_frameless_window(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "windows")]
fn create_window_state_plugin_builder() -> tauri_plugin_window_state::Builder {
    let mut state_flags = StateFlags::all();
    state_flags.remove(StateFlags::DECORATIONS);

    tauri_plugin_window_state::Builder::default().with_state_flags(state_flags)
}

#[cfg(not(target_os = "windows"))]
fn create_window_state_plugin_builder() -> tauri_plugin_window_state::Builder {
    tauri_plugin_window_state::Builder::default()
}

#[cfg(target_os = "windows")]
fn configure_windows_frameless_window(app: &mut tauri::App) -> tauri::Result<()> {
    if let Some(window) = app.get_window("main") {
        window.set_min_size(Some(LogicalSize {
            width: WINDOWS_MIN_WINDOW_WIDTH,
            height: WINDOWS_MIN_WINDOW_HEIGHT,
        }))?;
        window.set_decorations(false)?;
    }

    Ok(())
}

#[tauri::command]
fn get_environment_variable(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

#[tauri::command]
fn allow_data_file_scope(
    app_handle: AppHandle,
    project_file_path: &str,
) -> Result<(), InvokeError> {
    let scope = app_handle.fs_scope();

    let folder_path = Path::new(project_file_path).parent().unwrap();
    let file_name_no_extension = Path::new(project_file_path)
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap();
    let data_file_path = folder_path.join(format!("{}.rivet-data", file_name_no_extension));

    scope.allow_file(&data_file_path)?;

    Ok(())
}

#[tauri::command]
fn read_relative_project_file(
    relative_from: &str,
    project_file_path: &str,
) -> Result<String, InvokeError> {
    let mut source_dir = PathBuf::from(relative_from);
    source_dir.pop();

    if project_file_path.ends_with(".rivet-project") == false {
        return Err(InvokeError::from("Invalid project file path"));
    }

    let full_path = source_dir.join(project_file_path);
    std::fs::read_to_string(full_path).map_err(|_| InvokeError::from("Failed to read file"))
}

#[cfg(target_os = "macos")]
fn create_macos_menu() -> Menu {
    let app_menu = Submenu::new(
        "App",
        Menu::new().add_item(CustomMenuItem::new("quit", "Exit")),
    );

    // macOS routes standard text-editing shortcuts through the native Edit
    // menu's first-responder actions. Keep Rivet commands in the in-app Menu,
    // but retain these system commands so focused Monaco and form editors own
    // Cmd+Z, Cmd+X, Cmd+C, Cmd+V, Cmd+A, and Cmd+Shift+Z.
    let edit_menu = Submenu::new(
        "Edit",
        Menu::new()
            .add_native_item(MenuItem::Undo)
            .add_native_item(MenuItem::Redo)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Cut)
            .add_native_item(MenuItem::Copy)
            .add_native_item(MenuItem::Paste)
            .add_native_item(MenuItem::SelectAll),
    );

    Menu::new().add_submenu(app_menu).add_submenu(edit_menu)
}

#[cfg(target_os = "linux")]
fn create_linux_menu() -> Menu {
    let about_menu = Submenu::new(
        "App",
        Menu::new()
            .add_native_item(MenuItem::Hide)
            .add_native_item(MenuItem::HideOthers)
            .add_native_item(MenuItem::ShowAll)
            .add_native_item(MenuItem::Separator)
            .add_item(CustomMenuItem::new("settings", "Settings..."))
            .add_native_item(MenuItem::Separator)
            .add_item(CustomMenuItem::new("quit", "Quit")),
    );

    let edit_menu = Submenu::new(
        "Edit",
        Menu::new()
            .add_native_item(MenuItem::Undo)
            .add_native_item(MenuItem::Redo)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Cut)
            .add_native_item(MenuItem::Copy)
            .add_native_item(MenuItem::Paste)
            .add_native_item(MenuItem::SelectAll),
    );

    let view_menu = Submenu::new(
        "View",
        Menu::new().add_native_item(MenuItem::EnterFullScreen),
    );

    let debug_menu = Submenu::new(
        "Debug",
        Menu::new()
            .add_item(
                CustomMenuItem::new("remote_debugger", "Remote Debugger...").accelerator("F5"),
            )
            .add_item(
                CustomMenuItem::new("load_recording", "Load Recording...")
                    .accelerator("CmdOrCtrl+Shift+O"),
            ),
    );

    let window_menu = Submenu::new(
        "Window",
        Menu::new()
            .add_native_item(MenuItem::Minimize)
            .add_native_item(MenuItem::Zoom),
    );

    let help_menu = Submenu::new(
        "Help",
        Menu::new()
            .add_item(CustomMenuItem::new("get_help", "Get Help"))
            .add_item(
                CustomMenuItem::new("toggle_devtools", "Toggle Developer Tools")
                    .accelerator("CmdOrCtrl+Shift+I"),
            ),
    );

    Menu::new()
        .add_submenu(about_menu)
        .add_submenu(Submenu::new(
            "File",
            Menu::new()
                .add_item(
                    CustomMenuItem::new("new_project", "New Project").accelerator("CmdOrCtrl+N"),
                )
                .add_native_item(MenuItem::Separator)
                .add_item(
                    CustomMenuItem::new("open_project", "Open Project...")
                        .accelerator("CmdOrCtrl+O"),
                )
                .add_native_item(MenuItem::Separator)
                .add_item(
                    CustomMenuItem::new("save_project", "Save Project").accelerator("CmdOrCtrl+S"),
                )
                .add_item(
                    CustomMenuItem::new("save_project_as", "Save Project As...")
                        .accelerator("CmdOrCtrl+Shift+S"),
                )
                .add_native_item(MenuItem::Separator)
                .add_item(
                    CustomMenuItem::new("export_graph", "Export Graph...")
                        .accelerator("CmdOrCtrl+Shift+E"),
                )
                .add_item(CustomMenuItem::new("import_graph", "Import Graph...")),
        ))
        .add_submenu(edit_menu)
        .add_submenu(Submenu::new(
            "Run",
            Menu::new()
                .add_item(CustomMenuItem::new("run", "Run Graph").accelerator("CmdOrCtrl+Enter"))
                .add_item(CustomMenuItem::new("clear_outputs", "Clear Outputs")),
        ))
        .add_submenu(view_menu)
        .add_submenu(debug_menu)
        .add_submenu(window_menu)
        .add_submenu(help_menu)
}
