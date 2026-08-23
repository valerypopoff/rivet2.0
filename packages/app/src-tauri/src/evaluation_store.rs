use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

const DATABASE_FILE: &str = "evaluations.sqlite3";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationStoreEntry {
    key: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationStoreBatchCheck {
    key: String,
    expected: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum EvaluationStoreBatchMutation {
    Set { key: String, value: String },
    Delete { key: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationStoreBatch {
    checks: Vec<EvaluationStoreBatchCheck>,
    mutations: Vec<EvaluationStoreBatchMutation>,
}

fn database_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let directory = app_handle
        .path_resolver()
        .app_local_data_dir()
        .ok_or_else(|| {
            "The operating system did not provide an application data directory.".to_string()
        })?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create the application data directory: {}", error))?;
    Ok(directory.join(DATABASE_FILE))
}

fn open_database(app_handle: &AppHandle) -> Result<Connection, String> {
    let connection = Connection::open(database_path(app_handle)?)
        .map_err(|error| format!("Failed to open the evaluation database: {}", error))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Failed to configure the evaluation database: {}", error))?;
    initialize_database(&connection)?;
    Ok(connection)
}

fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS evaluation_values (
               key TEXT PRIMARY KEY NOT NULL,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS evaluation_meta (
               key TEXT PRIMARY KEY NOT NULL,
               value TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("Failed to initialize the evaluation database: {}", error))
}

#[tauri::command]
pub fn evaluation_store_get(app_handle: AppHandle, key: String) -> Result<Option<String>, String> {
    open_database(&app_handle)?
        .query_row(
            "SELECT value FROM evaluation_values WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read the evaluation database: {}", error))
}

#[tauri::command]
pub fn evaluation_store_set(
    app_handle: AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    open_database(&app_handle)?
        .execute(
            "INSERT INTO evaluation_values(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map(|_| ())
        .map_err(|error| format!("Failed to write the evaluation database: {}", error))
}

#[tauri::command]
pub fn evaluation_store_delete(app_handle: AppHandle, key: String) -> Result<(), String> {
    open_database(&app_handle)?
        .execute("DELETE FROM evaluation_values WHERE key = ?1", params![key])
        .map(|_| ())
        .map_err(|error| format!("Failed to update the evaluation database: {}", error))
}

#[tauri::command]
pub fn evaluation_store_apply_batch(
    app_handle: AppHandle,
    input: EvaluationStoreBatch,
) -> Result<bool, String> {
    let mut connection = open_database(&app_handle)?;
    apply_batch(&mut connection, &input)
}

fn apply_batch(connection: &mut Connection, input: &EvaluationStoreBatch) -> Result<bool, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start evaluation transaction: {}", error))?;
    for check in &input.checks {
        let actual: Option<String> = transaction
            .query_row(
                "SELECT value FROM evaluation_values WHERE key = ?1",
                params![check.key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Failed to verify evaluation transaction: {}", error))?;
        if actual != check.expected {
            return Ok(false);
        }
    }
    for mutation in &input.mutations {
        match mutation {
            EvaluationStoreBatchMutation::Set { key, value } => {
                transaction
                    .execute(
                        "INSERT INTO evaluation_values(key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![key, value],
                    )
                    .map_err(|error| {
                        format!("Failed to write evaluation transaction: {}", error)
                    })?;
            }
            EvaluationStoreBatchMutation::Delete { key } => {
                transaction
                    .execute("DELETE FROM evaluation_values WHERE key = ?1", params![key])
                    .map_err(|error| {
                        format!("Failed to update evaluation transaction: {}", error)
                    })?;
            }
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit evaluation transaction: {}", error))?;
    Ok(true)
}

#[tauri::command]
pub fn evaluation_store_migration_completed(
    app_handle: AppHandle,
    migration_id: String,
) -> Result<bool, String> {
    migration_completed(&open_database(&app_handle)?, &migration_id)
}

fn migration_completed(connection: &Connection, migration_id: &str) -> Result<bool, String> {
    let value: Option<String> = connection
        .query_row(
            "SELECT value FROM evaluation_meta WHERE key = ?1",
            params![migration_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read evaluation migration state: {}", error))?;
    Ok(value.as_deref() == Some("complete"))
}

#[tauri::command]
pub fn evaluation_store_import_legacy(
    app_handle: AppHandle,
    migration_id: String,
    entries: Vec<EvaluationStoreEntry>,
) -> Result<(), String> {
    let mut connection = open_database(&app_handle)?;
    import_legacy(&mut connection, &migration_id, &entries)
}

fn import_legacy(
    connection: &mut Connection,
    migration_id: &str,
    entries: &[EvaluationStoreEntry],
) -> Result<(), String> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start evaluation migration: {}", error))?;
    let already_complete: Option<String> = transaction
        .query_row(
            "SELECT value FROM evaluation_meta WHERE key = ?1",
            params![migration_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Failed to read evaluation migration state: {}", error))?;
    if already_complete.as_deref() == Some("complete") {
        return Ok(());
    }

    for entry in entries {
        transaction
            .execute(
                "INSERT OR IGNORE INTO evaluation_values(key, value) VALUES (?1, ?2)",
                params![entry.key, entry.value],
            )
            .map_err(|error| format!("Failed to import evaluation data: {}", error))?;
        let stored: String = transaction
            .query_row(
                "SELECT value FROM evaluation_values WHERE key = ?1",
                params![entry.key],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to verify imported evaluation data: {}", error))?;
        if stored != entry.value {
            return Err(format!(
                "Evaluation migration verification failed for key {:?}.",
                entry.key
            ));
        }
    }

    transaction
        .execute(
            "INSERT INTO evaluation_meta(key, value) VALUES (?1, 'complete')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![migration_id],
        )
        .map_err(|error| format!("Failed to finish evaluation migration: {}", error))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit evaluation migration: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_entries_use_camel_case_json_fields() {
        let entry: EvaluationStoreEntry =
            serde_json::from_str(r#"{"key":"runs","value":"[]"}"#).unwrap();
        assert_eq!(entry.key, "runs");
        assert_eq!(entry.value, "[]");
    }

    #[test]
    fn batch_compare_and_swap_is_atomic() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let initial = EvaluationStoreBatch {
            checks: vec![EvaluationStoreBatchCheck {
                key: "index".to_string(),
                expected: None,
            }],
            mutations: vec![
                EvaluationStoreBatchMutation::Set {
                    key: "run".to_string(),
                    value: "one".to_string(),
                },
                EvaluationStoreBatchMutation::Set {
                    key: "index".to_string(),
                    value: "v1".to_string(),
                },
            ],
        };
        assert!(apply_batch(&mut connection, &initial).unwrap());

        let conflict = EvaluationStoreBatch {
            checks: vec![EvaluationStoreBatchCheck {
                key: "index".to_string(),
                expected: Some("stale".to_string()),
            }],
            mutations: vec![EvaluationStoreBatchMutation::Set {
                key: "run".to_string(),
                value: "overwritten".to_string(),
            }],
        };
        assert!(!apply_batch(&mut connection, &conflict).unwrap());
        let stored: String = connection
            .query_row(
                "SELECT value FROM evaluation_values WHERE key = 'run'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "one");
    }

    #[test]
    fn legacy_import_is_verified_and_marked_atomically() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        let entries = vec![EvaluationStoreEntry {
            key: "library".to_string(),
            value: "{\"version\":1}".to_string(),
        }];

        import_legacy(&mut connection, "legacy-v1", &entries).unwrap();
        assert!(migration_completed(&connection, "legacy-v1").unwrap());
        let stored: String = connection
            .query_row(
                "SELECT value FROM evaluation_values WHERE key = 'library'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, "{\"version\":1}");
    }

    #[test]
    fn conflicting_legacy_data_rolls_back_without_a_migration_marker() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO evaluation_values(key, value) VALUES ('existing', 'native')",
                [],
            )
            .unwrap();
        let entries = vec![
            EvaluationStoreEntry {
                key: "new".to_string(),
                value: "copied".to_string(),
            },
            EvaluationStoreEntry {
                key: "existing".to_string(),
                value: "legacy".to_string(),
            },
        ];

        assert!(import_legacy(&mut connection, "legacy-v1", &entries).is_err());
        assert!(!migration_completed(&connection, "legacy-v1").unwrap());
        let new_entry: Option<String> = connection
            .query_row(
                "SELECT value FROM evaluation_values WHERE key = 'new'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(new_entry, None);
    }
}
