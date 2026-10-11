//! Native entry points for opening Orion's bundled Claude and Codex connectors.

use reqwest::Url;
use serde_json::Value;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const BUNDLED_CLAUDE_CONNECTOR_NAME: &str = "Orion-Claude-Connector.mcpb";
const BUNDLED_CODEX_PLUGIN_DIRECTORY: &str = "Orion-Codex-Plugin";
const BUNDLED_CODEX_MARKETPLACE_PATH: &[&str] = &[".agents", "plugins", "marketplace.json"];
const BUNDLED_CODEX_SERVER_PATH: &[&str] = &["plugins", "orion", "server", "orion-mcp"];

#[tauri::command]
pub(super) async fn open_claude_connector(app: AppHandle) -> Result<String, String> {
    let connector = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Orion could not locate its bundled resources: {error}"))?
        .join(BUNDLED_CLAUDE_CONNECTOR_NAME);
    let metadata = fs::metadata(&connector)
        .map_err(|_| "Orion's Claude connector is missing. Reinstall Orion.".to_string())?;
    if !metadata.is_file() || metadata.len() < 1_024 {
        return Err("Orion's Claude connector is incomplete. Reinstall Orion.".to_string());
    }
    let display_path = connector.to_string_lossy().into_owned();
    app.opener()
        .open_path(display_path.clone(), None::<String>)
        .map_err(|error| format!("Orion could not open its Claude connector: {error}"))?;
    Ok(display_path)
}

fn validate_bundled_codex_plugin(resource_directory: &Path) -> Result<PathBuf, String> {
    if !resource_directory.is_absolute() {
        return Err("Orion received an invalid bundled resource path.".to_string());
    }

    let plugin_directory = resource_directory.join(BUNDLED_CODEX_PLUGIN_DIRECTORY);
    let canonical_plugin_directory = fs::canonicalize(&plugin_directory)
        .map_err(|_| "Orion's Codex plugin is missing. Reinstall Orion.".to_string())?;
    let marketplace =
        plugin_directory.join(BUNDLED_CODEX_MARKETPLACE_PATH.iter().collect::<PathBuf>());
    let server = plugin_directory.join(BUNDLED_CODEX_SERVER_PATH.iter().collect::<PathBuf>());
    let canonical_marketplace = fs::canonicalize(&marketplace)
        .map_err(|_| "Orion's Codex plugin catalog is missing. Reinstall Orion.".to_string())?;
    let canonical_server = fs::canonicalize(&server)
        .map_err(|_| "Orion's Codex connector is missing. Reinstall Orion.".to_string())?;

    if !canonical_marketplace.starts_with(&canonical_plugin_directory)
        || !canonical_server.starts_with(&canonical_plugin_directory)
    {
        return Err("Orion's Codex plugin contains an invalid bundled path.".to_string());
    }

    let marketplace_metadata = fs::metadata(&canonical_marketplace)
        .map_err(|_| "Orion's Codex plugin catalog is missing. Reinstall Orion.".to_string())?;
    if !marketplace_metadata.is_file() || marketplace_metadata.len() == 0 {
        return Err("Orion's Codex plugin catalog is incomplete. Reinstall Orion.".to_string());
    }

    let marketplace_json: Value =
        serde_json::from_reader(File::open(&canonical_marketplace).map_err(|_| {
            "Orion could not read its bundled Codex plugin catalog. Reinstall Orion.".to_string()
        })?)
        .map_err(|_| "Orion's Codex plugin catalog is invalid. Reinstall Orion.".to_string())?;
    let has_orion_entry = marketplace_json
        .get("plugins")
        .and_then(Value::as_array)
        .is_some_and(|plugins| {
            plugins.iter().any(|plugin| {
                plugin.get("name").and_then(Value::as_str) == Some("orion")
                    && plugin.pointer("/source/path").and_then(Value::as_str)
                        == Some("./plugins/orion")
            })
        });
    if !has_orion_entry {
        return Err("Orion's Codex plugin catalog is invalid. Reinstall Orion.".to_string());
    }

    let server_metadata = fs::metadata(&canonical_server)
        .map_err(|_| "Orion's Codex connector is missing. Reinstall Orion.".to_string())?;
    if !server_metadata.is_file() || server_metadata.len() < 1_024 {
        return Err("Orion's Codex connector is incomplete. Reinstall Orion.".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if server_metadata.permissions().mode() & 0o111 == 0 {
            return Err("Orion's Codex connector cannot run. Reinstall Orion.".to_string());
        }
    }

    Ok(canonical_marketplace)
}

fn codex_plugin_url(marketplace: &Path) -> Result<Url, String> {
    if !marketplace.is_absolute() {
        return Err("Orion received an invalid Codex plugin path.".to_string());
    }
    let marketplace = marketplace
        .to_str()
        .ok_or_else(|| "Orion could not encode its Codex plugin path.".to_string())?;
    let mut url = Url::parse("codex://plugins/orion")
        .map_err(|_| "Orion could not create its Codex install link.".to_string())?;
    url.query_pairs_mut()
        .append_pair("marketplacePath", marketplace);
    Ok(url)
}

#[tauri::command]
pub(super) async fn open_codex_plugin(app: AppHandle) -> Result<String, String> {
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Orion could not locate its bundled resources: {error}"))?;
    let marketplace = validate_bundled_codex_plugin(&resource_directory)?;
    let install_url = codex_plugin_url(&marketplace)?.to_string();
    app.opener()
        .open_url(install_url.clone(), None::<String>)
        .map_err(|error| {
            format!("Orion could not open its Codex plugin: {error}. Make sure Codex is installed.")
        })?;
    Ok(install_url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    fn create_codex_plugin_fixture(directory: &TempDir) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let plugin_directory = directory.path().join(BUNDLED_CODEX_PLUGIN_DIRECTORY);
        let marketplace =
            plugin_directory.join(BUNDLED_CODEX_MARKETPLACE_PATH.iter().collect::<PathBuf>());
        let server = plugin_directory.join(BUNDLED_CODEX_SERVER_PATH.iter().collect::<PathBuf>());
        fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
        fs::create_dir_all(server.parent().unwrap()).unwrap();
        fs::write(
            &marketplace,
            br#"{
              "name": "orion-bundled",
              "plugins": [{
                "name": "orion",
                "source": { "source": "local", "path": "./plugins/orion" }
              }]
            }"#,
        )
        .unwrap();
        File::create(&server).unwrap().set_len(1_024).unwrap();
        let mut permissions = fs::metadata(&server).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&server, permissions).unwrap();
        marketplace
    }

    #[test]
    fn codex_plugin_url_encodes_and_recovers_the_absolute_marketplace_path() {
        let marketplace =
            Path::new("/Applications/Orion Atlas #1/.agents/plugins/marketplace.json");
        let url = codex_plugin_url(marketplace).unwrap();

        assert_eq!(url.scheme(), "codex");
        assert_eq!(url.host_str(), Some("plugins"));
        assert_eq!(url.path(), "/orion");
        assert_eq!(
            url.query_pairs()
                .find(|(name, _)| name == "marketplacePath")
                .map(|(_, value)| value.into_owned()),
            Some(marketplace.to_string_lossy().into_owned())
        );
        assert!(url.as_str().contains("Orion+Atlas+%231"));
        assert!(codex_plugin_url(Path::new("relative/marketplace.json")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn validates_the_expected_bundled_codex_plugin_layout() {
        let directory = tempfile::tempdir().unwrap();
        let marketplace = create_codex_plugin_fixture(&directory);

        assert_eq!(
            validate_bundled_codex_plugin(directory.path()).unwrap(),
            fs::canonicalize(marketplace).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_invalid_or_non_executable_codex_plugin_bundle() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let marketplace = create_codex_plugin_fixture(&directory);
        fs::write(&marketplace, br#"{"plugins": []}"#).unwrap();
        assert!(validate_bundled_codex_plugin(directory.path())
            .unwrap_err()
            .contains("catalog is invalid"));

        create_codex_plugin_fixture(&directory);
        let server = directory
            .path()
            .join(BUNDLED_CODEX_PLUGIN_DIRECTORY)
            .join(BUNDLED_CODEX_SERVER_PATH.iter().collect::<PathBuf>());
        let mut permissions = fs::metadata(&server).unwrap().permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(server, permissions).unwrap();
        assert!(validate_bundled_codex_plugin(directory.path())
            .unwrap_err()
            .contains("cannot run"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_codex_plugin_file_that_escapes_its_bundled_directory() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let marketplace = create_codex_plugin_fixture(&directory);
        let external_catalog = directory.path().join("outside-marketplace.json");
        fs::write(
            &external_catalog,
            br#"{
              "plugins": [{
                "name": "orion",
                "source": { "source": "local", "path": "./plugins/orion" }
              }]
            }"#,
        )
        .unwrap();
        fs::remove_file(&marketplace).unwrap();
        symlink(external_catalog, marketplace).unwrap();

        assert!(validate_bundled_codex_plugin(directory.path())
            .unwrap_err()
            .contains("invalid bundled path"));
    }
}
