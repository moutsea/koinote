//! Resolve portable, HOME-relative backups on the receiving computer.
//! This only translates known locations; file contents are never rewritten.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Windows,
    Mac,
    Linux,
}

impl Platform {
    pub(crate) fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}

pub(crate) struct HomeLocations {
    pub(crate) platform: Platform,
    pub(crate) roaming: Result<String, String>,
    pub(crate) xdg: Result<String, String>,
}

fn relative_environment_directory(
    home: &Path,
    name: &str,
    fallback: &str,
) -> Result<String, String> {
    let Some(value) = std::env::var_os(name).filter(|value| !value.is_empty()) else {
        return Ok(fallback.to_string());
    };
    relative_config_root(home, Path::new(&value), Platform::current())
}

fn resolve_existing_prefix(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    let mut suffix = Vec::new();
    loop {
        match std::fs::canonicalize(current) {
            Ok(mut resolved) => {
                for part in suffix.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                suffix.push(
                    current
                        .file_name()
                        .ok_or("config_platform_location_unsupported")?
                        .to_os_string(),
                );
                current = current
                    .parent()
                    .ok_or("config_platform_location_unsupported")?;
            }
            Err(_) => return Err("config_platform_location_unsupported".into()),
        }
    }
}

fn relative_root_spelling(home: &str, value: &str, platform: Platform) -> Result<String, String> {
    let home = home.replace('\\', "/");
    let home = home.trim_end_matches('/');
    let value = value.replace('\\', "/");
    let prefix = value
        .get(..home.len())
        .ok_or("config_platform_location_unsupported")?;
    let matches = if platform == Platform::Windows {
        prefix.eq_ignore_ascii_case(home)
    } else {
        prefix == home
    };
    if !matches || (value.len() > home.len() && value.as_bytes()[home.len()] != b'/') {
        return Err("config_platform_location_unsupported".into());
    }
    let relative = value[home.len()..].trim_start_matches('/').to_string();
    if !relative.is_empty() {
        validate_path(&relative, platform)
            .map_err(|_| "config_platform_location_unsupported".to_string())?;
    }
    Ok(relative)
}

fn relative_config_root(home: &Path, value: &Path, platform: Platform) -> Result<String, String> {
    if !value.is_absolute() {
        return Err("config_platform_location_unsupported".into());
    }
    // Resolve HOME aliases and existing symlink ancestors before checking containment.
    let home = resolve_existing_prefix(home)?;
    let value = resolve_existing_prefix(value)?;
    relative_root_spelling(&home.to_string_lossy(), &value.to_string_lossy(), platform)
}

fn join_relative(root: &str, suffix: &str) -> String {
    if root.is_empty() {
        suffix.to_string()
    } else {
        format!("{root}/{suffix}")
    }
}

impl HomeLocations {
    pub(crate) fn current(home: &Path) -> Self {
        Self {
            platform: Platform::current(),
            roaming: relative_environment_directory(home, "APPDATA", "AppData/Roaming"),
            xdg: relative_environment_directory(home, "XDG_CONFIG_HOME", ".config"),
        }
    }

    fn app_root(&self, app: &str) -> Result<String, String> {
        let base = match self.platform {
            Platform::Windows => self.roaming.clone()?,
            Platform::Mac => "Library/Application Support".to_string(),
            Platform::Linux => self.xdg.clone()?,
        };
        Ok(join_relative(&base, app))
    }
}

pub(crate) fn validate_path(path: &str, platform: Platform) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 512
        || path.chars().any(|c| {
            c == '\0'
                || c == '\\'
                || (platform == Platform::Windows && (c.is_control() || c == ':'))
        })
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
    {
        return Err("config_path_invalid".to_string());
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err("config_path_invalid".to_string());
        }
        if platform == Platform::Windows {
            let stem = part
                .split('.')
                .next()
                .unwrap_or("")
                .trim_end()
                .to_uppercase();
            let reserved = matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
            ) || ["COM", "LPT"].iter().any(|prefix| {
                stem.strip_prefix(prefix).is_some_and(|n| {
                    matches!(
                        n,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                })
            });
            if reserved
                || part.ends_with(['.', ' '])
                || part.contains(['<', '>', '"', '|', '?', '*'])
            {
                return Err("config_path_invalid".to_string());
            }
        }
    }
    Ok(())
}

fn under<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    // Only Windows-origin app roots are case insensitive. Unix names are distinct.
    let prefix = path.get(..root.len())?;
    if app_name_matches(prefix, root) && path.as_bytes().get(root.len()) == Some(&b'/') {
        Some(&path[root.len() + 1..])
    } else {
        None
    }
}

fn app_name_matches(path: &str, candidate: &str) -> bool {
    if candidate.starts_with("AppData") {
        path.eq_ignore_ascii_case(candidate)
    } else {
        path == candidate
    }
}

fn mapped_or_original(
    path: &str,
    locations: &HomeLocations,
    mapped: Result<String, String>,
) -> Result<String, String> {
    if mapped
        .as_ref()
        .is_err_and(|error| error == "config_platform_location_unsupported")
    {
        let same_platform = match locations.platform {
            Platform::Windows => under(path, "AppData/Roaming").is_some(),
            Platform::Mac => {
                under(path, "Library/Application Support").is_some()
                    || under(path, ".config/zed").is_some()
            }
            Platform::Linux => under(path, ".config").is_some(),
        };
        if same_platform {
            return Ok(path.to_string());
        }
    }
    mapped
}

fn app_suffix<'a>(path: &'a str, app: &str) -> Option<&'a str> {
    ["AppData/Roaming", "Library/Application Support", ".config"]
        .iter()
        .find_map(|base| under(path, &format!("{base}/{app}")))
}

pub(crate) fn home_path(path: &str, locations: &HomeLocations) -> Result<String, String> {
    validate_path(path, locations.platform)?;
    // VS Code and its derivatives share the User tree. Do not relocate app caches.
    // https://code.visualstudio.com/docs/configure/settings#_settings-file-locations
    // https://docs.cursor.com/en/troubleshooting/troubleshooting-guide
    for app in ["Code", "Code - Insiders", "Cursor", "Windsurf"] {
        if let Some(suffix) = app_suffix(path, &format!("{app}/User")) {
            return mapped_or_original(
                path,
                locations,
                locations
                    .app_root(app)
                    .map(|root| format!("{root}/User/{suffix}")),
            );
        }
    }
    // Zed uses XDG config on macOS too, unlike Electron applications.
    // https://zed.dev/docs/themes
    if let Some(suffix) = under(path, "AppData/Roaming/Zed").or_else(|| under(path, ".config/zed"))
    {
        let root = if locations.platform == Platform::Windows {
            locations
                .roaming
                .as_ref()
                .map(|base| join_relative(base, "Zed"))
        } else {
            locations
                .xdg
                .as_ref()
                .map(|base| join_relative(base, "zed"))
        };
        return mapped_or_original(
            path,
            locations,
            root.map(|root| format!("{root}/{suffix}"))
                .map_err(Clone::clone),
        );
    }
    // https://python-poetry.org/docs/configuration/#default-directories
    if let Some(suffix) = app_suffix(path, "pypoetry") {
        return mapped_or_original(
            path,
            locations,
            locations
                .app_root("pypoetry")
                .map(|root| format!("{root}/{suffix}")),
        );
    }
    // https://pip.pypa.io/en/stable/topics/configuration/#location
    if [
        "AppData/Roaming/pip/pip.ini",
        "Library/Application Support/pip/pip.conf",
        ".config/pip/pip.conf",
    ]
    .iter()
    .any(|candidate| app_name_matches(path, candidate))
    {
        let filename = if locations.platform == Platform::Windows {
            "pip.ini"
        } else {
            "pip.conf"
        };
        return mapped_or_original(
            path,
            locations,
            locations
                .app_root("pip")
                .map(|root| format!("{root}/{filename}")),
        );
    }
    // Only the documented portable Claude Desktop MCP file; not login/app state.
    // https://py.sdk.modelcontextprotocol.io/get-started/real-host/
    if [
        "AppData/Roaming/Claude/claude_desktop_config.json",
        "Library/Application Support/Claude/claude_desktop_config.json",
    ]
    .iter()
    .any(|candidate| app_name_matches(path, candidate))
    {
        if locations.platform == Platform::Linux {
            return Err("config_platform_path_unsupported".to_string());
        }
        return mapped_or_original(
            path,
            locations,
            locations
                .app_root("Claude")
                .map(|root| format!("{root}/claude_desktop_config.json")),
        );
    }
    if (locations.platform != Platform::Windows && under(path, "AppData").is_some())
        || (locations.platform != Platform::Mac && under(path, "Library").is_some())
    {
        return Err("config_platform_path_unsupported".to_string());
    }
    // AI instructions/skills and dotfiles already have portable HOME-relative paths.
    Ok(path.to_string())
}

pub(crate) fn validate_destinations(paths: &[String], platform: Platform) -> Result<(), String> {
    let mut seen = HashSet::new();
    for path in paths {
        validate_path(path, platform)?;
        if !seen.insert(super::restore_config_path_key(path)) {
            return Err("config_path_duplicate".to_string());
        }
    }
    // A file and a descendant of that file must be rejected before any writes.
    for path in &seen {
        for (offset, _) in path.match_indices('/') {
            if seen.contains(&path[..offset]) {
                return Err("config_path_duplicate".to_string());
            }
        }
    }
    Ok(())
}

pub(crate) fn home_paths(
    paths: &[String],
    locations: &HomeLocations,
) -> Result<Vec<String>, String> {
    let mapped = paths
        .iter()
        .map(|path| home_path(path, locations))
        .collect::<Result<Vec<_>, _>>()?;
    validate_destinations(&mapped, locations.platform).map_err(|error| {
        if error == "config_path_duplicate" {
            "config_platform_path_conflict".to_string()
        } else {
            error
        }
    })?;
    Ok(mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_roots_handle_windows_case_and_home_itself() {
        assert_eq!(
            relative_root_spelling(
                "C:\\Users\\Alice",
                "c:\\users\\ALICE\\AppData\\Roaming",
                Platform::Windows
            )
            .unwrap(),
            "AppData/Roaming"
        );
        assert_eq!(
            relative_root_spelling("/home/alice", "/home/alice", Platform::Linux).unwrap(),
            ""
        );
        assert!(
            relative_root_spelling("/home/alice", "/home/alice-other/config", Platform::Linux)
                .is_err()
        );
        assert!(
            relative_root_spelling("/home/alice", "/home/Alice/config", Platform::Linux).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn config_roots_resolve_home_alias_and_missing_suffix() {
        let root = std::env::temp_dir().join(format!(
            "koinote-root-alias-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&home, &alias).unwrap();
        assert_eq!(
            relative_config_root(&alias, &home.join("custom/config"), Platform::Linux).unwrap(),
            "custom/config"
        );
        assert_eq!(
            relative_config_root(&home, &alias.join("custom/config"), Platform::Linux).unwrap(),
            "custom/config"
        );
        assert!(relative_config_root(&alias, &root.join("outside"), Platform::Linux).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn locations(platform: Platform) -> HomeLocations {
        HomeLocations {
            platform,
            roaming: Ok("AppData/Roaming".into()),
            xdg: Ok(".config".into()),
        }
    }

    #[test]
    fn same_platform_restore_survives_external_config_root() {
        let mut target = locations(Platform::Linux);
        target.xdg = Err("config_platform_location_unsupported".into());
        assert_eq!(
            home_path(".config/Code/User/settings.json", &target).unwrap(),
            ".config/Code/User/settings.json"
        );
        assert!(home_path("AppData/Roaming/Code/User/settings.json", &target).is_err());
    }

    #[test]
    fn unix_app_names_remain_case_sensitive() {
        let mut target = locations(Platform::Linux);
        target.xdg = Ok("custom/config".into());
        assert_eq!(
            home_path(".config/Zed/settings.json", &target).unwrap(),
            ".config/Zed/settings.json"
        );
        assert_eq!(
            home_path(".config/zed/settings.json", &target).unwrap(),
            "custom/config/zed/settings.json"
        );
    }

    #[test]
    fn unix_snapshot_names_remain_restorable() {
        for platform in [Platform::Mac, Platform::Linux] {
            for path in [
                "config/host:8080.json",
                "config/line\nbreak.json",
                "config/CON.json",
            ] {
                assert!(validate_path(path, platform).is_ok(), "{path}");
                assert!(validate_path(path, Platform::Windows).is_err(), "{path}");
            }
        }
    }

    #[test]
    fn config_restore_cross_platform_known_locations() {
        // Every direction, evaluated independently of the OS running this test.
        for aliases in [
            [
                "AppData/Roaming/Code/User/settings.json",
                "Library/Application Support/Code/User/settings.json",
                ".config/Code/User/settings.json",
            ],
            [
                "AppData/Roaming/Code - Insiders/User/profiles/one/settings.json",
                "Library/Application Support/Code - Insiders/User/profiles/one/settings.json",
                ".config/Code - Insiders/User/profiles/one/settings.json",
            ],
            [
                "AppData/Roaming/Cursor/User/snippets/go.json",
                "Library/Application Support/Cursor/User/snippets/go.json",
                ".config/Cursor/User/snippets/go.json",
            ],
            [
                "AppData/Roaming/Windsurf/User/settings.json",
                "Library/Application Support/Windsurf/User/settings.json",
                ".config/Windsurf/User/settings.json",
            ],
            [
                "AppData/Roaming/Zed/settings.json",
                ".config/zed/settings.json",
                ".config/zed/settings.json",
            ],
            [
                "AppData/Roaming/pip/pip.ini",
                "Library/Application Support/pip/pip.conf",
                ".config/pip/pip.conf",
            ],
            [
                "AppData/Roaming/pypoetry/config.toml",
                "Library/Application Support/pypoetry/config.toml",
                ".config/pypoetry/config.toml",
            ],
        ] {
            for source in aliases {
                for (index, platform) in [Platform::Windows, Platform::Mac, Platform::Linux]
                    .into_iter()
                    .enumerate()
                {
                    assert_eq!(
                        home_path(source, &locations(platform)).unwrap(),
                        aliases[index]
                    );
                }
            }
        }
        assert_eq!(
            home_path(
                "AppData/Roaming/Claude/claude_desktop_config.json",
                &locations(Platform::Mac)
            )
            .unwrap(),
            "Library/Application Support/Claude/claude_desktop_config.json"
        );
        assert!(home_path(
            "AppData/Roaming/Claude/claude_desktop_config.json",
            &locations(Platform::Linux)
        )
        .is_err());
        assert_eq!(
            home_path(
                "appdata/roaming/code/user/settings.json",
                &locations(Platform::Mac)
            )
            .unwrap(),
            "Library/Application Support/Code/User/settings.json"
        );
    }

    #[test]
    fn config_restore_keeps_skills_and_home_relative_files() {
        for platform in [Platform::Windows, Platform::Mac, Platform::Linux] {
            for path in [
                ".claude/skills/cloudflare/SKILL.md",
                ".codex/skills/demo/scripts/run.sh",
                ".config/opencode/skills/demo/SKILL.md",
                ".agents/skills/中文/SKILL.md",
                ".dsh/.credentials.yaml",
                ".dsh/settings.yaml",
                ".dsh/profiles/web/cordis.patch.yml",
                ".dsh/skills/demo/SKILL.md",
                ".dsh/AGENTS.md",
                ".gitconfig",
                ".ssh/config",
            ] {
                assert_eq!(home_path(path, &locations(platform)).unwrap(), path);
            }
        }
    }

    #[test]
    fn config_restore_custom_destination_roots_and_unsupported_paths() {
        let mut target = locations(Platform::Windows);
        target.roaming = Ok("custom/roaming".into());
        assert_eq!(
            home_path(
                "Library/Application Support/Code/User/settings.json",
                &target
            )
            .unwrap(),
            "custom/roaming/Code/User/settings.json"
        );
        target.roaming = Err("config_platform_location_unsupported".into());
        assert_eq!(
            home_path(
                "Library/Application Support/Code/User/settings.json",
                &target
            ),
            Err("config_platform_location_unsupported".into())
        );
        assert!(home_path(".codex/skills/demo/SKILL.md", &target).is_ok());
        target = locations(Platform::Linux);
        target.xdg = Ok("custom/config".into());
        assert_eq!(
            home_path("AppData/Roaming/Code/User/settings.json", &target).unwrap(),
            "custom/config/Code/User/settings.json"
        );
        for path in [
            "AppData/Roaming/Unknown/config.json",
            "AppData/Local/tool/config.json",
        ] {
            assert_eq!(
                home_path(path, &locations(Platform::Mac)),
                Err("config_platform_path_unsupported".into())
            );
            assert_eq!(
                home_path(path, &locations(Platform::Windows)).unwrap(),
                path
            );
        }
    }

    #[test]
    fn config_restore_rejects_mapping_collisions_and_invalid_windows_names() {
        let collision = [
            "AppData/Roaming/Code/User/settings.json".into(),
            "Library/Application Support/Code/User/settings.json".into(),
        ];
        assert_eq!(
            home_paths(&collision, &locations(Platform::Mac)),
            Err("config_platform_path_conflict".into())
        );
        assert!(home_paths(
            &[
                ".codex/skills/demo".into(),
                ".codex/skills/demo/SKILL.md".into()
            ],
            &locations(Platform::Mac)
        )
        .is_err());
        for path in [
            "C:/secret",
            "../secret",
            "/tmp/secret",
            "skills/../secret",
            "skills/./secret",
            "skills//secret",
            "skills\\..\\secret",
            "AppData/Roaming/Code/User/../../secret",
        ] {
            for platform in [Platform::Windows, Platform::Mac, Platform::Linux] {
                assert!(home_path(path, &locations(platform)).is_err(), "{path}");
            }
        }
        for path in [
            "skills/CON.md",
            "skills/aux",
            "skills/COM1.txt",
            "skills/file.",
            "skills/file ",
            "skills/file?.md",
            "skills/a:b",
        ] {
            assert!(
                home_path(path, &locations(Platform::Windows)).is_err(),
                "{path}"
            );
        }
    }
}
