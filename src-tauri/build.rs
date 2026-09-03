use std::env;

use serde_json::Value;

fn config_flavor(raw: &str) -> Option<&'static str> {
    if raw.trim().is_empty() {
        return None;
    }
    let config: Value = serde_json::from_str(raw)
        .unwrap_or_else(|error| panic!("TAURI_CONFIG must be inline JSON: {error}"));
    let product_name = config.get("productName").and_then(Value::as_str);
    let identifier = config.get("identifier").and_then(Value::as_str);
    let schemes = config
        .get("plugins")
        .and_then(|plugins| plugins.get("deep-link"))
        .and_then(|deep_link| deep_link.get("desktop"))
        .and_then(|desktop| desktop.get("schemes"))
        .and_then(Value::as_array);
    let local_product = product_name == Some("Koinote Local");
    let local_identifier = identifier == Some("app.koinote.desktop.local");
    let local_scheme = schemes.is_some_and(|items| {
        items
            .iter()
            .any(|item| item.as_str() == Some("koinote-local"))
    });
    let production_product = product_name == Some("Koinote");
    let production_identifier = identifier == Some("app.koinote.desktop");
    let production_scheme =
        schemes.is_some_and(|items| items.iter().any(|item| item.as_str() == Some("koinote")));
    let local_signals = [local_product, local_identifier, local_scheme]
        .into_iter()
        .filter(|signal| *signal)
        .count();
    let production_signals = [production_product, production_identifier, production_scheme]
        .into_iter()
        .filter(|signal| *signal)
        .count();
    if local_signals > 0 && production_signals > 0 {
        panic!("TAURI_CONFIG contains both local and production desktop flavor settings");
    }
    if local_signals > 0 {
        if local_signals != 3 {
            panic!("TAURI_CONFIG local flavor must set productName, identifier, and deep-link scheme consistently");
        }
        return Some("local");
    }
    if production_signals > 0 {
        if production_signals != 3 {
            panic!("TAURI_CONFIG production flavor must set productName, identifier, and deep-link scheme consistently");
        }
        return Some("production");
    }
    None
}

fn main() {
    println!("cargo:rerun-if-env-changed=KOINOTE_DESKTOP_FLAVOR");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rustc-check-cfg=cfg(koinote_local)");
    let configured_flavor = env::var("KOINOTE_DESKTOP_FLAVOR").unwrap_or_default();
    let tauri_config = env::var("TAURI_CONFIG").unwrap_or_default();
    let config_flavor = config_flavor(&tauri_config);
    if !configured_flavor.is_empty()
        && configured_flavor != "local"
        && configured_flavor != "production"
    {
        panic!("KOINOTE_DESKTOP_FLAVOR must be local or production");
    }
    if let Some(config_flavor) = config_flavor {
        if !configured_flavor.is_empty() && config_flavor != configured_flavor {
            panic!(
                "desktop flavor mismatch: Tauri config is {}, KOINOTE_DESKTOP_FLAVOR is {}",
                config_flavor, configured_flavor,
            );
        }
    }
    let flavor_is_local = configured_flavor == "local" || config_flavor == Some("local");
    if flavor_is_local {
        println!("cargo:rustc-cfg=koinote_local");
    }
    tauri_build::build()
}
