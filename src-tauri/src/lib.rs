use keyring::Entry;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::Manager;
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

mod pdf_export;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportFolder {
    folder_id: String,
    name: String,
    parent_folder_id: Option<String>,
    organizer_kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportImage {
    image_id: String,
    content_type: String,
    base64_data: String,
    byte_size: i64,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportDocument {
    doc_id: String,
    title: String,
    theme: String,
    content: String,
    folder_id: Option<String>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportBatch {
    staging_account: String,
    folders: Vec<LocalImportFolder>,
    images: Vec<LocalImportImage>,
    documents: Vec<LocalImportDocument>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportFinalizeRequest {
    staging_account: String,
    target_account: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalImportAbortRequest {
    staging_account: Option<String>,
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

async fn import_local_mode_batch(
    pool: &SqlitePool,
    batch: LocalImportBatch,
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    for folder in batch.folders {
        sqlx::query(
            "INSERT INTO offline_folders (
                account_id, folder_id, name, parent_folder_id, organizer_kind,
                sync_state, change_seq
             ) VALUES (?, ?, ?, ?, ?, 'create', 1)",
        )
        .bind(&batch.staging_account)
        .bind(folder.folder_id)
        .bind(folder.name)
        .bind(folder.parent_folder_id)
        .bind(folder.organizer_kind)
        .execute(&mut *transaction)
        .await?;
    }
    for image in batch.images {
        sqlx::query(
            "INSERT INTO offline_images (
                account_id, image_id, content_type, base64_data, byte_size,
                object_key, remote_url, created_at, last_error, is_local_origin
             ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 1)",
        )
        .bind(&batch.staging_account)
        .bind(image.image_id)
        .bind(image.content_type)
        .bind(image.base64_data)
        .bind(image.byte_size)
        .bind(image.created_at)
        .execute(&mut *transaction)
        .await?;
    }
    for document in batch.documents {
        sqlx::query(
            "INSERT INTO offline_documents (
                account_id, doc_id, title, theme, content, folder_id,
                local_revision, base_revision, created_at, updated_at, share_json,
                sync_state, folder_dirty, change_seq, remote_snapshot, last_error
             ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL,
                       'create', 0, 1, NULL, NULL)",
        )
        .bind(&batch.staging_account)
        .bind(document.doc_id)
        .bind(document.title)
        .bind(document.theme)
        .bind(document.content)
        .bind(document.folder_id)
        .bind(&document.created_at)
        .bind(&document.created_at)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await
}

fn valid_local_import_staging_account(account: &str) -> bool {
    account
        .strip_prefix("local-import:")
        .is_some_and(|suffix| !suffix.is_empty() && account.len() <= 128)
}

async fn finalize_local_mode_import(
    pool: &SqlitePool,
    staging_account: &str,
    target_account: &str,
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    for table in ["offline_folders", "offline_images", "offline_documents"] {
        let query = format!("UPDATE {table} SET account_id = ? WHERE account_id = ?");
        sqlx::query(&query)
            .bind(target_account)
            .bind(staging_account)
            .execute(&mut *transaction)
            .await?;
    }
    transaction.commit().await
}

async fn abort_local_mode_import(
    pool: &SqlitePool,
    staging_account: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    for table in ["offline_documents", "offline_images", "offline_folders"] {
        let (query, value) = match staging_account {
            Some(account) => (format!("DELETE FROM {table} WHERE account_id = ?"), account),
            None => (
                format!("DELETE FROM {table} WHERE account_id LIKE 'local-import:%'"),
                "",
            ),
        };
        let mut statement = sqlx::query(&query);
        if staging_account.is_some() {
            statement = statement.bind(value);
        }
        statement.execute(&mut *transaction).await?;
    }
    transaction.commit().await
}

async fn offline_sqlite_pool(app: &tauri::AppHandle) -> Result<SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let instances = instances.0.read().await;
    let Some(DbPool::Sqlite(pool)) = instances.get(DATABASE_URL) else {
        return Err("desktop_database_not_loaded".to_string());
    };
    Ok(pool.clone())
}

#[tauri::command]
async fn desktop_import_local_mode(
    app: tauri::AppHandle,
    batch: LocalImportBatch,
) -> Result<(), String> {
    if !valid_local_import_staging_account(&batch.staging_account) {
        return Err("local_import_staging_account_invalid".to_string());
    }
    let pool = offline_sqlite_pool(&app).await?;
    import_local_mode_batch(&pool, batch)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_finalize_local_mode_import(
    app: tauri::AppHandle,
    request: LocalImportFinalizeRequest,
) -> Result<(), String> {
    if !valid_local_import_staging_account(&request.staging_account)
        || request.target_account.is_empty()
        || request.target_account == "local:v1"
        || request.target_account.starts_with("local-import:")
    {
        return Err("local_import_account_invalid".to_string());
    }
    let pool = offline_sqlite_pool(&app).await?;
    finalize_local_mode_import(&pool, &request.staging_account, &request.target_account)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_abort_local_mode_import(
    app: tauri::AppHandle,
    request: LocalImportAbortRequest,
) -> Result<(), String> {
    if request
        .staging_account
        .as_deref()
        .is_some_and(|account| !valid_local_import_staging_account(account))
    {
        return Err("local_import_staging_account_invalid".to_string());
    }
    let pool = offline_sqlite_pool(&app).await?;
    abort_local_mode_import(&pool, request.staging_account.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    pdf_export::export_pdf(window, path).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_offline_cache",
            sql: include_str!("../migrations/0001_offline_cache.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_offline_images",
            sql: include_str!("../migrations/0002_offline_images.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "bound_offline_image_cache",
            sql: include_str!("../migrations/0003_offline_image_cache.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_local_mode_config",
            sql: include_str!("../migrations/0004_local_mode.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "mark_document_organizer_folders",
            sql: include_str!("../migrations/0005_document_organizer.sql"),
            kind: MigrationKind::Up,
        },
    ];

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
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(DATABASE_URL, migrations)
                .build(),
        )
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
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
            desktop_import_local_mode,
            desktop_finalize_local_mode_import,
            desktop_abort_local_mode_import,
            desktop_export_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koinote");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn import_test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("create in-memory sqlite");
        sqlx::query(include_str!("../migrations/0001_offline_cache.sql"))
            .execute(&pool)
            .await
            .expect("create offline tables");
        sqlx::query(include_str!("../migrations/0002_offline_images.sql"))
            .execute(&pool)
            .await
            .expect("create image table");
        sqlx::query(include_str!("../migrations/0003_offline_image_cache.sql"))
            .execute(&pool)
            .await
            .expect("extend image table");
        sqlx::query(include_str!("../migrations/0004_local_mode.sql"))
            .execute(&pool)
            .await
            .expect("create local mode config");
        sqlx::query(include_str!("../migrations/0005_document_organizer.sql"))
            .execute(&pool)
            .await
            .expect("extend folder table");
        pool
    }

    fn test_batch(staging_account: &str, duplicate_document_id: bool) -> LocalImportBatch {
        LocalImportBatch {
            staging_account: staging_account.to_string(),
            folders: vec![LocalImportFolder {
                folder_id: "folder-1".to_string(),
                name: "Folder".to_string(),
                parent_folder_id: None,
                organizer_kind: Some("activity".to_string()),
            }],
            images: vec![LocalImportImage {
                image_id: "image-1".to_string(),
                content_type: "image/png".to_string(),
                base64_data: "aW1hZ2U=".to_string(),
                byte_size: 5,
                created_at: "2026-08-17T00:00:00Z".to_string(),
            }],
            documents: vec![
                LocalImportDocument {
                    doc_id: "document-1".to_string(),
                    title: "One".to_string(),
                    theme: "minimal".to_string(),
                    content: "Body".to_string(),
                    folder_id: Some("folder-1".to_string()),
                    created_at: "2026-08-17T00:00:00Z".to_string(),
                },
                LocalImportDocument {
                    doc_id: if duplicate_document_id {
                        "document-1".to_string()
                    } else {
                        "document-2".to_string()
                    },
                    title: "Two".to_string(),
                    theme: "minimal".to_string(),
                    content: "Body".to_string(),
                    folder_id: None,
                    created_at: "2026-08-17T00:00:00Z".to_string(),
                },
            ],
        }
    }

    #[test]
    fn local_import_commits_complete_batch() {
        tauri::async_runtime::block_on(async {
            let pool = import_test_pool().await;
            import_local_mode_batch(&pool, test_batch("local-import:test", false))
                .await
                .expect("import batch");
            let target_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM offline_documents WHERE account_id = 'account-1'",
            )
            .fetch_one(&pool)
            .await
            .expect("load target count before finalize");
            assert_eq!(target_count, 0);
            finalize_local_mode_import(&pool, "local-import:test", "account-1")
                .await
                .expect("finalize import");
            let counts: (i64, i64, i64) = sqlx::query_as(
                "SELECT
                    (SELECT COUNT(*) FROM offline_folders WHERE account_id = 'account-1'),
                    (SELECT COUNT(*) FROM offline_images WHERE account_id = 'account-1'),
                    (SELECT COUNT(*) FROM offline_documents WHERE account_id = 'account-1')",
            )
            .fetch_one(&pool)
            .await
            .expect("load counts");
            assert_eq!(counts, (1, 1, 2));
            let organizer_kind: Option<String> = sqlx::query_scalar(
                "SELECT organizer_kind FROM offline_folders
                 WHERE account_id = 'account-1' AND folder_id = 'folder-1'",
            )
            .fetch_one(&pool)
            .await
            .expect("load imported organizer kind");
            assert_eq!(organizer_kind.as_deref(), Some("activity"));
        });
    }

    #[test]
    fn local_import_rolls_back_complete_batch() {
        tauri::async_runtime::block_on(async {
            let pool = import_test_pool().await;
            assert!(
                import_local_mode_batch(&pool, test_batch("local-import:test", true))
                    .await
                    .is_err()
            );
            let counts: (i64, i64, i64) = sqlx::query_as(
                "SELECT
                    (SELECT COUNT(*) FROM offline_folders),
                    (SELECT COUNT(*) FROM offline_images),
                    (SELECT COUNT(*) FROM offline_documents)",
            )
            .fetch_one(&pool)
            .await
            .expect("load counts");
            assert_eq!(counts, (0, 0, 0));
        });
    }

    #[test]
    fn local_import_finalize_is_atomic_and_abortable() {
        tauri::async_runtime::block_on(async {
            let pool = import_test_pool().await;
            import_local_mode_batch(&pool, test_batch("local-import:test", false))
                .await
                .expect("stage import");
            sqlx::query(
                "INSERT INTO offline_documents (
                    account_id, doc_id, title, theme, content, local_revision,
                    base_revision, sync_state
                 ) VALUES ('account-1', 'document-1', 'Existing', 'minimal', '', 1, 0, 'clean')",
            )
            .execute(&pool)
            .await
            .expect("create target collision");

            assert!(
                finalize_local_mode_import(&pool, "local-import:test", "account-1")
                    .await
                    .is_err()
            );
            let staged_counts: (i64, i64, i64) = sqlx::query_as(
                "SELECT
                    (SELECT COUNT(*) FROM offline_folders WHERE account_id = 'local-import:test'),
                    (SELECT COUNT(*) FROM offline_images WHERE account_id = 'local-import:test'),
                    (SELECT COUNT(*) FROM offline_documents WHERE account_id = 'local-import:test')",
            )
            .fetch_one(&pool)
            .await
            .expect("load staged counts after failed finalize");
            assert_eq!(staged_counts, (1, 1, 2));

            abort_local_mode_import(&pool, Some("local-import:test"))
                .await
                .expect("abort import");
            let staged_count: i64 = sqlx::query_scalar(
                "SELECT
                    (SELECT COUNT(*) FROM offline_folders WHERE account_id = 'local-import:test') +
                    (SELECT COUNT(*) FROM offline_images WHERE account_id = 'local-import:test') +
                    (SELECT COUNT(*) FROM offline_documents WHERE account_id = 'local-import:test')",
            )
            .fetch_one(&pool)
            .await
            .expect("load staged count after abort");
            assert_eq!(staged_count, 0);
        });
    }
}
