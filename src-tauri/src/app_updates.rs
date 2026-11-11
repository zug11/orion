//! Public releases use a native-only updater. The renderer never supplies an
//! endpoint, key, artifact URL or bytes, and installation starts only after the
//! shared all-window save handshake has succeeded.
use serde::Serialize;
use std::{
    io::Write,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tempfile::NamedTempFile;

const STATUS_EVENT: &str = "orion:update-status";
const RELEASE_ID: &str = "app.orion.knowledge";
const RELEASE_PATH: &str = "/zug11/orion/releases/download/";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    supported: bool,
    current_version: String,
    phase: UpdatePhase,
    version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
    installed: bool,
}

#[derive(Default)]
struct UpdateState {
    phase: UpdatePhase,
    update: Option<Update>,
    archive: Option<NamedTempFile>,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
    installation_started: bool,
    installed: bool,
}

impl UpdateState {
    fn claim_installation(&mut self) -> bool {
        if self.phase != UpdatePhase::Installing || self.installation_started || self.installed {
            return false;
        }
        self.installation_started = true;
        true
    }
}

#[derive(Default)]
pub struct AppUpdates(Mutex<UpdateState>);

fn release_supported(identifier: &str, debug: bool, supported_platform: bool) -> bool {
    identifier == RELEASE_ID && !debug && supported_platform
}

fn supported(app: &AppHandle) -> bool {
    release_supported(
        &app.config().identifier,
        cfg!(debug_assertions),
        cfg!(all(target_os = "macos", target_arch = "aarch64")),
    )
}

fn require_supported(app: &AppHandle) -> Result<(), String> {
    if supported(app) {
        Ok(())
    } else {
        Err("In-app updates are available in the installed Apple Silicon release of Orion.".into())
    }
}

fn status(app: &AppHandle, state: &UpdateState) -> UpdateStatus {
    UpdateStatus {
        supported: supported(app),
        current_version: app.package_info().version.to_string(),
        phase: state.phase,
        version: state.update.as_ref().map(|update| update.version.clone()),
        // Release notes remain ordinary bounded text in the renderer.
        notes: state.update.as_ref().and_then(|update| {
            update
                .body
                .as_ref()
                .map(|body| body.chars().take(16_000).collect())
        }),
        downloaded: state.downloaded,
        total: state.total,
        installed: state.installed,
        error: state
            .error
            .as_ref()
            .map(|error| error.chars().take(2_000).collect()),
    }
}

fn publish(app: &AppHandle, state: &UpdateState) -> UpdateStatus {
    let value = status(app, state);
    let _ = app.emit(STATUS_EVENT, &value);
    value
}

fn valid_release_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with(RELEASE_PATH)
        && url
            .path()
            .trim_start_matches(RELEASE_PATH)
            .split('/')
            .count()
            == 2
        && url.query().is_none()
        && url.fragment().is_none()
}

fn is_busy(phase: UpdatePhase) -> bool {
    matches!(
        phase,
        UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing
    )
}

#[tauri::command]
pub fn get_app_update_status(app: AppHandle) -> UpdateStatus {
    let state = app.state::<AppUpdates>();
    let state = state.0.lock().unwrap_or_else(|e| e.into_inner());
    status(&app, &state)
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<UpdateStatus, String> {
    require_supported(&app)?;
    {
        let managed = app.state::<AppUpdates>();
        let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
        if is_busy(state.phase) || state.archive.is_some() || state.installed {
            return Ok(status(&app, &state));
        }
        state.phase = UpdatePhase::Checking;
        state.error = None;
        state.update = None;
        state.downloaded = 0;
        state.total = None;
        publish(&app, &state);
    }
    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let mut update = updater.check().await.map_err(|e| e.to_string())?;
        if let Some(update) = update.as_mut() {
            if !valid_release_url(&update.download_url) {
                return Err(
                    "The update did not point to an official Orion GitHub release.".to_owned(),
                );
            }
            // Medium bundles are large; allow a bounded download on slower links.
            update.timeout = Some(Duration::from_secs(60 * 60));
        }
        Ok(update)
    }
    .await;
    let managed = app.state::<AppUpdates>();
    let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
    match result {
        Ok(update) => {
            state.phase = if update.is_some() {
                UpdatePhase::Available
            } else {
                UpdatePhase::Idle
            };
            state.update = update;
        }
        Err(error) => {
            state.phase = UpdatePhase::Error;
            state.error = Some(format!("Could not check for updates: {error}"));
        }
    }
    Ok(publish(&app, &state))
}

#[tauri::command]
pub async fn download_app_update(app: AppHandle) -> Result<UpdateStatus, String> {
    require_supported(&app)?;
    let update = {
        let managed = app.state::<AppUpdates>();
        let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
        if is_busy(state.phase) || state.archive.is_some() || state.installed {
            return Ok(status(&app, &state));
        }
        let update = state
            .update
            .clone()
            .ok_or("Check for an Orion update first.")?;
        state.phase = UpdatePhase::Downloading;
        state.error = None;
        state.downloaded = 0;
        state.total = None;
        publish(&app, &state);
        update
    };
    let mut last_event = Instant::now();
    let result = update
        .download(
            |chunk, total| {
                let managed = app.state::<AppUpdates>();
                let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
                state.downloaded = state.downloaded.saturating_add(chunk as u64);
                state.total = total;
                if last_event.elapsed() >= Duration::from_millis(150) {
                    publish(&app, &state);
                    last_event = Instant::now();
                }
            },
            || {},
        )
        .await;
    // Keep a verified Medium bundle on private temporary disk, rather than
    // holding gigabytes in the app's heap while the user postpones restarting.
    let result = match result {
        Ok(bytes) => tauri::async_runtime::spawn_blocking(move || {
            let size = bytes.len() as u64;
            let mut archive = NamedTempFile::new().map_err(|e| e.to_string())?;
            archive.write_all(&bytes).map_err(|e| e.to_string())?;
            archive.as_file().sync_all().map_err(|e| e.to_string())?;
            Ok::<_, String>((archive, size))
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result),
        Err(error) => Err(error.to_string()),
    };
    let managed = app.state::<AppUpdates>();
    let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
    match result {
        Ok((archive, size)) => {
            // Tauri has verified the mandatory signature before returning bytes.
            state.downloaded = size;
            state.archive = Some(archive);
            state.phase = UpdatePhase::Ready;
        }
        Err(error) => {
            state.phase = UpdatePhase::Error;
            state.error = Some(format!("Could not download the update: {error}"));
        }
    }
    Ok(publish(&app, &state))
}

#[tauri::command]
pub fn install_app_update(app: AppHandle) -> Result<UpdateStatus, String> {
    require_supported(&app)?;
    // Applications launched from a disk image or Gatekeeper's translocation
    // sandbox must first be installed normally; never try replacing that copy.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if exe.starts_with("/Volumes")
        || exe
            .components()
            .any(|part| part.as_os_str() == "AppTranslocation")
    {
        return Err(
            "Move Orion into Applications and open it there before installing an update.".into(),
        );
    }
    let installed = {
        let managed = app.state::<AppUpdates>();
        let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
        if is_busy(state.phase) {
            return Ok(status(&app, &state));
        }
        if (!state.installed && state.archive.is_none()) || state.update.is_none() {
            return Err("Download and verify the Orion update first.".into());
        }
        state.phase = UpdatePhase::Installing;
        state.installation_started = false;
        state.error = None;
        publish(&app, &state);
        state.installed
    };
    if let Err(error) = crate::desktop_windows::request_update_save(&app, installed) {
        save_cancelled(&app, &error);
    }
    Ok(get_app_update_status(app))
}

/// Called only by the native all-window save coordinator, never an IPC command.
pub fn install_after_save(app: &AppHandle) {
    let payload = {
        let managed = app.state::<AppUpdates>();
        let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(update) = state.update.clone() else {
            return;
        };
        if state.archive.is_none() || !state.claim_installation() {
            return;
        }
        let archive = state
            .archive
            .take()
            .expect("verified update was checked above");
        (update, archive)
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            // Updater >=2.14.1 re-verifies the signature and signed version of
            // these exact read-back bytes before any app replacement.
            let result = std::fs::read(payload.1.path())
                .map_err(|e| e.to_string())
                .and_then(|bytes| payload.0.install(&bytes).map_err(|e| e.to_string()));
            (result, payload.1)
        })
        .await;
        match result {
            Ok((Ok(()), _)) => {
                {
                    let managed = app.state::<AppUpdates>();
                    let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
                    state.installed = true;
                    state.installation_started = false;
                    publish(&app, &state);
                }
                crate::desktop_windows::save_after_update(&app);
            }
            failure => {
                let message = match failure {
                    Ok((Err(error), archive)) => {
                        let managed = app.state::<AppUpdates>();
                        managed.0.lock().unwrap_or_else(|e| e.into_inner()).archive = Some(archive);
                        format!("Could not install the update: {error}")
                    }
                    Err(error) => format!("Could not finish installing the update: {error}"),
                    _ => unreachable!(),
                };
                save_cancelled(&app, &message);
                crate::desktop_windows::cancel_update_save(&app);
            }
        }
    });
}

pub fn installation_in_progress(app: &AppHandle) -> bool {
    let managed = app.state::<AppUpdates>();
    let state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
    state.phase == UpdatePhase::Installing && state.installation_started
}

pub fn save_cancelled(app: &AppHandle, message: &str) {
    let managed = app.state::<AppUpdates>();
    let mut state = managed.0.lock().unwrap_or_else(|e| e.into_inner());
    if state.phase == UpdatePhase::Installing {
        state.phase = if state.archive.is_some() || state.installed {
            UpdatePhase::Ready
        } else {
            UpdatePhase::Error
        };
        state.installation_started = false;
        state.error = Some(if state.installed {
            format!("The update is installed, but Orion has not restarted. {message}")
        } else {
            message.to_owned()
        });
        publish(app, &state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_save_acknowledgements_can_start_only_one_install() {
        let mut state = UpdateState::default();
        assert!(!state.claim_installation());
        state.phase = UpdatePhase::Ready;
        assert!(!state.claim_installation());
        state.phase = UpdatePhase::Installing;
        assert!(state.claim_installation());
        assert!(!state.claim_installation());
        // A failed install returns to Ready; only a new explicit Install
        // command resets the gate and permits another attempt.
        state.phase = UpdatePhase::Ready;
        state.installation_started = false;
        assert!(!state.claim_installation());
        state.phase = UpdatePhase::Installing;
        assert!(state.claim_installation());
        state.installed = true;
        state.installation_started = false;
        assert!(
            !state.claim_installation(),
            "an installed update may only save and restart"
        );
    }

    #[test]
    fn updater_is_only_enabled_for_public_native_release() {
        assert!(release_supported(RELEASE_ID, false, true));
        assert!(!release_supported("app.orion.desktop-preview", false, true));
        assert!(!release_supported(RELEASE_ID, true, true));
        assert!(!release_supported(RELEASE_ID, false, false));
    }

    #[test]
    fn only_official_https_release_assets_are_accepted() {
        assert!(valid_release_url(
            &"https://github.com/zug11/orion/releases/download/v0.6.1/Orion.app.tar.gz"
                .parse()
                .unwrap()
        ));
        for url in [
            "http://github.com/zug11/orion/releases/download/v0.6.1/Orion.app.tar.gz",
            "https://github.com.evil.test/zug11/orion/releases/download/v0.6.1/Orion.app.tar.gz",
            "https://github.com/another/orion/releases/download/v0.6.1/Orion.app.tar.gz",
            "https://github.com/zug11/orion/releases/download/v0.6.1/asset?url=elsewhere",
            "https://attacker@github.com/zug11/orion/releases/download/v0.6.1/asset",
            "https://github.com:444/zug11/orion/releases/download/v0.6.1/asset",
        ] {
            assert!(!valid_release_url(&url.parse().unwrap()), "{url}");
        }
    }

    #[test]
    fn in_flight_actions_are_coalesced_across_windows() {
        assert!(is_busy(UpdatePhase::Checking));
        assert!(is_busy(UpdatePhase::Downloading));
        assert!(is_busy(UpdatePhase::Installing));
        assert!(!is_busy(UpdatePhase::Ready));
        assert!(!is_busy(UpdatePhase::Error));
    }
}
