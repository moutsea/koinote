use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

const KEYRING_SERVICE: &str = "app.koinote.desktop";
const SESSION_ENTRY: &str = "session";
const PENDING_AUTH_ENTRY: &str = "pending-auth";
const DATABASE_URL: &str = "sqlite:koinote-offline.db";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    access_token: String,
    refresh_token: String,
    account_id: String,
    user_json: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingAuthorization {
    state: String,
    code_verifier: String,
    created_at: i64,
}

fn keyring_entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, name).map_err(|error| error.to_string())
}

fn store_json<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    let encoded = serde_json::to_string(value).map_err(|error| error.to_string())?;
    keyring_entry(name)?
        .set_password(&encoded)
        .map_err(|error| error.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(name: &str) -> Result<Option<T>, String> {
    let entry = keyring_entry(name)?;
    let encoded = match entry.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    serde_json::from_str(&encoded)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn clear_entry(name: &str) -> Result<(), String> {
    match keyring_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn desktop_session_store(session: StoredSession) -> Result<(), String> {
    store_json(SESSION_ENTRY, &session)
}

#[tauri::command]
fn desktop_session_get() -> Result<Option<StoredSession>, String> {
    read_json(SESSION_ENTRY)
}

#[tauri::command]
fn desktop_session_clear() -> Result<(), String> {
    clear_entry(SESSION_ENTRY)
}

#[tauri::command]
fn desktop_pending_auth_store(pending: PendingAuthorization) -> Result<(), String> {
    store_json(PENDING_AUTH_ENTRY, &pending)
}

#[tauri::command]
fn desktop_pending_auth_get() -> Result<Option<PendingAuthorization>, String> {
    read_json(PENDING_AUTH_ENTRY)
}

#[tauri::command]
fn desktop_pending_auth_clear() -> Result<(), String> {
    clear_entry(PENDING_AUTH_ENTRY)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create_offline_cache",
        sql: include_str!("../migrations/0001_offline_cache.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DATABASE_URL, migrations)
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_session_store,
            desktop_session_get,
            desktop_session_clear,
            desktop_pending_auth_store,
            desktop_pending_auth_get,
            desktop_pending_auth_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koinote");
}
