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

mod file_export;
mod pdf_export;

#[cfg(koinote_local)]
const KEYRING_SERVICE: &str = "app.koinote.desktop.local";
#[cfg(not(koinote_local))]
const KEYRING_SERVICE: &str = "app.koinote.desktop";
const SESSION_ENTRY: &str = "session";
const PENDING_AUTH_ENTRY: &str = "pending-auth";
const LEGACY_X_BROWSER_CREDENTIALS_ENTRY: &str = "x-browser-credentials";
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
    let export_pdf =
        desktop_menu_item(handle, "export-pdf", copy.export_pdf, None, enabled_actions)?;
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
    collect_desktop_menu_entries(&top_level_items, &mut menu_items, &mut export_submenu)?;
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
    cover_mode: String,
    cover_ratio: String,
    cover_image_source: String,
    cover_prompt: String,
    folder_id: Option<String>,
    #[serde(default)]
    sort_order: i64,
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
                cover_mode, cover_ratio, cover_image_source, cover_prompt,
                sort_order, local_revision, base_revision, created_at, updated_at, share_json,
                sync_state, folder_dirty, order_dirty, change_seq, remote_snapshot, last_error
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL,
                       'create', 0, 1, 1, NULL, NULL)",
        )
        .bind(&batch.staging_account)
        .bind(document.doc_id)
        .bind(document.title)
        .bind(document.theme)
        .bind(document.content)
        .bind(document.folder_id)
        .bind(document.cover_mode)
        .bind(document.cover_ratio)
        .bind(document.cover_image_source)
        .bind(document.cover_prompt)
        .bind(document.sort_order)
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

#[tauri::command]
async fn desktop_save_export(
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<bool, String> {
    let filename = request
        .headers()
        .get("x-koinote-export-filename")
        .ok_or_else(|| "export_filename_missing".to_string())?
        .to_str()
        .map_err(|_| "export_filename_invalid".to_string())
        .and_then(decode_export_header)?;
    let extension = request
        .headers()
        .get("x-koinote-export-extension")
        .ok_or_else(|| "export_extension_missing".to_string())?
        .to_str()
        .map_err(|_| "export_extension_invalid".to_string())?
        .to_string();
    let extension = match extension.as_str() {
        "md" | "html" | "docx" | "zip" => extension,
        _ => return Err("export_extension_unsupported".to_string()),
    };
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("export_payload_must_be_binary".to_string()),
    };
    let dialog_filename = filename.clone();
    let dialog_extension = extension.clone();
    let selected_path = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;

        window
            .dialog()
            .file()
            .set_file_name(dialog_filename)
            .add_filter(
                dialog_extension.to_uppercase(),
                &[dialog_extension.as_str()],
            )
            .blocking_save_file()
            .map(|path| path.into_path().map_err(|error| error.to_string()))
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())??;
    let Some(selected_path) = selected_path else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        file_export::save_export_path(selected_path, bytes).map(|()| true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Serialize)]
struct DesktopConfigFile {
    path: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct DesktopConfigRestoreFile {
    path: String,
    bytes: Vec<u8>,
}

const CONFIG_SCAN_ROOTS: [&str; 59] = [
    ".ssh",
    ".claude",
    ".codex",
    ".pi",
    ".opencode",
    ".hermes",
    ".config",
    ".openclaw",
    ".moltbot",
    ".cursor",
    ".windsurf",
    ".continue",
    ".vscode",
    ".zed",
    ".cline",
    ".roo",
    ".gemini",
    ".aider",
    ".qwen",
    ".amazonq",
    ".codeium",
    ".copilot",
    ".mcp",
    ".aws",
    ".azure",
    ".vercel",
    ".netlify",
    ".fly",
    ".docker",
    ".kube",
    ".cargo",
    ".terraform.d",
    ".emacs.d",
    ".bundle",
    ".gradle",
    ".m2",
    ".sdkman/etc",
    ".pip",
    ".oh-my-zsh",
    "Library/Application Support/Code/User",
    "Library/Application Support/Code - Insiders/User",
    "Library/Application Support/Cursor/User",
    "Library/Application Support/Windsurf/User",
    "Library/Application Support/Claude",
    "Library/Application Support/Codex",
    "Library/Application Support/Zed",
    "Library/Application Support/ChatGPT",
    "Library/Application Support/pip",
    "Library/Application Support/pypoetry",
    "AppData/Roaming/Code/User",
    "AppData/Roaming/Code - Insiders/User",
    "AppData/Roaming/Cursor/User",
    "AppData/Roaming/Windsurf/User",
    "AppData/Roaming/Claude",
    "AppData/Roaming/Codex",
    "AppData/Roaming/Zed",
    "AppData/Roaming/ChatGPT",
    "AppData/Roaming/pip",
    "AppData/Roaming/pypoetry",
];

const CONFIG_COMPLETE_DIRECTORIES: &[&str] = &[
    ".ssh",
    ".config/git",
    ".config/zsh",
    ".config/bash",
    ".config/fish",
    ".config/tmux",
    ".config/kitty",
    ".config/wezterm",
    ".config/ghostty",
    ".config/nushell",
    ".oh-my-zsh/custom",
    ".claude/agents",
    ".claude/commands",
    ".claude/skills",
    ".claude/hooks",
    ".claude/rules",
    ".codex/skills",
    ".codex/prompts",
    ".codex/rules",
    ".pi/agent/skills",
    ".pi/agent/prompts",
    ".pi/agent/extensions",
    ".pi/agent/themes",
    ".agents/skills",
    ".config/opencode/agent",
    ".config/opencode/agents",
    ".config/opencode/command",
    ".config/opencode/commands",
    ".config/opencode/skill",
    ".config/opencode/skills",
    ".config/opencode/plugin",
    ".config/opencode/plugins",
    ".config/opencode/tools",
    ".config/claude/skills",
    ".config/codex/skills",
    ".config/pi/agent/skills",
    ".openclaw/skills",
    ".hermes/skills",
    ".moltbot/skills",
    ".config/openclaw/skills",
    ".config/hermes/skills",
    ".config/nvim",
    ".vim/after",
    ".vim/autoload",
    ".vim/colors",
    ".vim/ftplugin",
    ".vim/plugin",
    ".vim/snippets",
    ".cursor/rules",
    ".windsurf/rules",
    ".continue/rules",
    ".gradle/init.d",
    ".gemini/commands",
    ".gemini/skills",
];

const CONFIG_FILE_EXTENSIONS: [&str; 17] = [
    "cfg",
    "conf",
    "ini",
    "json",
    "json5",
    "jsonc",
    "kdl",
    "plist",
    "properties",
    "toml",
    "yaml",
    "yml",
    "xml",
    "nu",
    "el",
    "ps1",
    "lua",
];

const CONFIG_FILE_NAMES: [&str; 50] = [
    "authorized_keys",
    "authorized_keys2",
    "known_hosts",
    "known_hosts.old",
    ".git-credentials",
    ".gitattributes",
    ".gitignore_global",
    ".netrc",
    ".editorconfig",
    ".tool-versions",
    ".node-version",
    ".python-version",
    ".ruby-version",
    ".java-version",
    ".zshenv",
    ".zlogout",
    ".bash_logout",
    ".bash_aliases",
    ".bash_functions",
    ".dircolors",
    ".p10k.zsh",
    ".wezterm.lua",
    ".emacs",
    "init.lua",
    "init.vim",
    "init.el",
    "early-init.el",
    "wezterm.lua",
    "kitty.conf",
    "alacritty.toml",
    "config.kdl",
    "config.lua",
    "config.fish",
    "config.nu",
    "env.nu",
    "env",
    "env.tcsh",
    "instructions",
    "policy",
    "agents.md",
    "claude.md",
    "gemini.md",
    "mcp.json",
    "opencode.json",
    "openclaw.json",
    "settings",
    "preferences",
    "credentials",
    "properties",
    "config",
];

const CONFIG_DIRECTORY_EXCLUSIONS: [&str; 23] = [
    "cache",
    "cacheddata",
    "caches",
    "history",
    "log",
    "logs",
    "extensions",
    "migration-backups",
    "node_modules",
    "projects",
    "registry",
    "repos",
    "src",
    "target",
    "tmp",
    "temp",
    "worktrees",
    "workspace",
    ".git",
    ".next",
    ".tmp",
    "build",
    "dist",
];

fn is_config_candidate(path: &std::path::Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let name = name.to_ascii_lowercase();
    if CONFIG_FILE_NAMES.contains(&name.as_str())
        || name == "profile"
        || name.contains("config")
        || name.contains("settings")
        || name.ends_with("rc")
        || name.ends_with("profile")
        || name.starts_with(".env")
    {
        return true;
    }
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            CONFIG_FILE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

fn is_excluded_config_directory(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            CONFIG_DIRECTORY_EXCLUSIONS.contains(&name.to_ascii_lowercase().as_str())
        })
}

fn is_config_restore_backup(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| name.starts_with('.') && name.contains(".koinote-backup-"))
}

fn is_complete_config_directory(path: &std::path::Path, logical_home: &std::path::Path) -> bool {
    let Ok(relative) = path.strip_prefix(logical_home) else {
        return false;
    };
    let relative = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    CONFIG_COMPLETE_DIRECTORIES.contains(&relative.as_str())
}

fn config_home_directory() -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    let value = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let value = std::env::var_os("HOME");
    value
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "config_home_unavailable".to_string())
}

fn config_relative_path(path: &std::path::Path) -> Result<String, String> {
    let logical_home = config_home_directory()?;
    let home =
        std::fs::canonicalize(&logical_home).map_err(|_| "config_home_unavailable".to_string())?;
    let canonical_path = std::fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !canonical_path.is_file() {
        return Err("config_path_invalid".to_string());
    }
    if !canonical_path.starts_with(&home) {
        return Err("config_file_outside_home".to_string());
    }
    let relative = path
        .strip_prefix(&logical_home)
        .or_else(|_| canonical_path.strip_prefix(&home))
        .map_err(|_| "config_file_outside_home".to_string())?;
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(value) => {
                components.push(value.to_string_lossy().to_string())
            }
            _ => return Err("config_path_invalid".to_string()),
        }
    }
    if components.is_empty() {
        return Err("config_path_invalid".to_string());
    }
    let relative = components.join("/");
    if relative.as_bytes().len() > 512 {
        return Err("config_path_invalid".to_string());
    }
    Ok(relative)
}

fn append_config_file(
    path: &std::path::Path,
    logical_home: &std::path::Path,
    canonical_home: &std::path::Path,
    files: &mut Vec<DesktopConfigFile>,
) {
    if is_config_restore_backup(path) {
        return;
    }
    let Ok(canonical_target) = std::fs::canonicalize(path) else {
        return;
    };
    if !canonical_target.starts_with(canonical_home) {
        return;
    }
    let Ok(relative) = path.strip_prefix(logical_home) else {
        return;
    };
    let relative = relative
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if relative.is_empty() {
        return;
    }
    let Ok(bytes) = std::fs::read(canonical_target) else {
        return;
    };
    files.push(DesktopConfigFile {
        path: relative,
        bytes,
    });
}

fn collect_config_directory(
    directory: &std::path::Path,
    logical_home: &std::path::Path,
    canonical_home: &std::path::Path,
    files: &mut Vec<DesktopConfigFile>,
    include_all_files: bool,
) -> Result<(), String> {
    let include_all_files =
        include_all_files || is_complete_config_directory(directory, logical_home);
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            if std::fs::canonicalize(&path).is_ok_and(|target| {
                target.is_file() && (include_all_files || is_config_candidate(&path))
            }) {
                append_config_file(&path, logical_home, canonical_home, files);
            }
            continue;
        }
        if metadata.is_dir() {
            if !is_excluded_config_directory(&path)
                || is_complete_config_directory(&path, logical_home)
            {
                collect_config_directory(
                    &path,
                    logical_home,
                    canonical_home,
                    files,
                    include_all_files,
                )?;
            }
            continue;
        }
        if !metadata.is_file() || (!include_all_files && !is_config_candidate(&path)) {
            continue;
        }
        append_config_file(&path, logical_home, canonical_home, files);
    }
    Ok(())
}

fn scan_config_files() -> Result<Vec<DesktopConfigFile>, String> {
    let home = config_home_directory()?;
    let canonical_home =
        std::fs::canonicalize(&home).map_err(|_| "config_home_unavailable".to_string())?;
    let mut files = Vec::new();
    let entries = std::fs::read_dir(&home).map_err(|error| error.to_string())?;
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            if std::fs::canonicalize(&path)
                .is_ok_and(|target| target.is_file() && is_config_candidate(&path))
            {
                append_config_file(&path, &home, &canonical_home, &mut files);
            }
            continue;
        }
        if metadata.is_file() && is_config_candidate(&path) {
            append_config_file(&path, &home, &canonical_home, &mut files);
        }
    }
    for relative in CONFIG_SCAN_ROOTS {
        let directory = home.join(relative);
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                collect_config_directory(
                    &directory,
                    &home,
                    &canonical_home,
                    &mut files,
                    relative == ".ssh",
                )?;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

fn validated_config_restore_path(
    root: &std::path::Path,
    relative: &str,
) -> Result<std::path::PathBuf, String> {
    let relative_path = std::path::Path::new(relative);
    if relative_path.is_absolute()
        || relative.is_empty()
        || relative.as_bytes().len() > 512
        || relative.contains('\0')
    {
        return Err("config_path_invalid".to_string());
    }
    for component in relative_path.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("config_path_invalid".to_string());
        }
    }
    Ok(root.join(relative_path))
}

fn prepare_config_restore_parent(
    root: &std::path::Path,
    parent: &std::path::Path,
) -> Result<(), String> {
    let root = std::fs::canonicalize(root).map_err(|_| "config_home_unavailable".to_string())?;
    let relative = parent
        .strip_prefix(&root)
        .map_err(|_| "config_path_invalid".to_string())?;
    let mut current = root;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("config_path_invalid".to_string());
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("config_path_invalid".to_string())
            }
            Ok(metadata) if !metadata.is_dir() => return Err("config_path_invalid".to_string()),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn config_restore_backup_path(target: &std::path::Path, timestamp: u128) -> std::path::PathBuf {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("config");
    let base = target.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = format!(".{name}.koinote-backup-{timestamp}");
    let mut candidate = base.join(&stem);
    let mut suffix = 1;
    while candidate.exists() {
        candidate = base.join(format!("{stem}-{suffix}"));
        suffix += 1;
    }
    candidate
}

fn restore_config_files(
    root: &std::path::Path,
    files: &[DesktopConfigRestoreFile],
) -> Result<usize, String> {
    if files.is_empty() {
        return Err("config_file_count_invalid".to_string());
    }
    let root = std::fs::canonicalize(root).map_err(|_| "config_home_unavailable".to_string())?;
    let mut seen = std::collections::HashSet::new();
    for file in files {
        if !seen.insert(file.path.as_str()) {
            return Err("config_path_duplicate".to_string());
        }
    }
    let targets = files
        .iter()
        .map(|file| validated_config_restore_path(&root, &file.path))
        .collect::<Result<Vec<_>, _>>()?;
    for target in &targets {
        let parent = target
            .parent()
            .ok_or_else(|| "config_path_invalid".to_string())?;
        prepare_config_restore_parent(&root, parent)?;
        #[cfg(unix)]
        if parent
            .strip_prefix(&root)
            .ok()
            .is_some_and(|path| path.starts_with(".ssh"))
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    for (file, target) in files.iter().zip(targets) {
        if target.exists() {
            let backup = config_restore_backup_path(&target, timestamp);
            std::fs::rename(&target, backup).map_err(|error| error.to_string())?;
        }
        file_export::save_export_path(target.clone(), file.bytes.clone())?;
        #[cfg(unix)]
        if file.path == ".ssh/config" || file.path.starts_with(".ssh/") {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(files.len())
}

#[tauri::command]
async fn desktop_pick_config_files(
    window: tauri::WebviewWindow,
) -> Result<Vec<DesktopConfigFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(paths) = window.dialog().file().blocking_pick_files() else {
            return Ok(Vec::new());
        };
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let path = path.into_path().map_err(|error| error.to_string())?;
            let relative = config_relative_path(&path)?;
            let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
            files.push(DesktopConfigFile {
                path: relative,
                bytes,
            });
        }
        Ok(files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn desktop_scan_config_files() -> Result<Vec<DesktopConfigFile>, String> {
    tauri::async_runtime::spawn_blocking(scan_config_files)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn desktop_restore_config_files(
    window: tauri::WebviewWindow,
    files: Vec<DesktopConfigRestoreFile>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(root) = window.dialog().file().blocking_pick_folder() else {
            return Ok(0);
        };
        let root = root.into_path().map_err(|error| error.to_string())?;
        restore_config_files(&root, &files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn desktop_restore_config_files_to_home(
    files: Vec<DesktopConfigRestoreFile>,
) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = config_home_directory()?;
        restore_config_files(&root, &files)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn decode_export_header(value: &str) -> Result<String, String> {
    let value = value.as_bytes();
    let mut decoded = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < value.len() {
        if value[index] == b'%' {
            if index + 2 >= value.len() {
                return Err("export_filename_invalid".to_string());
            }
            let high =
                hex_value(value[index + 1]).ok_or_else(|| "export_filename_invalid".to_string())?;
            let low =
                hex_value(value[index + 2]).ok_or_else(|| "export_filename_invalid".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(value[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "export_filename_invalid".to_string())
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
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
        Migration {
            version: 6,
            description: "add_document_order",
            sql: include_str!("../migrations/0006_document_order.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "add_document_covers",
            sql: include_str!("../migrations/0007_document_covers.sql"),
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default();
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    let builder = builder
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
            let _ = clear_entry(LEGACY_X_BROWSER_CREDENTIALS_ENTRY);
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
            desktop_save_export,
            desktop_pick_config_files,
            desktop_scan_config_files,
            desktop_restore_config_files,
            desktop_restore_config_files_to_home,
            desktop_set_menu_locale,
            desktop_set_menu_enabled,
        ]);
    builder
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
        sqlx::query(include_str!("../migrations/0006_document_order.sql"))
            .execute(&pool)
            .await
            .expect("extend document order columns");
        sqlx::query(include_str!("../migrations/0007_document_covers.sql"))
            .execute(&pool)
            .await
            .expect("extend document cover columns");
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
                    cover_mode: "ai".to_string(),
                    cover_ratio: "3:2".to_string(),
                    cover_image_source: "koinote-local-image://image-1".to_string(),
                    cover_prompt: "Imported cover".to_string(),
                    folder_id: Some("folder-1".to_string()),
                    sort_order: 0,
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
                    cover_mode: "default".to_string(),
                    cover_ratio: "2.35:1".to_string(),
                    cover_image_source: String::new(),
                    cover_prompt: String::new(),
                    folder_id: None,
                    sort_order: 1,
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
            let cover: (String, String, String, String) = sqlx::query_as(
                "SELECT cover_mode, cover_ratio, cover_image_source, cover_prompt
                 FROM offline_documents
                 WHERE account_id = 'account-1' AND doc_id = 'document-1'",
            )
            .fetch_one(&pool)
            .await
            .expect("load imported cover");
            assert_eq!(
                cover,
                (
                    "ai".to_string(),
                    "3:2".to_string(),
                    "koinote-local-image://image-1".to_string(),
                    "Imported cover".to_string(),
                )
            );
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

    #[test]
    fn export_filename_header_decodes_utf8() {
        assert_eq!(
            decode_export_header("%E5%AF%BC%E5%87%BA.html").unwrap(),
            "导出.html"
        );
        assert_eq!(
            decode_export_header("export%25name.html").unwrap(),
            "export%name.html"
        );
        assert_eq!(
            decode_export_header("%E5%AF%BC%E5%87%BA%ZZ.html").unwrap_err(),
            "export_filename_invalid"
        );
    }

    #[test]
    fn config_restore_rejects_absolute_and_parent_paths() {
        let root = std::path::Path::new("/tmp/koinote-config");
        assert!(validated_config_restore_path(root, ".ssh/config").is_ok());
        assert_eq!(
            validated_config_restore_path(root, "../outside").unwrap_err(),
            "config_path_invalid"
        );
        assert_eq!(
            validated_config_restore_path(root, "/etc/ssh/config").unwrap_err(),
            "config_path_invalid"
        );
        assert_eq!(
            validated_config_restore_path(root, "./config").unwrap_err(),
            "config_path_invalid"
        );
        assert_eq!(
            validated_config_restore_path(root, "bad\0path").unwrap_err(),
            "config_path_invalid"
        );
    }

    #[test]
    fn config_scan_recognizes_generic_formats_and_skips_cache_directories() {
        assert!(is_config_candidate(std::path::Path::new("settings.json")));
        assert!(is_config_candidate(std::path::Path::new("tool.toml")));
        assert!(is_config_candidate(std::path::Path::new(".customrc")));
        assert!(is_config_candidate(std::path::Path::new(".env.local")));
        assert!(is_config_candidate(std::path::Path::new(".zshenv")));
        assert!(is_config_candidate(std::path::Path::new(
            ".git-credentials"
        )));
        assert!(is_config_candidate(std::path::Path::new(".editorconfig")));
        assert!(is_config_candidate(std::path::Path::new(".tool-versions")));
        assert!(is_config_candidate(std::path::Path::new(".bash_logout")));
        assert!(is_config_candidate(std::path::Path::new(".p10k.zsh")));
        assert!(is_config_candidate(std::path::Path::new(".wezterm.lua")));
        assert!(is_config_candidate(std::path::Path::new("init.el")));
        assert!(is_config_candidate(std::path::Path::new("config.jsonc")));
        assert!(is_config_candidate(std::path::Path::new(
            "gradle.properties"
        )));
        assert!(is_config_candidate(std::path::Path::new("env")));
        assert!(is_config_candidate(std::path::Path::new("env.tcsh")));
        assert!(!is_config_candidate(std::path::Path::new("notes.txt")));
        assert!(is_excluded_config_directory(std::path::Path::new("cache")));
        assert!(is_excluded_config_directory(std::path::Path::new(
            "worktrees"
        )));
        assert!(is_excluded_config_directory(std::path::Path::new(
            "extensions"
        )));
        assert!(is_excluded_config_directory(std::path::Path::new(
            "registry"
        )));
        assert!(is_excluded_config_directory(std::path::Path::new(
            "workspace"
        )));
        assert!(!is_excluded_config_directory(std::path::Path::new(
            "opencode"
        )));
    }

    #[test]
    fn config_scan_includes_all_ssh_files_and_keeps_logical_paths() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "koinote-ssh-scan-{}-{timestamp}",
            std::process::id()
        ));
        let ssh = root.join(".ssh");
        std::fs::create_dir_all(ssh.join("cache")).unwrap();
        for name in [
            "config",
            "id_ed25519",
            "id_ed25519.pub",
            "known_hosts",
            "work-key",
            ".config.koinote-backup-123",
        ] {
            std::fs::write(ssh.join(name), name.as_bytes()).unwrap();
        }
        std::fs::write(ssh.join("cache").join("ignored"), b"ignored").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(ssh.join("work-key"), ssh.join("linked-key")).unwrap();

        let mut files = Vec::new();
        let canonical_root = std::fs::canonicalize(&root).unwrap();
        collect_config_directory(&ssh, &root, &canonical_root, &mut files, true).unwrap();
        let mut paths = files.into_iter().map(|file| file.path).collect::<Vec<_>>();
        paths.sort();
        assert!(paths.contains(&".ssh/id_ed25519".to_string()));
        assert!(paths.contains(&".ssh/id_ed25519.pub".to_string()));
        assert!(paths.contains(&".ssh/known_hosts".to_string()));
        assert!(paths.contains(&".ssh/work-key".to_string()));
        assert!(!paths.contains(&".ssh/.config.koinote-backup-123".to_string()));
        assert!(!paths.contains(&".ssh/cache/ignored".to_string()));
        #[cfg(unix)]
        assert!(paths.contains(&".ssh/linked-key".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_scan_complete_directories_include_skill_files() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "koinote-config-complete-{}-{timestamp}",
            std::process::id()
        ));
        let skills = root.join(".claude/skills/example");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("SKILL.md"), b"skill").unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();
        let mut files = Vec::new();
        collect_config_directory(
            &root.join(".claude"),
            &root,
            &canonical_root,
            &mut files,
            false,
        )
        .unwrap();
        assert!(files
            .iter()
            .any(|file| file.path == ".claude/skills/example/SKILL.md"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_scan_complete_directories_override_generic_exclusions() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "koinote-config-complete-exclusion-{}-{timestamp}",
            std::process::id()
        ));
        let extensions = root.join(".pi/agent/extensions/example");
        std::fs::create_dir_all(&extensions).unwrap();
        std::fs::write(extensions.join("README.md"), b"extension").unwrap();
        let canonical_root = std::fs::canonicalize(&root).unwrap();
        let mut files = Vec::new();
        collect_config_directory(&root.join(".pi"), &root, &canonical_root, &mut files, false)
            .unwrap();
        assert!(files
            .iter()
            .any(|file| file.path == ".pi/agent/extensions/example/README.md"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_restore_backups_existing_files() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("koinote-config-{}-{timestamp}", std::process::id()));
        let ssh = root.join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        let target = ssh.join("config");
        std::fs::write(&target, b"old").unwrap();
        let files = vec![DesktopConfigRestoreFile {
            path: ".ssh/config".to_string(),
            bytes: b"new".to_vec(),
        }];

        assert_eq!(restore_config_files(&root, &files).unwrap(), 1);
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
        let backup_count = std::fs::read_dir(&ssh)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".config.koinote-backup-")
            })
            .count();
        assert_eq!(backup_count, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
