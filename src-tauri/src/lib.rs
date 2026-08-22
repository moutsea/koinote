use keyring::Entry;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
#[cfg(desktop)]
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
#[cfg(desktop)]
use tauri::{
    menu::{
        MenuBuilder, MenuItem, MenuItemBuilder, MenuItemKind, Submenu, SubmenuBuilder,
        HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    },
    Runtime,
};
use tauri::{Emitter, Manager};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

mod pdf_export;

const KEYRING_SERVICE: &str = "app.koinote.desktop";
const SESSION_ENTRY: &str = "session";
const PENDING_AUTH_ENTRY: &str = "pending-auth";
const DATABASE_URL: &str = "sqlite:koinote-offline.db";
const DESKTOP_MENU_EVENT: &str = "koinote:desktop-menu-action";
const DESKTOP_MENU_PREFIX: &str = "koinote.";
const DESKTOP_CLOSE_WINDOW_ACTION: &str = "close-window";
#[cfg(desktop)]
const DESKTOP_EXPORT_SUBMENU_ID: &str = "koinote.export-document";

#[cfg(desktop)]
const DESKTOP_MENU_ACTIONS: [&str; 21] = [
    "new-document",
    "save-document",
    "close-document",
    "export-markdown",
    "export-html",
    "export-docx",
    "export-pdf",
    "export-media",
    "share-document",
    "quick-open",
    "find-in-document",
    "search-all-documents",
    "previous-document",
    "next-document",
    "toggle-documents-panel",
    "toggle-outline-panel",
    "ai-optimize",
    "version-history",
    "open-documentation",
    "show-keyboard-shortcuts",
    "check-updates",
];

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopMenuLocale {
    En,
    Zh,
    Fr,
    Ja,
}

#[cfg(desktop)]
impl DesktopMenuLocale {
    fn from_code(code: &str) -> Option<Self> {
        match code {
            "en" => Some(Self::En),
            "zh" => Some(Self::Zh),
            "fr" => Some(Self::Fr),
            "ja" => Some(Self::Ja),
            _ => None,
        }
    }
}

#[cfg(desktop)]
struct DesktopMenuState(Mutex<DesktopMenuSettings>);

#[cfg(desktop)]
struct DesktopMenuSettings {
    locale: DesktopMenuLocale,
    enabled_actions: HashSet<String>,
}

#[cfg(desktop)]
impl Default for DesktopMenuSettings {
    fn default() -> Self {
        Self {
            locale: DesktopMenuLocale::En,
            enabled_actions: [
                "open-documentation",
                "show-keyboard-shortcuts",
                "check-updates",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        }
    }
}

#[cfg(desktop)]
struct DesktopMenuCopy {
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    navigate: &'static str,
    tools: &'static str,
    window: &'static str,
    help: &'static str,
    new_document: &'static str,
    save_document: &'static str,
    close_document: &'static str,
    export_document: &'static str,
    export_markdown: &'static str,
    export_html: &'static str,
    export_docx: &'static str,
    export_pdf: &'static str,
    export_media: &'static str,
    share_document: &'static str,
    toggle_documents: &'static str,
    toggle_outline: &'static str,
    quick_open: &'static str,
    find_document: &'static str,
    search_all: &'static str,
    previous_document: &'static str,
    next_document: &'static str,
    ai_optimize: &'static str,
    version_history: &'static str,
    check_updates: &'static str,
    documentation: &'static str,
    keyboard_shortcuts: &'static str,
    close_window: &'static str,
}

#[cfg(desktop)]
fn desktop_menu_copy(locale: DesktopMenuLocale) -> DesktopMenuCopy {
    match locale {
        DesktopMenuLocale::En => DesktopMenuCopy {
            file: "File",
            edit: "Edit",
            view: "View",
            navigate: "Navigate",
            tools: "Tools",
            window: "Window",
            help: "Help",
            new_document: "New Document",
            save_document: "Save Document",
            close_document: "Close Document",
            export_document: "Export Document",
            export_markdown: "Markdown (.md)",
            export_html: "Web Page (.html)",
            export_docx: "Word (.docx)",
            export_pdf: "PDF",
            export_media: "Publishing Platforms…",
            share_document: "Share Document…",
            toggle_documents: "Toggle Document Sidebar",
            toggle_outline: "Toggle Outline",
            quick_open: "Quick Open Document…",
            find_document: "Find in Document…",
            search_all: "Search All Documents…",
            previous_document: "Previous Document",
            next_document: "Next Document",
            ai_optimize: "AI Optimization…",
            version_history: "Version History…",
            check_updates: "Check for Updates…",
            documentation: "Koinote Documentation",
            keyboard_shortcuts: "Keyboard Shortcuts…",
            close_window: "Close Window",
        },
        DesktopMenuLocale::Zh => DesktopMenuCopy {
            file: "文件",
            edit: "编辑",
            view: "视图",
            navigate: "导航",
            tools: "工具",
            window: "窗口",
            help: "帮助",
            new_document: "新建文档",
            save_document: "保存文档",
            close_document: "关闭文档",
            export_document: "导出文档",
            export_markdown: "Markdown (.md)",
            export_html: "网页 (.html)",
            export_docx: "Word (.docx)",
            export_pdf: "PDF",
            export_media: "导出到自媒体…",
            share_document: "分享文档…",
            toggle_documents: "显示或隐藏文档栏",
            toggle_outline: "显示或隐藏大纲",
            quick_open: "快速打开文档…",
            find_document: "在文档中查找…",
            search_all: "搜索全部文档…",
            previous_document: "上一个文档",
            next_document: "下一个文档",
            ai_optimize: "AI 优化…",
            version_history: "版本历史…",
            check_updates: "检查更新…",
            documentation: "Koinote 文档中心",
            keyboard_shortcuts: "键盘快捷键…",
            close_window: "关闭窗口",
        },
        DesktopMenuLocale::Fr => DesktopMenuCopy {
            file: "Fichier",
            edit: "Édition",
            view: "Affichage",
            navigate: "Navigation",
            tools: "Outils",
            window: "Fenêtre",
            help: "Aide",
            new_document: "Nouveau document",
            save_document: "Enregistrer le document",
            close_document: "Fermer le document",
            export_document: "Exporter le document",
            export_markdown: "Markdown (.md)",
            export_html: "Page web (.html)",
            export_docx: "Word (.docx)",
            export_pdf: "PDF",
            export_media: "Plateformes de publication…",
            share_document: "Partager le document…",
            toggle_documents: "Afficher ou masquer les documents",
            toggle_outline: "Afficher ou masquer le plan",
            quick_open: "Ouvrir rapidement un document…",
            find_document: "Rechercher dans le document…",
            search_all: "Rechercher dans tous les documents…",
            previous_document: "Document précédent",
            next_document: "Document suivant",
            ai_optimize: "Optimisation par IA…",
            version_history: "Historique des versions…",
            check_updates: "Rechercher des mises à jour…",
            documentation: "Documentation Koinote",
            keyboard_shortcuts: "Raccourcis clavier…",
            close_window: "Fermer la fenêtre",
        },
        DesktopMenuLocale::Ja => DesktopMenuCopy {
            file: "ファイル",
            edit: "編集",
            view: "表示",
            navigate: "移動",
            tools: "ツール",
            window: "ウインドウ",
            help: "ヘルプ",
            new_document: "新規ドキュメント",
            save_document: "ドキュメントを保存",
            close_document: "ドキュメントを閉じる",
            export_document: "ドキュメントを書き出す",
            export_markdown: "Markdown (.md)",
            export_html: "ウェブページ (.html)",
            export_docx: "Word (.docx)",
            export_pdf: "PDF",
            export_media: "投稿プラットフォーム…",
            share_document: "ドキュメントを共有…",
            toggle_documents: "ドキュメント欄を表示／非表示",
            toggle_outline: "アウトラインを表示／非表示",
            quick_open: "ドキュメントをすばやく開く…",
            find_document: "ドキュメント内を検索…",
            search_all: "すべてのドキュメントを検索…",
            previous_document: "前のドキュメント",
            next_document: "次のドキュメント",
            ai_optimize: "AI 最適化…",
            version_history: "バージョン履歴…",
            check_updates: "アップデートを確認…",
            documentation: "Koinote ドキュメント",
            keyboard_shortcuts: "キーボードショートカット…",
            close_window: "ウインドウを閉じる",
        },
    }
}

#[cfg(desktop)]
fn desktop_menu_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    action: &str,
    text: &str,
    accelerator: Option<&str>,
    enabled_actions: &HashSet<String>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let builder = MenuItemBuilder::with_id(format!("{DESKTOP_MENU_PREFIX}{action}"), text)
        .enabled(enabled_actions.contains(action));
    match accelerator {
        Some(accelerator) => builder.accelerator(accelerator).build(manager),
        None => builder.build(manager),
    }
}

#[cfg(desktop)]
fn desktop_export_enabled(enabled_actions: &HashSet<String>) -> bool {
    enabled_actions
        .iter()
        .any(|action| action.starts_with("export-"))
}

#[cfg(desktop)]
fn build_desktop_menu<R: Runtime, M: Manager<R>>(
    handle: &M,
    locale: DesktopMenuLocale,
    enabled_actions: &HashSet<String>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    let copy = desktop_menu_copy(locale);

    let new_document = desktop_menu_item(
        handle,
        "new-document",
        copy.new_document,
        None,
        enabled_actions,
    )?;
    let save_document = desktop_menu_item(
        handle,
        "save-document",
        copy.save_document,
        Some("CmdOrCtrl+S"),
        enabled_actions,
    )?;
    let close_document = desktop_menu_item(
        handle,
        "close-document",
        copy.close_document,
        None,
        enabled_actions,
    )?;
    let export_markdown = desktop_menu_item(
        handle,
        "export-markdown",
        copy.export_markdown,
        None,
        enabled_actions,
    )?;
    let export_html = desktop_menu_item(
        handle,
        "export-html",
        copy.export_html,
        None,
        enabled_actions,
    )?;
    let export_docx = desktop_menu_item(
        handle,
        "export-docx",
        copy.export_docx,
        None,
        enabled_actions,
    )?;
    let export_pdf = desktop_menu_item(
        handle,
        "export-pdf",
        copy.export_pdf,
        None,
        enabled_actions,
    )?;
    let export_media = desktop_menu_item(
        handle,
        "export-media",
        copy.export_media,
        None,
        enabled_actions,
    )?;
    let export_document =
        SubmenuBuilder::with_id(handle, DESKTOP_EXPORT_SUBMENU_ID, copy.export_document)
            .enabled(desktop_export_enabled(enabled_actions))
            .items(&[&export_markdown, &export_html, &export_docx, &export_pdf])
            .separator()
            .item(&export_media)
            .build()?;
    let share_document = desktop_menu_item(
        handle,
        "share-document",
        copy.share_document,
        None,
        enabled_actions,
    )?;

    let file_builder = SubmenuBuilder::new(handle, copy.file)
        .items(&[&new_document, &save_document, &close_document])
        .separator()
        .items(&[&export_document, &share_document]);
    #[cfg(not(target_os = "macos"))]
    let file_builder = file_builder.separator().quit();
    let file_menu = file_builder.build()?;

    let edit_menu = SubmenuBuilder::new(handle, copy.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let toggle_documents = desktop_menu_item(
        handle,
        "toggle-documents-panel",
        copy.toggle_documents,
        None,
        enabled_actions,
    )?;
    let toggle_outline = desktop_menu_item(
        handle,
        "toggle-outline-panel",
        copy.toggle_outline,
        None,
        enabled_actions,
    )?;
    let view_builder =
        SubmenuBuilder::new(handle, copy.view).items(&[&toggle_documents, &toggle_outline]);
    #[cfg(target_os = "macos")]
    let view_builder = view_builder.separator().fullscreen();
    let view_menu = view_builder.build()?;

    let quick_open = desktop_menu_item(
        handle,
        "quick-open",
        copy.quick_open,
        Some("CmdOrCtrl+P"),
        enabled_actions,
    )?;
    let find_document = desktop_menu_item(
        handle,
        "find-in-document",
        copy.find_document,
        Some("CmdOrCtrl+F"),
        enabled_actions,
    )?;
    let search_all = desktop_menu_item(
        handle,
        "search-all-documents",
        copy.search_all,
        Some("CmdOrCtrl+Shift+F"),
        enabled_actions,
    )?;
    let previous_document = desktop_menu_item(
        handle,
        "previous-document",
        copy.previous_document,
        None,
        enabled_actions,
    )?;
    let next_document = desktop_menu_item(
        handle,
        "next-document",
        copy.next_document,
        None,
        enabled_actions,
    )?;
    let navigate_menu = SubmenuBuilder::new(handle, copy.navigate)
        .items(&[&quick_open, &find_document, &search_all])
        .separator()
        .items(&[&previous_document, &next_document])
        .build()?;

    let ai_optimize = desktop_menu_item(
        handle,
        "ai-optimize",
        copy.ai_optimize,
        None,
        enabled_actions,
    )?;
    let version_history = desktop_menu_item(
        handle,
        "version-history",
        copy.version_history,
        None,
        enabled_actions,
    )?;
    let check_updates = desktop_menu_item(
        handle,
        "check-updates",
        copy.check_updates,
        None,
        enabled_actions,
    )?;
    let tools_menu = SubmenuBuilder::new(handle, copy.tools)
        .items(&[&ai_optimize, &version_history])
        .separator()
        .item(&check_updates)
        .build()?;

    let documentation = desktop_menu_item(
        handle,
        "open-documentation",
        copy.documentation,
        None,
        enabled_actions,
    )?;
    let keyboard_shortcuts = desktop_menu_item(
        handle,
        "show-keyboard-shortcuts",
        copy.keyboard_shortcuts,
        None,
        enabled_actions,
    )?;
    let help_builder = SubmenuBuilder::with_id(handle, HELP_SUBMENU_ID, copy.help)
        .items(&[&documentation, &keyboard_shortcuts]);
    #[cfg(not(target_os = "macos"))]
    let help_builder = help_builder.separator().about(None);
    let help_menu = help_builder.build()?;

    let close_window = MenuItemBuilder::with_id(
        format!("{DESKTOP_MENU_PREFIX}{DESKTOP_CLOSE_WINDOW_ACTION}"),
        copy.close_window,
    )
    .build(handle)?;
    let window_menu = SubmenuBuilder::with_id(handle, WINDOW_SUBMENU_ID, copy.window)
        .minimize()
        .maximize()
        .separator()
        .item(&close_window)
        .build()?;

    let menu_builder = MenuBuilder::new(handle);
    #[cfg(target_os = "macos")]
    let menu_builder = {
        let app_menu = SubmenuBuilder::new(handle, "Koinote")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu_builder.item(&app_menu)
    };
    menu_builder
        .items(&[
            &file_menu,
            &edit_menu,
            &view_menu,
            &navigate_menu,
            &tools_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}

#[cfg(desktop)]
fn install_desktop_menu<R: Runtime>(
    app: &mut tauri::App<R>,
    settings: &DesktopMenuSettings,
) -> tauri::Result<()> {
    let menu = build_desktop_menu(app.handle(), settings.locale, &settings.enabled_actions)?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(desktop)]
fn collect_desktop_menu_entries<R: Runtime>(
    items: &[MenuItemKind<R>],
    menu_items: &mut HashMap<String, MenuItem<R>>,
    export_submenu: &mut Option<Submenu<R>>,
) -> tauri::Result<()> {
    for item in items {
        let id = item.id().as_ref();
        if id == DESKTOP_EXPORT_SUBMENU_ID {
            *export_submenu = item.as_submenu().cloned();
        } else if let Some(action) = id.strip_prefix(DESKTOP_MENU_PREFIX) {
            if DESKTOP_MENU_ACTIONS.contains(&action) {
                if let Some(menu_item) = item.as_menuitem() {
                    menu_items.insert(action.to_string(), menu_item.clone());
                }
            }
        }
        if let Some(submenu) = item.as_submenu() {
            let children = submenu.items()?;
            collect_desktop_menu_entries(&children, menu_items, export_submenu)?;
        }
    }
    Ok(())
}

#[cfg(desktop)]
fn apply_desktop_menu_enabled<R: Runtime>(
    menu: &tauri::menu::Menu<R>,
    enabled_actions: &HashSet<String>,
) -> tauri::Result<()> {
    let top_level_items = menu.items()?;
    let mut menu_items = HashMap::new();
    let mut export_submenu = None;
    collect_desktop_menu_entries(
        &top_level_items,
        &mut menu_items,
        &mut export_submenu,
    )?;
    for action in DESKTOP_MENU_ACTIONS {
        let menu_item = menu_items.get(action).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("desktop_menu_item_missing:{action}"),
            )
        })?;
        menu_item.set_enabled(enabled_actions.contains(action))?;
    }
    let export_submenu = export_submenu.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "desktop_export_submenu_missing",
            )
        })?;
    export_submenu.set_enabled(desktop_export_enabled(enabled_actions))?;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_set_menu_locale(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopMenuState>,
    locale: String,
) -> Result<bool, String> {
    let next = DesktopMenuLocale::from_code(&locale)
        .ok_or_else(|| format!("unsupported_desktop_menu_locale:{locale}"))?;
    let mut settings = state
        .0
        .lock()
        .map_err(|_| "desktop_menu_locale_lock_failed".to_string())?;
    if settings.locale == next {
        return Ok(false);
    }
    let menu = build_desktop_menu(&app, next, &settings.enabled_actions)
        .map_err(|error| error.to_string())?;
    app.set_menu(menu).map_err(|error| error.to_string())?;
    settings.locale = next;
    Ok(true)
}

#[cfg(not(desktop))]
#[tauri::command]
fn desktop_set_menu_locale(_locale: String) -> Result<bool, String> {
    Ok(false)
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_set_menu_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopMenuState>,
    enabled_actions: Vec<String>,
) -> Result<bool, String> {
    let next = enabled_actions.into_iter().collect::<HashSet<_>>();
    if let Some(action) = next
        .iter()
        .find(|action| !DESKTOP_MENU_ACTIONS.contains(&action.as_str()))
    {
        return Err(format!("unsupported_desktop_menu_action:{action}"));
    }

    let mut settings = state
        .0
        .lock()
        .map_err(|_| "desktop_menu_enabled_lock_failed".to_string())?;
    if settings.enabled_actions == next {
        return Ok(false);
    }
    let menu = app
        .menu()
        .ok_or_else(|| "desktop_menu_missing".to_string())?;
    apply_desktop_menu_enabled(&menu, &next).map_err(|error| error.to_string())?;
    settings.enabled_actions = next;
    Ok(true)
}

#[cfg(not(desktop))]
#[tauri::command]
fn desktop_set_menu_enabled(_enabled_actions: Vec<String>) -> Result<bool, String> {
    Ok(false)
}

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
            {
                let menu_settings = DesktopMenuSettings::default();
                install_desktop_menu(app, &menu_settings)?;
                app.manage(DesktopMenuState(Mutex::new(menu_settings)));
                app.on_menu_event(|app, event| {
                    if let Some(action) = event.id().as_ref().strip_prefix(DESKTOP_MENU_PREFIX) {
                        if action == DESKTOP_CLOSE_WINDOW_ACTION {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.close();
                            }
                            return;
                        }
                        let _ = app.emit(DESKTOP_MENU_EVENT, action);
                    }
                });
            }
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
            desktop_set_menu_locale,
            desktop_set_menu_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Koinote");
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[cfg(desktop)]
    #[test]
    fn desktop_menu_locales_are_complete_and_distinct() {
        assert_eq!(
            DesktopMenuLocale::from_code("en"),
            Some(DesktopMenuLocale::En)
        );
        assert_eq!(
            DesktopMenuLocale::from_code("zh"),
            Some(DesktopMenuLocale::Zh)
        );
        assert_eq!(
            DesktopMenuLocale::from_code("fr"),
            Some(DesktopMenuLocale::Fr)
        );
        assert_eq!(
            DesktopMenuLocale::from_code("ja"),
            Some(DesktopMenuLocale::Ja)
        );
        assert_eq!(DesktopMenuLocale::from_code("de"), None);

        let en = desktop_menu_copy(DesktopMenuLocale::En);
        let zh = desktop_menu_copy(DesktopMenuLocale::Zh);
        let fr = desktop_menu_copy(DesktopMenuLocale::Fr);
        let ja = desktop_menu_copy(DesktopMenuLocale::Ja);
        assert_eq!(en.file, "File");
        assert_eq!(zh.file, "文件");
        assert_eq!(fr.file, "Fichier");
        assert_eq!(ja.file, "ファイル");
        assert_eq!(en.keyboard_shortcuts, "Keyboard Shortcuts…");
        assert_eq!(zh.keyboard_shortcuts, "键盘快捷键…");
        assert_eq!(fr.keyboard_shortcuts, "Raccourcis clavier…");
        assert_eq!(ja.keyboard_shortcuts, "キーボードショートカット…");
        assert_eq!(en.export_document, "Export Document");
        assert_eq!(zh.export_html, "网页 (.html)");
        assert_eq!(fr.export_media, "Plateformes de publication…");
        assert_eq!(ja.export_pdf, "PDF");
        assert_eq!(en.close_window, "Close Window");
        assert_eq!(zh.close_window, "关闭窗口");

        let settings = DesktopMenuSettings::default();
        assert!(settings.enabled_actions.contains("open-documentation"));
        assert!(settings.enabled_actions.contains("show-keyboard-shortcuts"));
        assert!(settings.enabled_actions.contains("check-updates"));
        assert!(!settings.enabled_actions.contains("save-document"));
    }

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
